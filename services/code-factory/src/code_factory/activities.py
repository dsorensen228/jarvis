from __future__ import annotations

import asyncio
import json
import os
import signal
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from temporalio import activity

from .config import Settings
from .git_changes import affects_code_factory, changed_paths, revision
from .models import TaskRecord, TaskRunRequest, TaskStatus
from .repository import TaskRepository

MAX_CAPTURE_BYTES = 2 * 1024 * 1024
PERSIST_HEARTBEAT_SECONDS = 5
MAX_FAILURE_DETAIL_CHARS = 16_000
USAGE_LIMIT_FALLBACK_MODEL = "composer-2.5"
WORKSPACE_REPOSITORIES = ("jarvis", "sherman")


def workspace_prompt(task_id: str, prompt: str) -> str:
    return (
        f"Code Factory task {task_id}. Work in the Jarvis workspace. "
        "Modify jarvis and/or sherman as the prompt requires; do not ask the user "
        "to choose a repository.\n\n"
        f"{prompt}"
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

    @staticmethod
    def command(agent_path: Path, prompt: str, model: str | None = None) -> tuple[str, ...]:
        return (
            str(agent_path),
            "-p",
            "--force",
            "--trust",
            "--approve-mcps",
            "--model",
            model or "auto",
            prompt,
            "--output-format",
            "stream-json",
            "--stream-partial-output",
        )

    @activity.defn(name="run_coding_task")
    async def run_coding_task(self, request: TaskRunRequest) -> None:
        task = await self._set_status(request.task_id, TaskStatus.RUNNING)
        if task.status is not TaskStatus.RUNNING:
            return
        try:
            before = await _workspace_revisions(self._settings)
        except Exception as exc:
            await self._set_status(
                request.task_id,
                TaskStatus.FAILED,
                error=f"could not inspect workspace repositories: {type(exc).__name__}: {exc}",
            )
            raise

        command = self.command(
            self._settings.agent_path,
            workspace_prompt(request.task_id, request.prompt),
            model=request.model,
        )
        environment = os.environ.copy()
        environment.setdefault("AGENT_CLI_CREDENTIAL_STORE", "file")

        try:
            result = await _execute_agent(
                command,
                self._settings.workspace,
                environment,
                timeout_seconds=self._settings.agent_timeout_seconds,
                idle_timeout_seconds=self._settings.agent_idle_timeout_seconds,
            )
            fallback_model = (
                _usage_limit_fallback_model(request.model, result.stderr)
                if result.exit_code != 0
                else None
            )
            if fallback_model:
                initial = result
                fallback_command = self.command(
                    self._settings.agent_path,
                    workspace_prompt(request.task_id, request.prompt),
                    model=fallback_model,
                )
                result = await _execute_agent(
                    fallback_command,
                    self._settings.workspace,
                    environment,
                    timeout_seconds=self._settings.agent_timeout_seconds,
                    idle_timeout_seconds=self._settings.agent_idle_timeout_seconds,
                )
                result = AgentProcessResult(
                    exit_code=result.exit_code,
                    stdout=result.stdout,
                    agent_output=result.agent_output,
                    stderr=_fallback_attempt_log(
                        request.model,
                        initial,
                        fallback_model,
                        result,
                    ),
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
            paths = await _labeled_changed_paths(self._settings, before)
            should_update = affects_code_factory(paths)
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
    # Cursor shell tools can create their own sessions. Include those descendants,
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
        with suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    # Process.wait() can itself block on inherited stdout/stderr pipes after exit.
    for _ in range(100):
        if process.returncode is not None:
            break
        await asyncio.sleep(0.05)
    for pid in reversed(descendants):
        with suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)


class _AgentOutput:
    def __init__(self) -> None:
        self.last_output = asyncio.get_running_loop().time()
        self.result: dict[str, Any] | None = None
        self.result_at: float | None = None
        self.stdout = bytearray()
        self.stderr = bytearray()

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
        if isinstance(event, dict) and event.get("type") == "result":
            self.result = event
            if self.result_at is None:
                self.result_at = asyncio.get_running_loop().time()


async def _execute_agent(
    command: tuple[str, ...],
    workspace: Path,
    environment: dict[str, str],
    *,
    timeout_seconds: float = 7200,
    idle_timeout_seconds: float = 900,
    shutdown_timeout_seconds: float = 10,
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
    try:
        while True:
            now = asyncio.get_running_loop().time()
            for task in capture_tasks:
                if task.done():
                    task.result()
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

    stdout = output.stdout.decode(errors="replace")
    stderr = output.stderr.decode(errors="replace")
    if failure or shutdown_warning:
        stderr += f"\n[code-factory: {failure or shutdown_warning}]\n"
    if failure:
        exit_code = 124
    elif output.result is not None:
        # A final structured result survives a hung CLI shutdown. An explicit error
        # is failure even if the CLI exits zero.
        is_error = (
            output.result.get("is_error") is True or output.result.get("subtype") != "success"
        )
        exit_code = 1 if is_error else (process.returncode or 0)
        if shutdown_warning and not is_error:
            exit_code = 0
    else:
        exit_code = process.returncode if process.returncode is not None else 1
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


def _usage_limit_fallback_model(requested_model: str | None, stderr: str) -> str | None:
    lowered = stderr.lower()
    if requested_model == USAGE_LIMIT_FALLBACK_MODEL:
        return None
    if "actionrequirederror" in lowered and "usage limit" in lowered:
        return USAGE_LIMIT_FALLBACK_MODEL
    return None


def _fallback_attempt_log(
    requested_model: str | None,
    initial: AgentProcessResult,
    fallback_model: str,
    fallback: AgentProcessResult,
) -> str:
    first_model = requested_model or "auto"
    parts = [f"[code-factory: {first_model} hit its usage limit; retried with {fallback_model}]"]
    if initial.stderr.strip():
        parts.append(initial.stderr.strip())
    elif initial.stdout.strip():
        parts.append(initial.stdout.strip())
    if fallback.stderr.strip():
        parts.append(f"[{fallback_model} stderr]\n{fallback.stderr.strip()}")
    return "\n\n".join(parts)


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
