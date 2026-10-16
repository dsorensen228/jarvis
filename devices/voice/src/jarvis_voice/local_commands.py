"""Exact local voice short-circuits that skip the remote agent."""

from __future__ import annotations

from typing import Literal


def exact_light_command(text: str) -> Literal["on", "off"] | None:
    """Return on/off only when the utterance is exactly \"lights on\" or \"lights off\"."""
    normalized = " ".join(str(text or "").casefold().split()).strip(".,!?;:")
    if normalized == "lights on":
        return "on"
    if normalized == "lights off":
        return "off"
    return None
