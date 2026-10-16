from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from temporalio import activity

from .config import Settings
from .git_changes import affects_code_factory, changed_paths, revision
from .models import AGENT_MODELS, TERMINAL_STATUSES, TaskRecord, TaskRunRequest, TaskStatus
from .repository import TaskRepository
from .research import prepare_workspace, read_report, research_prompt, write_previous_report

MAX_CAPTURE_BYTES = 2 * 1024 * 1024
PERSIST_HEARTBEAT_SECONDS = 5
MAX_FAILURE_DETAIL_CHARS = 16_000
PROMPTS_DIR = Path(__file__).parent / "prompts"
WORKSPACE_REPOSITORIES = ("jarvis", "sherman")
logger = logging.getLogger(__name__)
ProgressCallback = Callable[[list[dict[str, str]]], Awaitable[None]]


def workspace_prompt(task_id: str, prompt: str) -> str:
    return (
        f"Code Factory task {task_id}.\n\n"
        f"{(PROMPTS_DIR / 'unattended.md').read_text().strip()}\n\n"
        f"Task request:\n{prompt}"
    )


@dataclass(frozen=True, slots=True)
class AgentProcessResult:
    exit_code: int
    stdout: str
    stderr: str
    agent_output: Any = None


class AgentActivities:
    def __init__(self, settings: Settings, repository: TaskRepository) -> None:
        self._settings = settings
        self._repository = repository

    @activity.defn(name="parent_task_finished")
    async def parent_task_finished(self, task_id: str) -> bool:
        task = await self._repository.get(task_id)
        return task.status in TERMINAL_STATUSES

    @staticmethod
    def command(agent_path: Path, prompt: str, model: str | None) -> tuple[str, ...]:
        if model not in AGENT_MODELS:
            raise ValueError("a supported Codex model is required")
        return (
            str(agent_path),
            "exec",
            "--profile",
            "code-factory",
            "--sandbox",
            "danger-full-access",
            "-c",
            'approval_policy="never"',
            "-c",
            'forced_login_method="chatgpt"',
            "-c",
            'cli_auth_credentials_store="file"',
            "-c",
            'mcp_oauth_credentials_store="file"',
            "-c",
            'model_reasoning_effort="medium"',
            "--skip-git-repo-check",
            "--model",
            model,
            "--json",
            "--color",
            "never",
            "--output-schema",
            str(PROMPTS_DIR / "result.schema.json"),
            "--",
            prompt,
        )

    @activity.defn(name="run_coding_task")
    async def run_coding_task(self, request: TaskRunRequest) -> None:
        task = await self._set_status(request.task_id, TaskStatus.RUNNING)
        if task.status is not TaskStatus.RUNNING:
            return
        is_research = request.task_type == "research"
        try:
            before = {} if is_research else await _workspace_revisions(self._settings)
            workspace = (
                prepare_workspace(self._settings, request.task_id)
                if is_research
                else self._settings.workspace
            )
        except Exception as exc:
            await self._set_status(
                request.task_id,
                TaskStatus.FAILED,
                error=f"could not prepare task workspace: {type(exc).__name__}: {exc}",
            )
            raise

        try:
            prompt = request.prompt
            if request.parent_task_id:
                parent = await self._repository.get(request.parent_task_id)
                if getattr(parent, "task_type", "code") != request.task_type:
                    raise ValueError("follow-up task type must match its parent")
                # Continue with explicit, bounded context. This is a new queued job;
                # exec's closed stdin does not support injecting into a running turn.
                report = parent.agent_output
                outcome = report.get("result", "") if isinstance(report, dict) else ""
                outcome = outcome or parent.error or "No completion report has been saved yet."
                prompt = (
                    f"Follow-up to Code Factory task {parent.id}.\n"
                    f"Previous request:\n{parent.prompt[:16_000]}\n\n"
                    f"Previous task status: {parent.status.value}\n"
                    f"Latest saved result:\n{str(outcome)[-16_000:]}\n\n"
                    f"New instructions:\n{request.prompt}"
                )
                if is_research and parent.report_available and parent.status is TaskStatus.SUCCESS:
                    previous = await self._repository.get_report(parent.id)
                    write_previous_report(workspace, previous["html"])
                    prompt = (
                        "The previous report is saved as previous-report.html in this task's "
                        "directory. Read it as source context, verify/update its claims as needed, "
                        "and produce a complete new report.html.\n\n" + prompt
                    )
            command = self.command(
                self._settings.agent_path,
                research_prompt(request.task_id, prompt, request.verbosity)
                if is_research
                else workspace_prompt(request.task_id, prompt),
                model=request.model,
            )
            environment = os.environ.copy()
            # This service uses the code host's ChatGPT subscription, never an API key override.
            environment.pop("CODEX_API_KEY", None)
            environment.pop("OPENAI_API_KEY", None)
            result = await _execute_agent(
                command,
                workspace,
                environment,
                timeout_seconds=self._settings.agent_timeout_seconds,
                idle_timeout_seconds=self._settings.agent_idle_timeout_seconds,
                on_progress=lambda events: self._repository.append_output(request.task_id, events),
            )
        except asyncio.CancelledError:
            await self._set_status(request.task_id, TaskStatus.CANCELLED)
            raise
        except Exception as exc:
            await self._set_status(
                request.task_id,
                TaskStatus.FAILED,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise

        exit_code = result.exit_code
        stdout = result.stdout
        stderr = result.stderr
        agent_output = result.agent_output or _parse_agent_output(stdout)
        if exit_code != 0:
            await self._set_status(
                request.task_id,
                TaskStatus.FAILED,
                exit_code=exit_code,
                agent_output=agent_output,
                stdout=stdout,
                stderr=stderr,
                error=_agent_failure_message(exit_code, stdout, stderr),
            )
            return

        try:
            report_html = read_report(workspace) if is_research else None
            paths = [] if is_research else await _labeled_changed_paths(self._settings, before)
            should_update = not is_research and affects_code_factory(paths)
            if should_update:
                _schedule_self_update(self._settings.updater_path, request.task_id)
        except Exception as exc:
            await self._set_status(
                request.task_id,
                TaskStatus.FAILED,
                exit_code=exit_code,
                agent_output=agent_output,
                stdout=stdout,
                stderr=stderr,
                error=f"post-run reconciliation failed: {type(exc).__name__}: {exc}",
            )
            raise
        await self._set_status(
            request.task_id,
            TaskStatus.SUCCESS,
            exit_code=exit_code,
            agent_output=agent_output,
            stdout=stdout,
            stderr=stderr,
            changed_paths=paths,
            self_update_scheduled=should_update,
            report_available=report_html is not None,
            report_html=report_html,
        )

    async def _set_status(self, task_id: str, status: TaskStatus, **fields: Any) -> TaskRecord:
        # Uploading a captured transcript can outlast Temporal's heartbeat deadline.
        # Continue heartbeating after the agent exits until its result is persisted.
        pending = asyncio.create_task(self._repository.set_status(task_id, status, **fields))
        try:
            while not pending.done():
                activity.heartbeat({"task_id": task_id, "phase": "saving", "status": status.value})
                await asyncio.wait({pending}, timeout=PERSIST_HEARTBEAT_SECONDS)
            return await pending
        finally:
            if not pending.done():
                pending.cancel()
                with suppress(asyncio.CancelledError):
                    await pending


async def _terminate_process_group(process: asyncio.subprocess.Process) -> None:
    # Codex shell tools can create their own sessions. Include those descendants,
    # not just the agent's original process group, before the parent disappears.
    descendants: list[int] = []
    inspector = await asyncio.create_subprocess_exec(
        "/bin/ps",
        "-axo",
        "pid=,ppid=",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        output, _ = await asyncio.wait_for(inspector.communicate(), timeout=2)
        parents = {
            int(pid): int(parent)
            for pid, parent in (line.split() for line in output.decode().splitlines())
        }
        frontier = [process.pid]
        while frontier:
            frontier = [pid for pid, parent in parents.items() if parent in frontier]
            descendants.extend(frontier)
    except TimeoutError:
        inspector.kill()
        await inspector.wait()

    for pid in reversed(descendants):
        with suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGTERM)

    def signal_group(sig: signal.Signals) -> None:
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS can retain an exited group's reparented children briefly.
            # Do not lose a saved result to cleanup of a group we no longer own.
            if process.returncode is None:
                raise

    signal_group(signal.SIGTERM)
    # Process.wait() can itself block on inherited stdout/stderr pipes after exit.
    for _ in range(100):
        if process.returncode is not None:
            break
        await asyncio.sleep(0.05)
    for pid in reversed(descendants):
        with suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGKILL)
    signal_group(signal.SIGKILL)


class _AgentOutput:
    def __init__(self) -> None:
        self.last_output = asyncio.get_running_loop().time()
        self.result: dict[str, Any] | None = None
        self.result_at: float | None = None
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.pending_events: list[dict[str, str]] = []

    def progress(self, kind: str, text: str) -> None:
        if text.strip():
            self.pending_events.append({"kind": kind, "text": text[-2_000:]})
            # Process pipes must keep draining even during a storage outage.
            del self.pending_events[:-300]

    async def capture(self, stream: asyncio.StreamReader | None, *, stdout: bool) -> None:
        if stream is None:
            return
        captured = self.stdout if stdout else self.stderr
        pending = bytearray()
        while chunk := await stream.read(64 * 1024):
            self.last_output = asyncio.get_running_loop().time()
            captured.extend(chunk)
            # Keep recent diagnostics without exceeding MongoDB's document limit.
            if len(captured) > MAX_CAPTURE_BYTES:
                del captured[:-MAX_CAPTURE_BYTES]
            if stdout:
                pending.extend(chunk)
                while b"\n" in pending:
                    line, _, pending = pending.partition(b"\n")
                    self.parse_result(line)
                if len(pending) > MAX_CAPTURE_BYTES:
                    pending.clear()
        if stdout and pending:
            self.parse_result(pending)

    def parse_result(self, line: bytes) -> None:
        try:
            event = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(event, dict):
            return
        kind = event.get("type")
        item = event.get("item", {})
        if not isinstance(item, dict):
            item = {}
        item_kind = item.get("type")
        if kind == "thread.started":
            self.progress("status", "Agent connected")
        elif kind == "turn.started":
            self.progress("status", "Working on your request")
        elif kind == "item.started" and item_kind == "command_execution":
            self.progress("command", str(item.get("command", "Running command")))
        elif kind == "item.completed" and item_kind == "command_execution":
            code = item.get("exit_code")
            text = str(item.get("aggregated_output", "")).strip()
            label = f"Command completed (exit {code})" if code is not None else "Command completed"
            self.progress("tool" if code in {0, None} else "error", f"{label}\n{text}")
        elif kind == "item.completed" and item_kind == "file_change":
            changes = item.get("changes", [])
            if isinstance(changes, list):
                paths = [
                    str(change.get("path", "")) for change in changes if isinstance(change, dict)
                ]
                self.progress("tool", "Files changed: " + ", ".join(paths))
        elif kind == "item.completed" and item_kind in {"mcp_tool_call", "web_search"}:
            self.progress("tool", f"Completed {item_kind.replace('_', ' ')}")
        elif kind in {"error", "turn.failed"}:
            error = event.get("error", event)
            text = (
                error.get("message", "Agent reported an error")
                if isinstance(error, dict)
                else str(error)
            )
            self.progress("error", str(text))
        # Deliberately ignore reasoning items, raw protocol events and tool inputs.
        if kind == "item.completed":
            if isinstance(item, dict) and item.get("type") == "agent_message":
                try:
                    report = json.loads(item.get("text", ""))
                except (ValueError, TypeError):
                    report = None
                if (
                    isinstance(report, dict)
                    and report.get("status") in {"success", "failed"}
                    and isinstance(report.get("result"), str)
                    and report["result"].strip()
                ):
                    self.result = {**report, "is_error": report["status"] == "failed"}
                    self.progress("assistant", report["result"])
                else:
                    # Do not let an earlier valid report hide a malformed final response.
                    self.result = None
                    self.progress("assistant", str(item.get("text", "")))
        elif kind in {"turn.completed", "turn.failed"}:
            if kind == "turn.failed":
                error = event.get("error", {})
                message = error.get("message") if isinstance(error, dict) else str(error)
                self.result = {"result": message or "Codex turn failed", "is_error": True}
            elif self.result is None:
                self.result = {
                    "result": "Codex finished without a valid task completion report",
                    "is_error": True,
                }
            self.result_at = asyncio.get_running_loop().time()


async def _execute_agent(
    command: tuple[str, ...],
    workspace: Path,
    environment: dict[str, str],
    *,
    timeout_seconds: float = 7200,
    idle_timeout_seconds: float = 900,
    shutdown_timeout_seconds: float = 10,
    on_progress: ProgressCallback | None = None,
) -> AgentProcessResult:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=workspace,
        env=environment,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    output = _AgentOutput()
    capture_tasks = [
        asyncio.create_task(output.capture(process.stdout, stdout=True)),
        asyncio.create_task(output.capture(process.stderr, stdout=False)),
    ]
    started = asyncio.get_running_loop().time()
    exited_at = None
    failure = None
    shutdown_warning = None
    publishing: asyncio.Task[None] | None = None

    async def publish(events: list[dict[str, str]]) -> None:
        if on_progress is None:
            return
        try:
            await on_progress(events)
        except Exception as exc:
            # Loss of a progress update must never terminate the user's actual work.
            logger.warning("Could not save agent progress (%s)", type(exc).__name__)
            output.pending_events[:0] = events
            del output.pending_events[:-300]

    try:
        while True:
            now = asyncio.get_running_loop().time()
            for task in capture_tasks:
                if task.done():
                    task.result()
            if (
                on_progress is not None
                and output.pending_events
                and (publishing is None or publishing.done())
            ):
                events, output.pending_events = output.pending_events, []
                publishing = asyncio.create_task(publish(events))
            if process.returncode is not None:
                if all(task.done() for task in capture_tasks):
                    break
                exited_at = exited_at or now
            if output.result_at is not None and now - output.result_at >= shutdown_timeout_seconds:
                shutdown_warning = "agent shutdown exceeded grace period after final result"
                break
            if exited_at is not None and now - exited_at >= shutdown_timeout_seconds:
                shutdown_warning = "agent shutdown left output pipes open in child processes"
                break
            if output.result_at is None and now - started >= timeout_seconds:
                failure = f"agent exceeded runtime limit of {timeout_seconds:g} seconds"
                break
            if output.result_at is None and now - output.last_output >= idle_timeout_seconds:
                failure = f"agent produced no output for {idle_timeout_seconds:g} seconds"
                break
            activity.heartbeat(
                {"pid": process.pid, "idle_seconds": round(now - output.last_output)}
            )
            await asyncio.sleep(min(1, idle_timeout_seconds / 2, shutdown_timeout_seconds / 2))
    finally:
        await _terminate_process_group(process)
        with suppress(TimeoutError):
            await asyncio.wait_for(asyncio.gather(*capture_tasks), timeout=2)
        if publishing is not None:
            with suppress(TimeoutError):
                await asyncio.wait_for(publishing, timeout=5)
        if output.pending_events and on_progress is not None:
            events, output.pending_events = output.pending_events, []
            with suppress(TimeoutError):
                await asyncio.wait_for(publish(events), timeout=5)

    stdout = output.stdout.decode(errors="replace")
    stderr = output.stderr.decode(errors="replace")
    if failure or shutdown_warning:
        stderr += f"\n[code-factory: {failure or shutdown_warning}]\n"
    if failure:
        exit_code = 124
    elif output.result_at is not None and output.result is not None:
        # A completed Codex turn survives a hung CLI shutdown. A model-reported
        # blocker remains a failed task even if the CLI exits zero.
        is_error = output.result.get("is_error") is True
        exit_code = 1 if is_error else (process.returncode or 0)
        if shutdown_warning and not is_error:
            exit_code = 0
    else:
        exit_code = process.returncode or 1
        stderr += "\n[code-factory: Codex exited without a completed turn]\n"
    if exit_code and output.result and output.result.get("result"):
        stderr += f"\n{output.result['result']}\n"
    return AgentProcessResult(exit_code, stdout, stderr, output.result)


async def _workspace_revisions(settings: Settings) -> dict[str, str]:
    snapshots: dict[str, str] = {}
    errors: list[str] = []
    for name in WORKSPACE_REPOSITORIES:
        try:
            snapshots[name] = await revision(settings.repository_path(name))
        except Exception as exc:
            errors.append(f"{name}: {type(exc).__name__}: {exc}")
    if "jarvis" not in snapshots:
        raise RuntimeError("; ".join(errors) or "jarvis repository is unavailable")
    return snapshots


async def _labeled_changed_paths(settings: Settings, before: dict[str, str]) -> list[str]:
    paths: list[str] = []
    for name, revision_before in before.items():
        try:
            repository = settings.repository_path(name)
            after = await revision(repository)
            for path in await changed_paths(repository, revision_before, after):
                paths.append(f"{name}/{path}")
        except Exception:
            continue
    return paths


def _parse_agent_output(stdout: str) -> Any:
    stripped = stdout.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        parsed_lines: list[Any] = []
        for line in stripped.splitlines():
            try:
                parsed_lines.append(json.loads(line))
            except json.JSONDecodeError:
                return None
        return parsed_lines


def _agent_failure_message(exit_code: int, stdout: str, stderr: str) -> str:
    summary = f"agent exited with status {exit_code}"
    detail = stderr.strip() or stdout.strip()
    if not detail:
        return summary
    if len(detail) > MAX_FAILURE_DETAIL_CHARS:
        omitted = len(detail) - MAX_FAILURE_DETAIL_CHARS
        detail = f"[{omitted} earlier characters omitted]\n{detail[-MAX_FAILURE_DETAIL_CHARS:]}"
    return f"{summary}\n\n{detail}"


def _schedule_self_update(updater_path: Path, task_id: str) -> None:
    import subprocess

    log_path = updater_path.parent / "self-update-launch.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log:
        # The updater sleeps before touching the service, giving this activity time to finish.
        subprocess.Popen(
            [str(updater_path), task_id],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
            close_fds=True,
        )
