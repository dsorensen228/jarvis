from __future__ import annotations

import pytest

from jarvis_voice.coding_prompt import PromptRecorder


def test_prompt_recorder_is_manual_bounded_and_reusable():
    recorder = PromptRecorder(6)
    recorder.start()
    recorder.push(b"abcd")
    recorder.push(b"efgh")
    assert recorder.active is True
    assert recorder.overflowed is True
    assert recorder.stop() == b"abcdef"
    assert recorder.active is False

    recorder.start()
    recorder.push(b"xy")
    assert recorder.stop() == b"xy"


def test_prompt_recorder_rejects_ambiguous_lifecycle():
    recorder = PromptRecorder(8)
    with pytest.raises(RuntimeError, match="no coding prompt"):
        recorder.stop()
    recorder.start()
    with pytest.raises(RuntimeError, match="already"):
        recorder.start()
