from __future__ import annotations

from jarvis_voice.audio import _pick_device


def test_explicit_default_uses_host_default_pcm():
    index, name = _pick_device(
        [],
        direction="input",
        override="default",
        hints=("ReSpeaker",),
    )
    assert index is None
    assert name == "default"
