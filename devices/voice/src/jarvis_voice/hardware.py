"""The three supported ReSpeaker front ends and no configuration-driven modes."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger(__name__)

SEEED_VID = 0x2886
USB_4MIC_PID = 0x0018
LITE_PID = 0x0019
XVF3800_PID = 0x001A

HardwareKind = Literal["respeaker_lite", "respeaker_usb_4mic", "respeaker_xvf3800"]


@dataclass(frozen=True)
class HardwareProfile:
    kind: HardwareKind
    product_id: int
    display_name: str
    input_name_hints: tuple[str, ...]
    output_name_hints: tuple[str, ...]
    capture_sample_rate: int = 16000
    playback_sample_rate: int = 16000
    capture_channels: int = 1
    capture_channel_index: int = 0
    speech_min_rms: float = 0.0
    barge_min_rms: float = 0.0
    barge_min_ratio: float = 0.5
    barge_consecutive_chunks: int = 3
    firmware_vad: bool = False


# Barge-in floors are calibrated against the echo-cancelled capture each profile
# guarantees (see each entry). They must clear the measured echo residual of the
# device's own playback with margin while staying reachable by normal room speech;
# the previous 900-2800 floors were calibrated on since-removed raw capture paths
# and had become unreachable, which disabled barge-in fleet-wide.
PROFILES: dict[int, HardwareProfile] = {
    LITE_PID: HardwareProfile(
        kind="respeaker_lite",
        product_id=LITE_PID,
        display_name="ReSpeaker Lite 2-Mic",
        input_name_hints=("Jarvis_EC_Mic", "ReSpeaker Lite", "ReSpeaker"),
        output_name_hints=("Jarvis_EC_Speaker", "ReSpeaker Lite", "ReSpeaker"),
        # The Lite's USB firmware (2.0.5) performs no echo cancellation: its own
        # playback measured ~6000 RMS in the capture, identical on both channels.
        # setup-respeaker-lite-audio.sh therefore routes default audio through a
        # PipeWire WebRTC echo-cancel pair; the cancelled residual measured 16-100
        # RMS after ~2 s of convergence (voice-two, 2026-09). The correlation
        # guard in BargeInDetector rejects the loud pre-convergence residual, and
        # the speech floor sits above the echo-cancel output noise (~94 RMS idle).
        speech_min_rms=250.0,
        barge_min_rms=400.0,
        barge_min_ratio=0.55,
        barge_consecutive_chunks=4,
    ),
    USB_4MIC_PID: HardwareProfile(
        kind="respeaker_usb_4mic",
        product_id=USB_4MIC_PID,
        display_name="ReSpeaker USB 4-Mic Array",
        input_name_hints=("ReSpeaker 4 Mic Array", "ReSpeaker"),
        output_name_hints=("ReSpeaker 4 Mic Array", "ReSpeaker"),
        # Capture is the board's post-AEC channel 0, exposed full-scale as a true
        # mono source by asoundrc.respeaker-usb4mic. Echo residual of its own
        # playback measured ~84 RMS at 55% volume (voice-three, 2026-09) and is
        # never sustained; near-end speech is ducked by XVF3000 doubletalk
        # suppression, so the floor must stay low and the streak plus firmware
        # VAD carry the rejection of transients. Idle ambience measured ~69 RMS.
        speech_min_rms=150.0,
        barge_min_rms=300.0,
        barge_min_ratio=0.75,
        barge_consecutive_chunks=4,
        firmware_vad=True,
    ),
    XVF3800_PID: HardwareProfile(
        kind="respeaker_xvf3800",
        product_id=XVF3800_PID,
        display_name="ReSpeaker XVF3800",
        input_name_hints=("XVF3800", "ReSpeaker", "reSpeaker"),
        output_name_hints=("XVF3800", "ReSpeaker", "reSpeaker"),
        # The XVF3800 exposes stereo USB capture: ch0 is the AEC/DSP output
        # (echo residual ~45 RMS during playback), ch1 is raw echo (~1947 RMS,
        # voice-one 2026-09). Capture both and keep only ch0; the previous
        # mono open downmixed them, drowning user speech in playback echo.
        capture_channels=2,
        capture_channel_index=0,
        speech_min_rms=150.0,
        barge_min_rms=300.0,
        barge_min_ratio=0.5,
        barge_consecutive_chunks=3,
    ),
}


def seeed_product_ids() -> tuple[int, ...]:
    try:
        import usb.core

        devices = usb.core.find(find_all=True, idVendor=SEEED_VID)
    except Exception as exc:
        raise RuntimeError(f"could not enumerate ReSpeaker USB devices: {exc}") from exc
    return tuple(int(device.idProduct) for device in devices or ())


def detect_profile(product_ids: Iterable[int] | None = None) -> HardwareProfile:
    """Detect exactly one supported board by USB VID/PID or fail with a useful diagnostic."""
    present = tuple(product_ids if product_ids is not None else seeed_product_ids())
    supported = [PROFILES[pid] for pid in present if pid in PROFILES]
    if not supported:
        seen = ", ".join(f"2886:{pid:04x}" for pid in present) or "none"
        expected = ", ".join(f"2886:{pid:04x}" for pid in PROFILES)
        raise RuntimeError(
            f"no supported ReSpeaker found (seen {seen}; expected one of {expected})"
        )
    unique = {profile.product_id: profile for profile in supported}
    if len(unique) != 1:
        names = ", ".join(profile.display_name for profile in unique.values())
        raise RuntimeError(f"multiple supported ReSpeakers are attached: {names}")
    profile = next(iter(unique.values()))
    logger.info(
        "audio hardware: %s (USB %04x:%04x)",
        profile.display_name,
        SEEED_VID,
        profile.product_id,
    )
    return profile


def profile_for_pid(product_id: int) -> HardwareProfile:
    try:
        return PROFILES[product_id]
    except KeyError as exc:
        raise ValueError(f"unsupported ReSpeaker product id: {product_id:#06x}") from exc
