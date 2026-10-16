from __future__ import annotations

import pytest

from jarvis_camera.detector import Detection, PresenceGate, highest_person_score


def test_highest_person_score_ignores_other_labels_and_low_scores() -> None:
    detections = [Detection(0, 0.4), Detection(2, 0.99), Detection(0, 0.73)]
    assert highest_person_score(detections, 0.55) == 0.73


def test_highest_person_score_rejects_weak_side_door_noise_at_entrance_threshold() -> None:
    detections = [Detection(0, 0.562), Detection(0, 0.621), Detection(2, 0.99)]
    assert highest_person_score(detections, 0.65) == 0.0


def test_highest_person_score_accepts_live_side_door_strong_positive_buckets() -> None:
    assert highest_person_score([Detection(0, 0.6796875)], 0.65) == pytest.approx(0.6796875)
    assert highest_person_score([Detection(0, 0.73046875)], 0.65) == pytest.approx(0.73046875)


def test_highest_person_score_supports_full_coco_label_range() -> None:
    detections = [Detection(79, 0.99), Detection(0, 0.76)]
    assert highest_person_score(detections, 0.55) == 0.76


def test_presence_gate_requires_clear_and_respects_cooldown() -> None:
    gate = PresenceGate(clear_seconds=3.0, cooldown_seconds=30.0, confirmations_required=1)
    assert gate.update(True, 0.0)
    assert not gate.update(True, 1.0)
    assert not gate.update(False, 2.0)
    assert not gate.update(True, 3.0)  # one intermittent miss does not re-arm
    assert not gate.update(False, 4.0)
    assert not gate.update(False, 7.0)
    assert not gate.present
    assert not gate.update(True, 10.0)  # re-entry is still inside cooldown
    assert not gate.update(False, 11.0)
    assert not gate.update(False, 14.0)
    assert gate.update(True, 31.0)


def test_presence_gate_requires_consecutive_confirmations() -> None:
    gate = PresenceGate(clear_seconds=3.0, cooldown_seconds=30.0, confirmations_required=2)
    assert not gate.update(True, 0.0)
    assert gate.consecutive_detections == 1
    assert not gate.update(False, 1.0)
    assert gate.consecutive_detections == 0
    assert not gate.update(True, 2.0)
    assert gate.update(True, 3.0)
    assert gate.present
