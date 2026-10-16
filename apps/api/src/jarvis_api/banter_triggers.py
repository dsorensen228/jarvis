"""Short-lived robot pairing and single-use requests from its voice-device UI."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Callable, Dict, Literal, Optional, Tuple

from pydantic import BaseModel, StrictBool, constr

DeviceId = constr(strict=True, regex=r"^[a-zA-Z0-9_-]{1,100}$")
TriggerId = constr(strict=True, regex=r"^[a-f0-9]{32}$")


class BanterUnavailable(RuntimeError):
    pass


class StrictModel(BaseModel):
    class Config:
        extra = "forbid"


class TriggerResult(StrictModel):
    trigger_id: TriggerId
    status: Literal["completed", "failed"]


class RobotPoll(StrictModel):
    source_device_id: DeviceId
    response_device_id: DeviceId
    ready: StrictBool
    result: Optional[TriggerResult] = None


class PollResponse(StrictModel):
    trigger_id: Optional[TriggerId] = None


class BanterStatus(StrictModel):
    paired: bool = False
    available: bool = False
    busy: bool = False
    status: Literal[
        "unpaired", "offline", "not_idle", "ready", "queued", "running", "completed", "failed"
    ] = "unpaired"
    source_device_id: Optional[str] = None


@dataclass
class Pairing:
    response_device_id: str
    last_seen: float
    ready: bool
    trigger_id: Optional[str] = None
    trigger_status: str = ""
    trigger_expires_at: float = 0.0
    consumed: bool = False


class BanterTriggers:
    ONLINE_SECONDS = 15
    QUEUE_SECONDS = 90
    PAIRING_SECONDS = 300
    RUN_SECONDS = 180
    MAX_PAIRINGS = 128

    def __init__(
        self, active: Callable[[str], bool], clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.active = active
        self.clock = clock
        self.pairings: Dict[Tuple[str, str], Pairing] = {}

    def _prune(self) -> None:
        now = self.clock()
        self.pairings = {
            key: pair
            for key, pair in self.pairings.items()
            if now - pair.last_seen < self.PAIRING_SECONDS
        }
        for pair in self.pairings.values():
            if pair.trigger_status in {"queued", "running"} and now >= pair.trigger_expires_at:
                pair.trigger_status = "failed"

    def _find(self, owner: str, response: str) -> Optional[Tuple[str, Pairing]]:
        self._prune()
        return next(
            (
                (source, pair)
                for (user, source), pair in self.pairings.items()
                if user == owner and pair.response_device_id == response
            ),
            None,
        )

    def status(self, owner: str, response: str) -> BanterStatus:
        found = self._find(owner, response)
        if found is None:
            return BanterStatus()
        source, pair = found
        busy = pair.trigger_status in {"queued", "running"} or self.active(owner)
        online = self.clock() - pair.last_seen < self.ONLINE_SECONDS
        if busy:
            status = "queued" if pair.trigger_status == "queued" else "running"
        elif not online:
            status = "offline"
        elif pair.trigger_status in {"completed", "failed"}:
            status = pair.trigger_status
        else:
            status = "ready" if pair.ready else "not_idle"
        return BanterStatus(
            paired=True,
            available=online and pair.ready and not busy,
            busy=busy,
            status=status,
            source_device_id=source,
        )

    def reserved(self, owner: str) -> bool:
        self._prune()
        return any(
            user == owner and pair.trigger_status in {"queued", "running"}
            for (user, _), pair in self.pairings.items()
        )

    def queue(self, owner: str, response: str) -> BanterStatus:
        if self.reserved(owner) or not self.status(owner, response).available:
            raise BanterUnavailable("Sherman is offline, busy, or not idle")
        # No await between availability and reservation: repeated taps cannot enqueue twice.
        found = self._find(owner, response)
        assert found is not None
        _, pair = found
        pair.trigger_id = uuid.uuid4().hex
        pair.trigger_status = "queued"
        pair.trigger_expires_at = self.clock() + self.QUEUE_SECONDS
        pair.consumed = False
        return self.status(owner, response)

    def poll(self, owner: str, request: RobotPoll) -> PollResponse:
        self._prune()
        key = (owner, request.source_device_id)
        found = self._find(owner, request.response_device_id)
        if found is not None and found[0] != request.source_device_id:
            raise BanterUnavailable("response device already has a Sherman pairing")
        pair = self.pairings.get(key)
        if pair is None or pair.response_device_id != request.response_device_id:
            if pair is None and len(self.pairings) >= self.MAX_PAIRINGS:
                raise BanterUnavailable("Sherman pairing capacity reached")
            pair = Pairing(request.response_device_id, self.clock(), request.ready)
            self.pairings[key] = pair
        pair.last_seen = self.clock()
        pair.ready = request.ready
        if request.result and request.result.trigger_id == pair.trigger_id:
            if pair.trigger_status == "running":
                pair.trigger_status = request.result.status
        if request.ready and pair.trigger_status == "queued" and not self.active(owner):
            pair.trigger_status = "running"
            pair.trigger_expires_at = self.clock() + self.RUN_SECONDS
            return PollResponse(trigger_id=pair.trigger_id)
        return PollResponse()

    def consume(self, owner: str, source: str, response: str, trigger_id: str) -> None:
        self._prune()
        pair = self.pairings.get((owner, source))
        if (
            pair is None
            or pair.response_device_id != response
            or pair.trigger_id != trigger_id
            or pair.trigger_status != "running"
            or pair.consumed
        ):
            raise BanterUnavailable("manual trigger expired, unknown, or consumed")
        pair.consumed = True
