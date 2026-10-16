from __future__ import annotations

import struct
import threading
from types import SimpleNamespace

from jarvis_voice.hardware import LITE_PID, USB_4MIC_PID, profile_for_pid
from jarvis_voice.respeaker import _VOICE_ASSISTANT_TUNING, LedState, RespeakerUsb


class FakeUsbDevice:
    def __init__(self) -> None:
        self.values: dict[tuple[int, int], int] = {}

    def ctrl_transfer(self, request_type, request, command, resource, payload, timeout):
        del request, timeout
        if request_type == 0x40:
            offset, value, is_integer = struct.unpack("<iii", payload)
            assert is_integer == 1
            self.values[(resource, offset)] = value
            return None
        assert request_type == 0xC0
        offset = command & 0x3F
        return struct.pack("<ii", self.values[(resource, offset)], 0)


def test_usb4_voice_tuning_is_applied_and_verified():
    controller = RespeakerUsb.__new__(RespeakerUsb)
    controller.profile = profile_for_pid(USB_4MIC_PID)
    controller._device = FakeUsbDevice()
    controller._lock = threading.Lock()

    controller.apply_voice_assistant_tuning()

    assert set(controller._device.values.values()) == set(_VOICE_ASSISTANT_TUNING.values())


def test_other_boards_do_not_receive_usb4_tuning():
    controller = RespeakerUsb.__new__(RespeakerUsb)
    controller.profile = SimpleNamespace(product_id=0x0019)
    controller._device = FakeUsbDevice()
    controller._lock = threading.Lock()

    controller.apply_voice_assistant_tuning()

    assert controller._device.values == {}


def test_lite_usb_firmware_does_not_receive_pixel_ring_commands():
    class RejectUsbWrites:
        def ctrl_transfer(self, *args, **kwargs):
            raise AssertionError("ReSpeaker Lite USB firmware has no pixel-ring endpoint")

    controller = RespeakerUsb.__new__(RespeakerUsb)
    controller.profile = profile_for_pid(LITE_PID)
    controller._device = RejectUsbWrites()
    controller._lock = threading.Lock()

    controller.set_led(LedState.LISTENING)
