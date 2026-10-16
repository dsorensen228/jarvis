"""PipeWire/PulseAudio system-volume control for the Raspberry Pi kiosk."""

from __future__ import annotations

import asyncio
import re
import shutil
from dataclasses import dataclass


@dataclass(frozen=True)
class VolumeState:
    percent: int
    muted: bool


async def _run(*command: str) -> str:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=8.0)
    if process.returncode:
        detail = stderr.decode(errors="replace").strip() or stdout.decode(errors="replace").strip()
        raise RuntimeError(detail or f"{command[0]} exited {process.returncode}")
    return stdout.decode(errors="replace").strip()


def _percent(text: str) -> int:
    match = re.search(r"(\d+(?:\.\d+)?)\s*%", text)
    if match:
        return max(0, min(100, round(float(match.group(1)))))
    numbers = re.findall(r"(?<!\d)(?:0(?:\.\d+)?|1(?:\.0+)?)(?!\d)", text)
    if numbers:
        return max(0, min(100, round(float(numbers[-1]) * 100)))
    raise RuntimeError(f"could not parse volume from {text!r}")


def _backend() -> str:
    if shutil.which("wpctl"):
        return "wpctl"
    if shutil.which("pactl"):
        return "pactl"
    raise RuntimeError("volume control requires wpctl or pactl")


async def get_volume() -> VolumeState:
    backend = _backend()
    if backend == "wpctl":
        output = await _run("wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@")
        return VolumeState(_percent(output), "MUTED" in output.upper())
    volume, muted = await asyncio.gather(
        _run("pactl", "get-sink-volume", "@DEFAULT_SINK@"),
        _run("pactl", "get-sink-mute", "@DEFAULT_SINK@"),
    )
    return VolumeState(_percent(volume), muted.lower().endswith("yes"))


async def set_volume(
    *,
    percent: int | None = None,
    delta_percent: int | None = None,
    muted: bool | None = None,
) -> VolumeState:
    backend = _backend()
    if percent is not None and delta_percent is not None:
        raise ValueError("send percent or delta_percent, not both")
    if percent is not None:
        value = max(0, min(100, int(percent)))
        if backend == "wpctl":
            await _run("wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{value / 100:.2f}")
        else:
            await _run("pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{value}%")
    if delta_percent is not None and int(delta_percent) != 0:
        delta = max(-100, min(100, int(delta_percent)))
        sign = "+" if delta > 0 else "-"
        if backend == "wpctl":
            await _run(
                "wpctl",
                "set-volume",
                "@DEFAULT_AUDIO_SINK@",
                f"{abs(delta)}%{sign}",
            )
        else:
            await _run("pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{sign}{abs(delta)}%")
    if muted is not None:
        if backend == "wpctl":
            await _run("wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1" if muted else "0")
        else:
            await _run("pactl", "set-sink-mute", "@DEFAULT_SINK@", "1" if muted else "0")
    return await get_volume()
