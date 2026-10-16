#!/usr/bin/env python3
"""Exercise deployed voice tool selection without changing a physical device."""

from __future__ import annotations

import asyncio
import audioop
import json
import os
from typing import Any, Dict, List, Optional

import httpx
import websockets


async def synthesize(client: httpx.AsyncClient, text: str) -> bytes:
    response = await client.post("http://127.0.0.1:8092/v1/synthesize", json={"text": text})
    response.raise_for_status()
    source_rate = int(response.headers["x-sample-rate"])
    pcm, _ = audioop.ratecv(response.content, 2, 1, source_rate, 16000, None)
    return pcm


async def run_case(
    token: str,
    api_url: str,
    pcm: bytes,
    expected_action: Optional[str] = None,
    expect_end: bool = True,
    failing_action: Optional[str] = None,
) -> Dict[str, Any]:
    websocket_url = (
        api_url.replace("http://", "ws://", 1).replace("https://", "wss://", 1) + "/v1/voice"
    )
    actions: List[str] = []
    events: List[str] = []
    conversation_id: Optional[str] = None
    transcript = ""
    response_text = ""
    async with websockets.connect(
        websocket_url,
        extra_headers={"Authorization": "Bearer " + token},
        max_size=None,
        ping_interval=20,
    ) as websocket:
        ready = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
        if ready.get("type") != "session.ready":
            raise RuntimeError("voice socket did not become ready")
        await websocket.send(
            json.dumps(
                {
                    "type": "session.configure",
                    "device_id": "codex-tool-probe",
                    "conversation_id": None,
                    "personality_level": 3,
                    "audio": {
                        "encoding": "pcm_s16le",
                        "sample_rate": 16000,
                        "channels": 1,
                    },
                }
            )
        )
        await asyncio.wait_for(websocket.recv(), timeout=10)
        for offset in range(0, len(pcm), 2560):
            await websocket.send(pcm[offset : offset + 2560])
        await websocket.send(json.dumps({"type": "turn.end"}))

        while True:
            message = await asyncio.wait_for(websocket.recv(), timeout=180)
            if isinstance(message, bytes):
                continue
            payload = json.loads(message)
            event = str(payload.get("type") or "")
            data = payload.get("data") or {}
            events.append(event)
            if event == "transcription.final":
                transcript = str(data.get("text") or "")
            if event == "response.text.delta":
                response_text += str(data.get("text") or "")
            if data.get("conversation_id"):
                conversation_id = str(data["conversation_id"])
            if event == "device.action":
                action = str(data.get("action") or "")
                actions.append(action)
                result: Any = {"ok": True}
                if action == "spotify_search":
                    result = {
                        "items": [
                            {
                                "name": "Here Comes the Sun",
                                "subtitle": "The Beatles",
                                "kind": "track",
                                "uri": "spotify:track:probe",
                            }
                        ]
                    }
                device_result = {
                    "type": "device.action.result",
                    "request_id": data["request_id"],
                }
                if action == failing_action:
                    device_result["error"] = "simulated device failure"
                else:
                    device_result["result"] = result
                await websocket.send(json.dumps(device_result))
            if event in {"turn.done", "session.ended"}:
                terminal = event
                break

    if expected_action and expected_action not in actions:
        raise RuntimeError(
            f"expected action {expected_action!r}, got {actions!r}; transcript={transcript!r}"
        )
    if expect_end and terminal != "session.ended":
        raise RuntimeError("voice turn did not end its session: " + repr(events))
    return {
        "transcript": transcript,
        "actions": actions,
        "terminal_event": terminal,
        "conversation_id": conversation_id,
        "response_text": response_text,
    }


async def main_async() -> Dict[str, Any]:
    api_url = os.environ.get("JARVIS_PROBE_API_URL", "http://127.0.0.1:8000")
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            api_url + "/v1/auth/token",
            json={
                "username": os.environ["JARVIS_BOOTSTRAP_USERNAME"],
                "password": os.environ["JARVIS_BOOTSTRAP_PASSWORD"],
            },
        )
        response.raise_for_status()
        token = response.json()["access_token"]
        cases = [
            (
                "navigation",
                await synthesize(client, "Open the Spotify tab."),
                "navigate_device_ui",
                True,
                None,
            ),
            (
                "browser_close",
                await synthesize(client, "Close the Netflix tab."),
                "close_browser",
                True,
                None,
            ),
            (
                "spotify_play",
                await synthesize(client, "Play Here Comes the Sun by the Beatles."),
                "spotify_play_best_match",
                True,
                None,
            ),
            ("goodbye", await synthesize(client, "Goodbye Jarvis."), None, True, None),
            ("dismissal_done", await synthesize(client, "We're done."), None, True, None),
            (
                "dismissal_thats_all",
                await synthesize(client, "That's all, thank you."),
                None,
                True,
                None,
            ),
            (
                "dismissal_inside_request",
                await synthesize(client, "I'm done with work, what should I make for dinner?"),
                None,
                False,
                None,
            ),
            (
                "tool_failure",
                await synthesize(client, "Close Patreon."),
                "close_browser",
                True,
                "close_browser",
            ),
            (
                "personality",
                await synthesize(client, "What is two plus two?"),
                None,
                False,
                None,
            ),
        ]
        results = {}
        conversation_ids = []
        for name, pcm, expected_action, expect_end, failing_action in cases:
            result = await run_case(
                token,
                api_url,
                pcm,
                expected_action,
                expect_end=expect_end,
                failing_action=failing_action,
            )
            results[name] = result
            if result["conversation_id"]:
                conversation_ids.append(result["conversation_id"])
        if "couldn't close the browser" not in results["tool_failure"]["response_text"].casefold():
            raise RuntimeError(
                "failed device tool was not reported clearly: "
                + repr(results["tool_failure"]["response_text"])
            )
        for name, result in results.items():
            spoken = result["response_text"].casefold()
            if "end voice session" in spoken or "end_voice_session" in spoken:
                raise RuntimeError(
                    "case " + name + " spoke the exit tool instead of calling it: " + repr(spoken)
                )
        for conversation_id in conversation_ids:
            await client.delete(
                api_url + "/v1/conversations/" + conversation_id,
                headers={"Authorization": "Bearer " + token},
            )
        return {"ok": True, "cases": results}


def main() -> None:
    print(json.dumps(asyncio.run(main_async()), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
