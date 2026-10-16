from __future__ import annotations

import pytest
from pydantic import ValidationError

from jarvis_api.banter_triggers import BanterTriggers, BanterUnavailable, RobotPoll


@pytest.fixture
def triggers():
    now = [100.0]
    registry = BanterTriggers(lambda owner: False, clock=lambda: now[0])
    poll = RobotPoll(source_device_id="sherman", response_device_id="voice-three", ready=True)
    return registry, now, poll


def test_pairing_is_learned_from_robot_and_scoped_to_owner_and_response(triggers):
    registry, _, poll = triggers
    assert not registry.status("owner", "voice-three").paired
    assert registry.poll("owner", poll).trigger_id is None
    assert registry.status("owner", "voice-three").available
    assert not registry.status("other", "voice-three").paired
    assert not registry.status("owner", "voice-four").paired
    with pytest.raises(BanterUnavailable):
        registry.queue("other", "voice-three")
    with pytest.raises(BanterUnavailable):
        registry.poll("owner", poll.copy(update={"source_device_id": "other-robot"}))


def test_poll_consumes_queue_once_and_result_can_be_acknowledged_twice(triggers):
    registry, _, poll = triggers
    registry.poll("owner", poll)
    assert registry.queue("owner", "voice-three").status == "queued"
    with pytest.raises(BanterUnavailable):
        registry.queue("owner", "voice-three")
    assert registry.poll("owner", poll.copy(update={"ready": False})).trigger_id is None
    trigger = registry.poll("owner", poll).trigger_id
    assert trigger
    assert registry.poll("owner", poll).trigger_id is None
    assert registry.status("owner", "voice-three").status == "running"
    registry.consume("owner", "sherman", "voice-three", trigger)
    with pytest.raises(BanterUnavailable):
        registry.consume("owner", "sherman", "voice-three", trigger)
    result_poll = RobotPoll(
        **{**poll.dict(), "result": {"trigger_id": trigger, "status": "completed"}}
    )
    for _ in range(2):
        assert registry.poll("owner", result_poll).trigger_id is None
        assert registry.status("owner", "voice-three").status == "completed"
    assert registry.status("owner", "voice-three").available


@pytest.mark.parametrize("seconds,paired,status", [(15, True, "offline"), (300, False, "unpaired")])
def test_stale_robot_is_unavailable_then_unpaired(triggers, seconds, paired, status):
    registry, now, poll = triggers
    registry.poll("owner", poll)
    now[0] += seconds
    actual = registry.status("owner", "voice-three")
    assert actual.paired == paired
    assert actual.status == status
    assert not actual.available
    with pytest.raises(BanterUnavailable):
        registry.queue("owner", "voice-three")


def test_queue_expires_without_delayed_playback_and_running_trigger_cannot_replay(triggers):
    registry, now, poll = triggers
    registry.poll("owner", poll)
    registry.queue("owner", "voice-three")
    # Keep the robot online while the queued demo waits out poll backoff.
    now[0] += 60
    registry.poll("owner", poll.copy(update={"ready": False}))
    assert registry.status("owner", "voice-three").status == "queued"
    trigger = registry.poll("owner", poll).trigger_id
    assert trigger
    now[0] += 180
    with pytest.raises(BanterUnavailable):
        registry.consume("owner", "sherman", "voice-three", trigger)


def test_queued_trigger_survives_brief_poll_gaps(triggers):
    registry, now, poll = triggers
    registry.poll("owner", poll)
    registry.queue("owner", "voice-three")
    now[0] += 60
    registry.poll("owner", poll.copy(update={"ready": False}))
    assert registry.status("owner", "voice-three").status == "queued"
    assert registry.poll("owner", poll).trigger_id
    now[0] += registry.RUN_SECONDS
    registry.poll("owner", poll.copy(update={"ready": False}))
    assert registry.status("owner", "voice-three").status == "failed"


def test_trigger_cannot_be_used_for_another_owner_source_or_speaker(triggers):
    registry, _, poll = triggers
    registry.poll("owner", poll)
    registry.queue("owner", "voice-three")
    trigger = registry.poll("owner", poll).trigger_id
    for owner, source, response in [
        ("other", "sherman", "voice-three"),
        ("owner", "other", "voice-three"),
        ("owner", "sherman", "voice-four"),
    ]:
        with pytest.raises(BanterUnavailable):
            registry.consume(owner, source, response, trigger)
    registry.consume("owner", "sherman", "voice-three", trigger)


def test_robot_busy_pair_change_and_capacity_are_bounded(triggers):
    registry, _, poll = triggers
    registry.MAX_PAIRINGS = 1
    registry.poll("owner", poll.copy(update={"ready": False}))
    assert registry.status("owner", "voice-three").status == "not_idle"
    with pytest.raises(BanterUnavailable):
        registry.queue("owner", "voice-three")
    with pytest.raises(BanterUnavailable):
        registry.poll("other", poll)
    registry.poll("owner", poll.copy(update={"response_device_id": "study-jarvis"}))
    assert not registry.status("owner", "voice-three").paired
    assert registry.status("owner", "study-jarvis").available


def test_poll_rejects_ambiguous_boolean_and_extra_commands():
    with pytest.raises(ValidationError):
        RobotPoll(source_device_id="sherman", response_device_id="voice-three", ready="false")
    with pytest.raises(ValidationError):
        RobotPoll(
            source_device_id="sherman", response_device_id="voice-three", ready=True, command="go"
        )
