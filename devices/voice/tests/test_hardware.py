from __future__ import annotations

import pytest

from jarvis_voice.hardware import LITE_PID, USB_4MIC_PID, XVF3800_PID, detect_profile


@pytest.mark.parametrize(
    ("product_id", "kind"),
    [
        (LITE_PID, "respeaker_lite"),
        (USB_4MIC_PID, "respeaker_usb_4mic"),
        (XVF3800_PID, "respeaker_xvf3800"),
    ],
)
def test_exact_supported_profiles(product_id, kind):
    assert detect_profile([product_id]).kind == kind


def test_unknown_or_ambiguous_hardware_fails():
    with pytest.raises(RuntimeError, match="no supported ReSpeaker"):
        detect_profile([0x9999])
    with pytest.raises(RuntimeError, match="multiple supported ReSpeakers"):
        detect_profile([LITE_PID, XVF3800_PID])


def test_duplicate_usb_enumeration_is_one_profile():
    assert detect_profile([USB_4MIC_PID, USB_4MIC_PID]).kind == "respeaker_usb_4mic"


def test_xvf3800_captures_only_the_echo_cancelled_channel():
    """XVF3800 USB capture is stereo: ch0 is the AEC/DSP output, ch1 is raw echo.

    Downmixing both channels buries user speech in the device's own playback
    (measured on voice-one: ch0 echo residual 45 RMS, ch1 raw echo 1947 RMS),
    which made barge-in undetectable while the assistant spoke.
    """
    profile = detect_profile([XVF3800_PID])
    assert profile.capture_channels == 2
    assert profile.capture_channel_index == 0


def test_mono_capture_profiles_stay_mono():
    assert detect_profile([USB_4MIC_PID]).capture_channels == 1
    assert detect_profile([LITE_PID]).capture_channels == 1


@pytest.mark.parametrize("product_id", [LITE_PID, USB_4MIC_PID, XVF3800_PID])
def test_barge_floor_is_reachable_on_echo_cancelled_capture(product_id):
    """Every profile assumes an echo-cancelled capture path with residual under
    ~150 RMS (measured 2026-09: USB4 ~84, XVF3800 ch0 ~45, Lite behind WebRTC
    echo-cancel ~16-100). Floors must clear that residual with margin yet stay
    reachable by normal speech, which the old 900-2800 floors were not.
    """
    profile = detect_profile([product_id])
    assert 200 <= profile.barge_min_rms <= 600
