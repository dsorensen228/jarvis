import asyncio
import contextlib
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


async def test_completed_result_does_not_wait_forever_for_agent_shutdown(tmp_path):
    result = await asyncio.wait_for(
        execute(
            'import time; print(\'{"type":"result","subtype":"success",'
            '"is_error":false,"result":"done"}\', flush=True); time.sleep(60)',
            tmp_path,
            shutdown_timeout_seconds=0.1,
            timeout_seconds=0.08,
            idle_timeout_seconds=0.08,
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


async def test_zero_exit_with_error_result_is_failure(tmp_path):
    result = await execute(
        'print(\'{"type":"result","is_error":true,"result":"provider failed"}\')',
        tmp_path,
    )
    assert result.exit_code != 0
    assert result.agent_output["is_error"] is True


async def test_exited_agent_with_child_holding_pipes_is_bounded(tmp_path):
    result = await asyncio.wait_for(
        execute(
            "import subprocess, sys; "
            'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]); '
            'print("finished", flush=True)',
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
