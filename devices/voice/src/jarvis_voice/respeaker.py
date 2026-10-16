"""USB LED and firmware-VAD control for the three supported ReSpeaker boards."""

from __future__ import annotations

import logging
import struct
import threading
import time
from enum import Enum

from jarvis_voice.hardware import (
    LITE_PID,
    SEEED_VID,
    USB_4MIC_PID,
    XVF3800_PID,
    HardwareProfile,
)

logger = logging.getLogger(__name__)

PURPLE = 0xBF5AF2
DARK_PURPLE = 0x2A1845

# XMOS resource/offset map used by Seeed's USB 4 Mic tuning utility.
_DSP_PARAMETERS: dict[str, tuple[int, int]] = {
    "AECFREEZEONOFF": (18, 7),
    "HPFONOFF": (18, 27),
    "AGCONOFF": (19, 0),
    "CNIONOFF": (19, 5),
    "FREEZEONOFF": (19, 6),
    "STATNOISEONOFF": (19, 8),
    "NONSTATNOISEONOFF": (19, 11),
    "ECHOONOFF": (19, 14),
    "NLATTENONOFF": (19, 18),
    "TRANSIENTONOFF": (19, 29),
    "STATNOISEONOFF_SR": (19, 33),
    "NONSTATNOISEONOFF_SR": (19, 34),
}

_VOICE_ASSISTANT_TUNING = {
    "AECFREEZEONOFF": 0,
    "HPFONOFF": 1,
    "AGCONOFF": 1,
    "CNIONOFF": 0,
    "FREEZEONOFF": 0,
    "STATNOISEONOFF": 1,
    "NONSTATNOISEONOFF": 1,
    "ECHOONOFF": 1,
    "NLATTENONOFF": 1,
    "TRANSIENTONOFF": 1,
    "STATNOISEONOFF_SR": 1,
    "NONSTATNOISEONOFF_SR": 1,
}


class LedState(str, Enum):
    IDLE = "idle"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"
    ERROR = "error"


class RespeakerUsb:
    """One shared USB handle serializes LED writes and USB 4-mic VAD reads."""

    timeout_ms = 1000

    def __init__(self, profile: HardwareProfile) -> None:
        import usb.core

        device = usb.core.find(idVendor=SEEED_VID, idProduct=profile.product_id)
        if device is None:
            raise RuntimeError(f"{profile.display_name} disappeared before USB control opened")
        self.profile = profile
        self._device = device
        self._lock = threading.Lock()

    def close(self) -> None:
        try:
            import usb.util

            with self._lock:
                usb.util.dispose_resources(self._device)
        except Exception:
            logger.debug("could not release ReSpeaker USB handle", exc_info=True)

    def set_led(self, state: LedState) -> None:
        # ReSpeaker Lite's USB UAC firmware does not expose the USB 4-mic
        # vendor-specific pixel-ring interface. The legacy runtime assumed it
        # did, producing a PIPE error on every state transition. Its WS2812 is
        # available to an attached MCU; leave it to the board in USB mode.
        if self.profile.product_id == LITE_PID:
            return
        try:
            with self._lock:
                if self.profile.product_id == XVF3800_PID:
                    self._set_xvf_led(state)
                else:
                    self._set_vendor_led(state)
        except Exception as exc:
            logger.warning("ReSpeaker LED update %s failed: %s", state.value, exc)

    def read_firmware_vad(self) -> bool:
        if self.profile.product_id != USB_4MIC_PID:
            return False
        with self._lock:
            response = self._device.ctrl_transfer(
                0xC0,
                0,
                0x80 | 0x40 | 32,
                19,
                8,
                200,
            )
        value, _ = struct.unpack("<ii", bytes(response))
        return value != 0

    def apply_voice_assistant_tuning(self) -> None:
        """Apply and verify the fixed USB4 DSP profile used for AEC, ASR, and barge-in."""
        if self.profile.product_id != USB_4MIC_PID:
            return
        applied: list[str] = []
        with self._lock:
            for name, value in _VOICE_ASSISTANT_TUNING.items():
                resource_id, offset = _DSP_PARAMETERS[name]
                try:
                    self._device.ctrl_transfer(
                        0x40,
                        0,
                        0,
                        resource_id,
                        struct.pack("<iii", offset, value, 1),
                        self.timeout_ms,
                    )
                    response = self._device.ctrl_transfer(
                        0xC0,
                        0,
                        0x80 | 0x40 | offset,
                        resource_id,
                        8,
                        self.timeout_ms,
                    )
                    actual, _ = struct.unpack("<ii", bytes(response))
                    applied.append(f"{name}={actual}")
                except Exception as exc:
                    logger.warning("USB 4-mic DSP tuning failed for %s: %s", name, exc)
        if applied:
            logger.info("USB 4-mic DSP tuning applied: %s", ", ".join(applied))

    def _vendor_write(self, command: int, data: list[int] | None = None) -> None:
        self._device.ctrl_transfer(
            0x40,
            0,
            command,
            0x1C,
            data or [0],
            self.timeout_ms,
        )

    def _vendor_mono(self, rgb: int) -> None:
        self._vendor_write(
            1,
            [(rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF, 0],
        )

    def _set_vendor_led(self, state: LedState) -> None:
        if state == LedState.IDLE:
            self._vendor_mono(0)
            return
        self._vendor_write(0x20, [20])
        if state == LedState.LISTENING:
            self._vendor_write(2)
        elif state == LedState.THINKING:
            if self.profile.product_id == USB_4MIC_PID:
                self._vendor_write(
                    0x21,
                    [
                        (DARK_PURPLE >> 16) & 0xFF,
                        (DARK_PURPLE >> 8) & 0xFF,
                        DARK_PURPLE & 0xFF,
                        0,
                        (PURPLE >> 16) & 0xFF,
                        (PURPLE >> 8) & 0xFF,
                        PURPLE & 0xFF,
                        0,
                    ],
                )
                self._vendor_write(4)
            else:
                self._vendor_mono(PURPLE)
        elif state == LedState.SPEAKING:
            self._vendor_mono(PURPLE)
        else:
            self._vendor_mono(0xFF3B30)

    def _xvf_write_u8(self, command: int, value: int) -> None:
        self._device.ctrl_transfer(
            0x40,
            0,
            command,
            20,
            int(value).to_bytes(1, "little"),
            self.timeout_ms,
        )

    def _xvf_write_color(self, rgb: int) -> None:
        self._device.ctrl_transfer(
            0x40,
            0,
            16,
            20,
            struct.pack("<I", rgb & 0xFFFFFF),
            self.timeout_ms,
        )

    def _set_xvf_led(self, state: LedState) -> None:
        effects = {
            LedState.IDLE: 0,
            LedState.LISTENING: 4,
            LedState.THINKING: 1,
            LedState.SPEAKING: 3,
            LedState.ERROR: 3,
        }
        self._xvf_write_u8(12, effects[state])
        if state != LedState.IDLE:
            self._xvf_write_color(0xFF3B30 if state == LedState.ERROR else PURPLE)
            self._xvf_write_u8(15, 48)
            self._xvf_write_u8(13, 220)


class FirmwareVadPoller:
    def __init__(self, controller: RespeakerUsb, interval_seconds: float = 0.025) -> None:
        if controller.profile.product_id != USB_4MIC_PID:
            raise ValueError("firmware VAD exists only on the USB 4-mic array")
        self._controller = controller
        self._interval = interval_seconds
        self._voice = False
        self._updated_at = 0.0
        self._failed = False
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="respeaker-vad", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                voice = self._controller.read_firmware_vad()
            except Exception as exc:
                logger.warning("USB 4-mic firmware VAD stopped: %s", exc)
                with self._lock:
                    self._failed = True
                    self._voice = False
                return
            with self._lock:
                self._voice = voice
                self._updated_at = time.monotonic()
            self._stop.wait(self._interval)

    def is_voice(self, *, max_age_seconds: float = 0.25) -> bool:
        with self._lock:
            return (
                not self._failed
                and self._updated_at > 0
                and time.monotonic() - self._updated_at <= max_age_seconds
                and self._voice
            )

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)


def open_respeaker(profile: HardwareProfile) -> tuple[RespeakerUsb, FirmwareVadPoller | None]:
    controller = RespeakerUsb(profile)
    controller.apply_voice_assistant_tuning()
    firmware_vad = FirmwareVadPoller(controller) if profile.firmware_vad else None
    controller.set_led(LedState.IDLE)
    if firmware_vad:
        logger.info("USB 4-mic firmware VAD enabled")
    return controller, firmware_vad
