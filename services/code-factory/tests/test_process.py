import asyncio
import contextlib
import json
import os
import signal
import sys
from pathlib import Path

import pytest
from temporalio.testing import ActivityEnvironment

from code_factory.activities import _execute_agent


async def execute(script: str, tmp_path: Path, **kwargs):
    return await ActivityEnvironment().run(
        _execute_agent,
        (sys.executable, "-u", "-c", script),
        tmp_path,
        os.environ.copy(),
        **kwargs,
    )


def completed_report(status="success", result="done"):
    return "\n".join(
        json.dumps(event)
        for event in (
            {
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": json.dumps({"status": status, "result": result}),
                },
            },
            {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}},
        )
    )


async def test_completed_result_does_not_wait_forever_for_agent_shutdown(tmp_path):
    result = await asyncio.wait_for(
        execute(
            f"import time; print({completed_report()!r}, flush=True); time.sleep(60)",
            tmp_path,
            shutdown_timeout_seconds=0.1,
            timeout_seconds=0.3,
            idle_timeout_seconds=0.3,
        ),
        5,
    )
    assert result.exit_code == 0
    assert result.agent_output["result"] == "done"
    assert "shutdown" in result.stderr


async def test_idle_agent_fails_and_preserves_partial_output(tmp_path):
    result = await asyncio.wait_for(
        execute(
            'import time; print("partial diagnostics", flush=True); time.sleep(60)',
            tmp_path,
            idle_timeout_seconds=0.1,
        ),
        5,
    )
    assert result.exit_code != 0
    assert "partial diagnostics" in result.stdout
    assert "no output" in result.stderr


async def test_busy_agent_still_has_total_deadline(tmp_path):
    result = await asyncio.wait_for(
        execute(
            'import time\nwhile True:\n print("working", flush=True); time.sleep(0.01)',
            tmp_path,
            timeout_seconds=0.15,
            idle_timeout_seconds=1,
        ),
        5,
    )
    assert result.exit_code != 0
    assert "runtime limit" in result.stderr


async def test_zero_exit_with_failed_report_is_failure(tmp_path):
    result = await execute(f"print({completed_report('failed', 'device unavailable')!r})", tmp_path)
    assert result.exit_code != 0
    assert result.agent_output["is_error"] is True
    assert "device unavailable" in result.stderr


@pytest.mark.parametrize(
    "event",
    [
        {"type": "turn.failed", "error": {"message": "usage limit"}},
        {"type": "turn.completed"},
    ],
)
async def test_failed_or_missing_codex_report_is_failure(tmp_path, event):
    result = await execute(f"print({json.dumps(event)!r})", tmp_path)
    assert result.exit_code != 0
    assert result.agent_output["is_error"] is True


async def test_agent_message_without_completed_turn_is_not_success(tmp_path):
    line = completed_report().splitlines()[0]
    result = await execute(f"print({line!r})", tmp_path)
    assert result.exit_code != 0
    assert "without a completed turn" in result.stderr


async def test_agent_has_no_interactive_stdin(tmp_path):
    result = await execute(
        f"import sys; assert sys.stdin.read() == ''; print({completed_report()!r})", tmp_path
    )
    assert result.exit_code == 0


async def test_exited_agent_with_child_holding_pipes_is_bounded(tmp_path):
    result = await asyncio.wait_for(
        execute(
            "import subprocess, sys; "
            'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]); '
            f"print({completed_report(result='finished')!r}, flush=True)",
            tmp_path,
            shutdown_timeout_seconds=0.1,
        ),
        5,
    )
    assert result.exit_code == 0
    assert "finished" in result.stdout


async def test_timeout_terminates_child_in_separate_process_group(tmp_path):
    pidfile = tmp_path / "child.pid"
    script = f"""import subprocess, sys, time
p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
open({str(pidfile)!r}, 'w').write(str(p.pid))
time.sleep(60)
"""
    try:
        result = await asyncio.wait_for(execute(script, tmp_path, idle_timeout_seconds=0.2), 5)
        assert result.exit_code != 0
        pid = int(pidfile.read_text())
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.02)
        else:
            pytest.fail("agent child survived timeout")
    finally:
        if pidfile.exists():
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(pidfile.read_text()), signal.SIGKILL)


async def test_exited_process_cleanup_permission_race_preserves_result(tmp_path, monkeypatch):
    real_killpg = os.killpg

    def killpg(pid, sig):
        if sig == signal.SIGKILL:
            raise PermissionError("exited process group was reparented")
        return real_killpg(pid, sig)

    monkeypatch.setattr(os, "killpg", killpg)
    result = await execute(f"print({completed_report()!r})", tmp_path)
    assert result.exit_code == 0
    assert result.agent_output["result"] == "done"


async def test_normalized_progress_is_saved_while_agent_is_still_running(tmp_path):
    marker = tmp_path / "progress-received"
    events = [
        {"type": "thread.started", "thread_id": "private-thread"},
        {"type": "item.completed", "item": {"type": "reasoning", "text": "private reasoning"}},
        {"type": "item.started", "item": {"type": "command_execution", "command": "pytest"}},
        {"type": "item.completed", "item": {"type": "agent_message", "text": "Checking tests"}},
    ]
    published = []

    async def persist(batch):
        published.extend(batch)
        marker.write_text("ready")

    script = f"""import pathlib, time
print({chr(10).join(json.dumps(event) for event in events)!r}, flush=True)
while not pathlib.Path({str(marker)!r}).exists():
    time.sleep(0.01)
print({completed_report()!r}, flush=True)
"""
    result = await asyncio.wait_for(
        execute(script, tmp_path, on_progress=persist, idle_timeout_seconds=3), 6
    )
    assert result.exit_code == 0
    assert {"kind": "command", "text": "pytest"} in published
    assert {"kind": "assistant", "text": "Checking tests"} in published
    assert {"kind": "assistant", "text": "done"} in published
    assert "private reasoning" not in str(published)
    assert "private-thread" not in str(published)


async def test_progress_storage_outage_does_not_abort_successful_job(tmp_path):
    async def unavailable(batch):
        raise RuntimeError("storage unavailable")

    result = await execute(f"print({completed_report()!r})", tmp_path, on_progress=unavailable)
    assert result.exit_code == 0
    assert result.agent_output["result"] == "done"


async def test_progress_memory_and_event_size_are_bounded():
    from code_factory.activities import _AgentOutput

    output = _AgentOutput()
    for _ in range(500):
        output.parse_result(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {"type": "agent_message", "text": "x" * 5000},
                }
            ).encode()
        )
    assert len(output.pending_events) == 300
    assert all(len(event["text"]) <= 2000 for event in output.pending_events)
