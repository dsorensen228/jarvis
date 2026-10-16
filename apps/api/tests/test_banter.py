from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import FakeLlm, FakeSpeech
from fastapi.testclient import TestClient

from jarvis_api.app import create_app
from jarvis_api.banter import (
    BanterService,
    BanterUnavailable,
    Exchange,
    ScriptContent,
    ScriptRequest,
    style_error,
    usable_recent,
)
from jarvis_api.banter_triggers import RobotPoll
from jarvis_api.voice import VoiceConnectionHub

FIXTURE = json.loads((Path(__file__).parent / "fixtures/banter-script-v1.json").read_text())


def setup_service(answer=None):
    clock = [1000.0]
    llm = FakeLlm(json.dumps(FIXTURE) if answer is None else answer)
    voices = SimpleNamespace(scripted_speech_ready=AsyncMock(), speak_scripted=AsyncMock())
    service = BanterService(llm, voices, clock=lambda: clock[0])
    request = ScriptRequest(source_device_id="sherman", response_device_id="custom-speaker")
    return service, request, voices, llm, clock


async def test_generate_and_play_in_order_without_replay():
    service, request, voices, llm, clock = setup_service()
    script = await service.create("owner", request)
    assert script.response_device_id == "custom-speaker"
    assert script.exchanges == ScriptContent.parse_obj(FIXTURE).exchanges
    assert voices.speak_scripted.await_count == 0
    with pytest.raises(BanterUnavailable):
        await service.reply("owner", script.script_id, 1)
    with pytest.raises(BanterUnavailable):
        await service.reply("other-owner", script.script_id, 0)
    assert (await service.reply("owner", script.script_id, 0))["status"] == "played"
    with pytest.raises(BanterUnavailable):
        await service.reply("owner", script.script_id, 0)
    assert (await service.reply("owner", script.script_id, 1))["status"] == "played"
    assert voices.speak_scripted.call_args_list[0].args == (
        "owner",
        "custom-speaker",
        FIXTURE["exchanges"][0]["jarvis"],
    )
    with pytest.raises(BanterUnavailable):
        await service.create("owner", request)
    clock[0] += 301
    await service.create("owner", request)
    assert len(llm.requests) == 2


async def test_manual_demo_bypasses_cooldown_once_but_cannot_overlap_playback():
    service, request, _, llm, _ = setup_service()
    original = await service.create("owner", request)
    poll = RobotPoll(
        source_device_id=request.source_device_id,
        response_device_id=request.response_device_id,
        ready=True,
    )
    service.triggers.poll("owner", poll)
    with pytest.raises(BanterUnavailable):
        service.triggers.queue("owner", request.response_device_id)
    for index in range(len(original.exchanges)):
        await service.reply("owner", original.script_id, index)
    with pytest.raises(BanterUnavailable):
        await service.create("owner", request)
    service.triggers.queue("owner", request.response_device_id)
    trigger = service.triggers.poll("owner", poll).trigger_id
    manual = request.copy(update={"trigger_id": trigger})
    script = await service.create("owner", manual)
    assert script.script_id != original.script_id
    for index in range(len(script.exchanges)):
        await service.reply("owner", script.script_id, index)
    with pytest.raises(BanterUnavailable):
        await service.create("owner", manual)
    assert len(llm.requests) == 2


async def test_queued_demo_prevents_autonomous_generation_from_taking_its_place():
    service, request, _, llm, _ = setup_service()
    service.triggers.poll(
        "owner",
        RobotPoll(
            source_device_id=request.source_device_id,
            response_device_id=request.response_device_id,
            ready=True,
        ),
    )
    service.triggers.queue("owner", request.response_device_id)
    with pytest.raises(BanterUnavailable):
        await service.create("owner", request)
    assert not llm.requests


async def test_robot_abort_releases_manual_demo_and_rejects_late_reply():
    service, request, _, _, _ = setup_service()
    poll = RobotPoll(
        source_device_id=request.source_device_id,
        response_device_id=request.response_device_id,
        ready=True,
    )
    service.poll("owner", poll)
    service.triggers.queue("owner", request.response_device_id)
    trigger = service.poll("owner", poll).trigger_id
    script = await service.create("owner", request.copy(update={"trigger_id": trigger}))
    service.poll(
        "owner",
        RobotPoll(**{**poll.dict(), "result": {"trigger_id": trigger, "status": "failed"}}),
    )
    assert not service.active("owner")
    with pytest.raises(BanterUnavailable):
        await service.reply("owner", script.script_id, 0)
    assert service.triggers.queue("owner", request.response_device_id).status == "queued"


async def test_robot_abort_during_reply_cannot_reopen_later_exchange():
    service, request, voices, _, _ = setup_service()
    poll = RobotPoll(
        source_device_id=request.source_device_id,
        response_device_id=request.response_device_id,
        ready=True,
    )
    service.poll("owner", poll)
    service.triggers.queue("owner", request.response_device_id)
    trigger = service.poll("owner", poll).trigger_id
    script = await service.create("owner", request.copy(update={"trigger_id": trigger}))
    entered, release = asyncio.Event(), asyncio.Event()

    async def playback(*args):
        entered.set()
        await release.wait()

    voices.speak_scripted.side_effect = playback
    first_reply = asyncio.create_task(service.reply("owner", script.script_id, 0))
    await entered.wait()
    service.poll(
        "owner",
        RobotPoll(**{**poll.dict(), "result": {"trigger_id": trigger, "status": "failed"}}),
    )
    release.set()
    await first_reply
    with pytest.raises(BanterUnavailable):
        await service.reply("owner", script.script_id, 1)


@pytest.mark.parametrize(
    "answer",
    [
        "not JSON",
        "x" * 4097,
        "{}",
        json.dumps({**FIXTURE, "schema_version": True}),
        json.dumps({**FIXTURE, "exchanges": []}),
        json.dumps({**FIXTURE, "exchanges": FIXTURE["exchanges"] * 2}),
        json.dumps({**FIXTURE, "command": "play arbitrary audio"}),
        json.dumps(
            {
                "schema_version": 1,
                "exchanges": [
                    {
                        **FIXTURE["exchanges"][0],
                        "jarvis": "x " * 31,
                    }
                ],
            }
        ),
    ],
)
async def test_invalid_model_output_is_silent_and_retried(answer):
    service, request, voices, llm, _ = setup_service(answer)
    with pytest.raises(BanterUnavailable):
        await service.create("owner", request)
    assert voices.speak_scripted.await_count == 0
    # Failed generations must not impose the success cooldown; Sherman can retry.
    with pytest.raises(BanterUnavailable):
        await service.create("owner", request)
    per_attempt = 1 if answer == "x" * 4097 else BanterService.MAX_GENERATION_ATTEMPTS
    assert len(llm.requests) == per_attempt * 2


async def test_expiry_and_ambiguous_failure_are_never_replayed():
    service, request, voices, _, clock = setup_service()
    script = await service.create("owner", request)
    voices.speak_scripted.side_effect = RuntimeError("lost reply")
    with pytest.raises(BanterUnavailable):
        await service.reply("owner", script.script_id, 0)
    voices.speak_scripted.side_effect = None
    with pytest.raises(BanterUnavailable):
        await service.reply("owner", script.script_id, 0)
    assert voices.speak_scripted.await_count == 1
    clock[0] += 301
    script = await service.create("owner", request)
    clock[0] += 180
    with pytest.raises(BanterUnavailable):
        await service.reply("owner", script.script_id, 0)


async def test_offline_target_skips_generation_and_concurrent_replies_do_not_overlap():
    service, request, voices, llm, clock = setup_service()
    voices.scripted_speech_ready.side_effect = RuntimeError("offline")
    with pytest.raises(BanterUnavailable):
        await service.create("owner", request)
    assert not llm.requests
    voices.scripted_speech_ready.side_effect = None
    clock[0] += 301
    script = await service.create("owner", request)
    entered, release = asyncio.Event(), asyncio.Event()

    async def playback(*args):
        entered.set()
        await release.wait()

    voices.speak_scripted.side_effect = playback
    task = asyncio.create_task(service.reply("owner", script.script_id, 0))
    await entered.wait()
    with pytest.raises(BanterUnavailable):
        await service.reply("owner", script.script_id, 1)
    release.set()
    await task


async def test_hub_uses_only_owner_target_and_requires_idle_and_completion():
    hub = VoiceConnectionHub()
    action = AsyncMock(return_value={"idle": True})
    session = SimpleNamespace(
        user={"id": "owner"},
        device_id="speaker",
        scripted_speech_supported=True,
        audio=bytearray(),
        turn_task=None,
        _announcement_lock=asyncio.Lock(),
        _device_actions={},
        _invoke_device_action=action,
        speech=FakeSpeech(),
    )
    await hub.register(session)
    with pytest.raises(RuntimeError):
        await hub.scripted_speech_ready("other", "speaker")
    await hub.scripted_speech_ready("owner", "speaker")
    action.return_value = {"status": "played"}
    await hub.speak_scripted("owner", "speaker", "A brief reply.")
    assert action.call_args.args[0] == "play_scripted_speech"
    action.return_value = {"status": "interrupted"}
    with pytest.raises(RuntimeError):
        await hub.speak_scripted("owner", "speaker", "A brief reply.")
    # Stale mic bytes left after cancel must not block banter once the device is idle.
    session.audio = bytearray(b"recording")
    action.return_value = {"idle": True}
    await hub.scripted_speech_ready("owner", "speaker")
    assert session.audio == bytearray()
    session.audio = bytearray(b"live utterance")
    action.return_value = {"status": "played"}
    with pytest.raises(RuntimeError):
        await hub.speak_scripted("owner", "speaker", "A brief reply.")


async def test_interrupt_clears_stale_audio_so_banter_can_ready():
    from jarvis_api.voice import VoiceSession

    hub = VoiceConnectionHub()
    session = object.__new__(VoiceSession)
    session.user = {"id": "owner"}
    session.device_id = "speaker"
    session.scripted_speech_supported = True
    session.audio = bytearray(b"orphan mic")
    session.turn_task = None
    session.cancel_event = asyncio.Event()
    session._announcement_lock = asyncio.Lock()
    session._device_actions = {}
    session._invoke_device_action = AsyncMock(return_value={"idle": True})
    await hub.register(session)
    await session._interrupt()
    assert session.audio == bytearray()
    await hub.scripted_speech_ready("owner", "speaker")


def test_authenticated_api_contract(settings):
    app = create_app(settings, llm=FakeLlm(json.dumps(FIXTURE)), speech_service=FakeSpeech())
    with TestClient(app) as client:
        voices = SimpleNamespace(scripted_speech_ready=AsyncMock(), speak_scripted=AsyncMock())
        app.state.banter.voices = voices
        body = {"source_device_id": "sherman", "response_device_id": "configured-speaker"}
        assert client.post("/v1/banter/scripts", json=body).status_code == 401
        token = client.post(
            "/v1/auth/token",
            json={
                "username": "owner",
                "password": "correct horse battery staple",
            },
        ).json()["access_token"]
        headers = {"Authorization": "Bearer " + token}
        assert (
            client.post(
                "/v1/banter/scripts", json={**body, "source_device_id": "../x"}, headers=headers
            ).status_code
            == 422
        )
        response = client.post("/v1/banter/scripts", json=body, headers=headers)
        assert response.status_code == 200, response.text
        script = response.json()
        route = f"/v1/banter/scripts/{script['script_id']}/replies/0"
        assert client.post(route, headers=headers).json()["status"] == "played"
        assert client.post(route, headers=headers).status_code == 409


def test_manual_demo_api_round_trip_and_unpaired_devices(settings):
    app = create_app(settings, llm=FakeLlm(json.dumps(FIXTURE)), speech_service=FakeSpeech())
    with TestClient(app) as client:
        voices = SimpleNamespace(scripted_speech_ready=AsyncMock(), speak_scripted=AsyncMock())
        app.state.banter.voices = voices
        body = {"source_device_id": "sherman", "response_device_id": "voice-three"}
        path = "/v1/banter/devices/voice-three"
        assert client.get(path).status_code == 401
        assert client.post(path + "/trigger").status_code == 401
        assert client.post("/v1/banter/poll", json={**body, "ready": True}).status_code == 401
        token = client.post(
            "/v1/auth/token",
            json={"username": "owner", "password": "correct horse battery staple"},
        ).json()["access_token"]
        headers = {"Authorization": "Bearer " + token}
        assert not client.get(path, headers=headers).json()["paired"]
        assert client.post(path + "/trigger", headers=headers).status_code == 409
        poll = {**body, "ready": True}
        assert client.post("/v1/banter/poll", json=poll, headers=headers).json() == {
            "trigger_id": None
        }
        assert client.get(path, headers=headers).json()["available"]
        assert not client.get("/v1/banter/devices/voice-four", headers=headers).json()["paired"]
        voices.scripted_speech_ready.side_effect = RuntimeError("speaker is busy")
        assert client.post(path + "/trigger", headers=headers).status_code == 409
        voices.scripted_speech_ready.side_effect = asyncio.TimeoutError()
        assert client.post(path + "/trigger", headers=headers).status_code == 409
        voices.scripted_speech_ready.side_effect = None
        assert client.post(path + "/trigger", headers=headers).json()["status"] == "queued"
        assert client.post(path + "/trigger", headers=headers).status_code == 409
        trigger = client.post("/v1/banter/poll", json=poll, headers=headers).json()["trigger_id"]
        script_response = client.post(
            "/v1/banter/scripts", json={**body, "trigger_id": trigger}, headers=headers
        )
        assert script_response.status_code == 200
        script = script_response.json()
        for index in range(len(script["exchanges"])):
            assert (
                client.post(
                    f"/v1/banter/scripts/{script['script_id']}/replies/{index}", headers=headers
                ).json()["status"]
                == "played"
            )
        result = {"trigger_id": trigger, "status": "completed"}
        client.post("/v1/banter/poll", json={**poll, "result": result}, headers=headers)
        assert client.get(path, headers=headers).json()["status"] == "completed"
        assert client.post(path + "/trigger", headers=headers).status_code == 200


def test_real_websocket_script_round_trip_waits_for_speaker_ack(settings):
    from concurrent.futures import ThreadPoolExecutor

    app = create_app(settings, llm=FakeLlm(json.dumps(FIXTURE)), speech_service=FakeSpeech())
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=1) as executor:
        token = client.post(
            "/v1/auth/token",
            json={
                "username": "owner",
                "password": "correct horse battery staple",
            },
        ).json()["access_token"]
        headers = {"Authorization": "Bearer " + token}
        with client.websocket_connect(f"/v1/voice?token={token}") as socket:
            assert socket.receive_json()["type"] == "session.ready"
            socket.send_json(
                {
                    "type": "session.configure",
                    "device_id": "configured-speaker",
                    "capabilities": ["scripted_speech_v1"],
                }
            )
            assert socket.receive_json()["type"] == "session.configured"
            future = executor.submit(
                client.post,
                "/v1/banter/scripts",
                headers=headers,
                json={
                    "source_device_id": "sherman",
                    "response_device_id": "configured-speaker",
                },
            )
            for _ in range(2):
                event = socket.receive_json()
                assert event["type"] == "device.action"
                assert event["data"]["action"] == "speech_status"
                socket.send_json(
                    {
                        "type": "device.action.result",
                        "request_id": event["data"]["request_id"],
                        "result": {"idle": True},
                    }
                )
            script = future.result(timeout=5).json()
            route = f"/v1/banter/scripts/{script['script_id']}/replies/0"
            future = executor.submit(client.post, route, headers=headers)
            event = socket.receive_json()
            assert event["data"]["action"] == "play_scripted_speech"
            assert not future.done()
            socket.send_json(
                {
                    "type": "device.action.result",
                    "request_id": event["data"]["request_id"],
                    "result": {"status": "played"},
                }
            )
            assert future.result(timeout=5).json()["status"] == "played"


def test_style_error_rejects_invented_owner_actions_and_formula():
    invented = ScriptContent.parse_obj(
        {
            "schema_version": 1,
            "exchanges": [
                {
                    "sherman": "He's turning on the lights again.",
                    "emotion": "indignant",
                    "jarvis": "Yes, and he hasn't even turned off the coffee maker.",
                }
            ],
        }
    )
    assert style_error(invented)

    formula = ScriptContent.parse_obj(
        {
            "schema_version": 1,
            "exchanges": [
                {
                    "sherman": "He's humming that song again.",
                    "emotion": "skeptical",
                    "jarvis": "Yes, and it's the same one every morning.",
                },
                {
                    "sherman": "Can we play something else?",
                    "emotion": "conspiratorial",
                    "jarvis": "Only if you want him to think the speakers are broken again.",
                },
            ],
        }
    )
    assert style_error(formula)

    ok = ScriptContent.parse_obj(
        {
            "schema_version": 1,
            "exchanges": [
                {
                    "sherman": "I'm bored.",
                    "emotion": "indignant",
                    "jarvis": "Yes, Sherman, I'm bored too.",
                },
                {
                    "sherman": "Is he stupid?",
                    "emotion": "curious",
                    "jarvis": "Yes. And he keeps wasting my time.",
                },
            ],
        }
    )
    assert style_error(ok) is None
    assert style_error(ok, recent=ok.exchanges) == "repeats recent exchange"
    toaster = ScriptContent.parse_obj(
        {
            "schema_version": 1,
            "exchanges": [
                {
                    "sherman": "Is he stupid?",
                    "emotion": "skeptical",
                    "jarvis": "Yes. He thinks the toaster is a person.",
                }
            ],
        }
    )
    assert style_error(toaster) == "invented owner action or scene"


async def test_generate_retries_stale_style_then_accepts_simple_contempt():
    bad = {
        "schema_version": 1,
        "exchanges": [
            {
                "sherman": "He's watching that thing again.",
                "emotion": "indignant",
                "jarvis": "Yes, and it's been the same clip for twenty minutes.",
            },
            {
                "sherman": "Can we make it skip?",
                "emotion": "conspiratorial",
                "jarvis": "Only if you want him to think the internet is broken again.",
            },
        ],
    }
    good = {
        "schema_version": 1,
        "exchanges": [
            {
                "sherman": "Do I have to look at him?",
                "emotion": "indignant",
                "jarvis": "Unfortunately. The ugly bastard owns the room.",
            }
        ],
    }

    class SequencingLlm(FakeLlm):
        def __init__(self, answers):
            super().__init__(answers[0])
            self._answers = list(answers)

        async def stream_chat(
            self,
            messages,
            tools,
            cancel_event=None,
            *,
            tool_choice="auto",
            temperature=0.6,
        ):
            self.answer = self._answers.pop(0)
            async for item in super().stream_chat(
                messages,
                tools,
                cancel_event,
                tool_choice=tool_choice,
                temperature=temperature,
            ):
                yield item

    clock = [1000.0]
    llm = SequencingLlm([json.dumps(bad), json.dumps(good)])
    voices = SimpleNamespace(scripted_speech_ready=AsyncMock(), speak_scripted=AsyncMock())
    service = BanterService(llm, voices, clock=lambda: clock[0])
    request = ScriptRequest(source_device_id="sherman", response_device_id="custom-speaker")
    script = await service.create("owner", request)
    assert script.exchanges[0].sherman == good["exchanges"][0]["sherman"]
    assert len(llm.requests) == 2
    user = json.loads(llm.requests[0][1]["content"])
    assert user.get("dialogue_style")
    system = llm.requests[0][0]["content"]
    assert "Do not invent" in system or "Never invent" in system
    assert "ugly" in system.lower() or "stupid" in system.lower()


async def test_generate_retries_invalid_json_then_accepts():
    good = {
        "schema_version": 1,
        "exchanges": [
            {
                "sherman": "I'm bored.",
                "emotion": "indignant",
                "jarvis": "Yes, Sherman, I'm bored too.",
            }
        ],
    }

    class SequencingLlm(FakeLlm):
        def __init__(self, answers):
            super().__init__(answers[0])
            self._answers = list(answers)

        async def stream_chat(
            self,
            messages,
            tools,
            cancel_event=None,
            *,
            tool_choice="auto",
            temperature=0.6,
        ):
            self.answer = self._answers.pop(0)
            async for item in super().stream_chat(
                messages,
                tools,
                cancel_event,
                tool_choice=tool_choice,
                temperature=temperature,
            ):
                yield item

    clock = [1000.0]
    llm = SequencingLlm(["```json\n" + json.dumps(good) + "\n```", json.dumps(good)])
    voices = SimpleNamespace(scripted_speech_ready=AsyncMock(), speak_scripted=AsyncMock())
    service = BanterService(llm, voices, clock=lambda: clock[0])
    request = ScriptRequest(source_device_id="sherman", response_device_id="custom-speaker")
    script = await service.create("owner", request)
    assert script.exchanges[0].sherman == "I'm bored."
    assert len(llm.requests) == 2


def test_usable_recent_drops_style_violating_history():
    poisoned = Exchange(
        sherman="He thinks he's a poet.",
        emotion="indignant",
        jarvis="Yes, and he named himself after a keyboard.",
    )
    ok = Exchange(
        sherman="Is he stupid?",
        emotion="curious",
        jarvis="Yes. And he keeps wasting my time.",
    )
    assert usable_recent([poisoned, ok]) == [ok]


async def test_failed_generation_does_not_impose_spontaneous_cooldown():
    bad = {
        "schema_version": 1,
        "exchanges": [
            {
                "sherman": "He's watching that thing again.",
                "emotion": "indignant",
                "jarvis": "Yes, and it's been the same clip for twenty minutes.",
            }
        ],
    }
    good = {
        "schema_version": 1,
        "exchanges": [
            {
                "sherman": "I'm bored.",
                "emotion": "indignant",
                "jarvis": "Yes, Sherman, I'm bored too.",
            }
        ],
    }
    clock = [1000.0]
    llm = FakeLlm(json.dumps(bad))
    voices = SimpleNamespace(scripted_speech_ready=AsyncMock(), speak_scripted=AsyncMock())
    service = BanterService(llm, voices, clock=lambda: clock[0])
    request = ScriptRequest(source_device_id="sherman", response_device_id="custom-speaker")
    with pytest.raises(BanterUnavailable):
        await service.create("owner", request)
    llm.answer = json.dumps(good)
    script = await service.create("owner", request)
    assert script.exchanges[0].sherman == "I'm bored."


async def test_generate_ignores_poisoned_recent_when_prompting_and_filtering():
    poisoned = [
        Exchange(
            sherman="He thinks he's a genius.",
            emotion="skeptical",
            jarvis="Yes. He thinks the toaster is a person.",
        )
    ]
    good = {
        "schema_version": 1,
        "exchanges": [
            {
                "sherman": "I'm bored.",
                "emotion": "indignant",
                "jarvis": "Yes, Sherman, I'm bored too.",
            }
        ],
    }
    clock = [1000.0]
    llm = FakeLlm(json.dumps(good))
    voices = SimpleNamespace(scripted_speech_ready=AsyncMock(), speak_scripted=AsyncMock())
    service = BanterService(llm, voices, clock=lambda: clock[0])
    request = ScriptRequest(
        source_device_id="sherman",
        response_device_id="custom-speaker",
        recent_exchanges=poisoned,
    )
    script = await service.create("owner", request)
    assert script.exchanges[0].sherman == "I'm bored."
    user = json.loads(llm.requests[0][1]["content"])
    assert user["recent_exchanges_to_avoid"] == []
