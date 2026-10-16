from __future__ import annotations

import pytest

from jarvis_voice.wakeword import WakeWordDetector


def test_missing_wakeword_models_fail_with_paths(tmp_path):
    with pytest.raises(FileNotFoundError, match="hey_jarvis_v0.1.onnx"):
        WakeWordDetector(tmp_path, 0.68, 2)
