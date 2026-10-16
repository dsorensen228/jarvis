#!/usr/bin/env python3
"""Exercise the deployed ASR -> LLM -> TTS WebSocket and remove its test conversation."""

from __future__ import annotations

import asyncio
import audioop
import json
import os
from typing import Any, Dict, List, Optional

import httpx
import websockets


async def probe() -> Dict[str, Any]:
    username = os.environ["JARVIS_BOOTSTRAP_USERNAME"]
    password = os.environ["JARVIS_BOOTSTRAP_PASSWORD"]
    api_url = os.environ.get("JARVIS_PROBE_API_URL", "http://127.0.0.1:8000")
    websocket_url = (
        api_url.replace("http://", "ws://", 1).replace("https://", "wss://", 1) + "/v1/voice"
    )

    async with httpx.AsyncClient(timeout=120.0) as client:
        token_response = await client.post(
            api_url + "/v1/auth/token",
            json={"username": username, "password": password},
        )
        token_response.raise_for_status()
        token = token_response.json()["access_token"]
        tts_response = await client.post(
            "http://127.0.0.1:8092/v1/synthesize",
            json={"text": "Please answer with only the word ready."},
        )
        tts_response.raise_for_status()
        source_rate = int(tts_response.headers["x-sample-rate"])
        pcm, _ = audioop.ratecv(tts_response.content, 2, 1, source_rate, 16000, None)

        events: List[str] = []
        transcript = ""
        output_bytes = 0
        conversation_id: Optional[str] = None
        reset_confirmed = False
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
                        "device_id": "codex-live-probe",
                        "conversation_id": None,
                        "audio": {
                            "encoding": "pcm_s16le",
                            "sample_rate": 16000,
                            "channels": 1,
                        },
                    }
                )
            )
            configured = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
            if configured.get("data", {}).get("device_id") != "codex-live-probe":
                raise RuntimeError("device identity was not acknowledged")
            for offset in range(0, len(pcm), 2560):
                await websocket.send(pcm[offset : offset + 2560])
            await websocket.send(json.dumps({"type": "turn.end"}))

            while True:
                message = await asyncio.wait_for(websocket.recv(), timeout=180)
                if isinstance(message, bytes):
                    output_bytes += len(message)
                    continue
                payload = json.loads(message)
                event = str(payload.get("type") or "")
                events.append(event)
                data = payload.get("data") or {}
                if event == "transcription.final":
                    transcript = str(data.get("text") or "")
                if data.get("conversation_id"):
                    conversation_id = str(data["conversation_id"])
                if event == "turn.done":
                    break

            await websocket.send(json.dumps({"type": "session.configure", "conversation_id": None}))
            reset = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
            reset_confirmed = (
                reset.get("type") == "session.configured"
                and reset.get("data", {}).get("conversation_id") is None
            )

        deleted = False
        if conversation_id:
            response = await client.delete(
                api_url + "/v1/conversations/" + conversation_id,
                headers={"Authorization": "Bearer " + token},
            )
            deleted = response.status_code == 204

    required = {
        "transcription.final",
        "response.text.delta",
        "response.audio.started",
        "response.audio.done",
        "turn.done",
    }
    if not required.issubset(set(events)):
        raise RuntimeError("voice pipeline omitted events: " + repr(required - set(events)))
    if not transcript or output_bytes <= 0 or not reset_confirmed or not deleted:
        raise RuntimeError("voice pipeline probe did not complete cleanly")
    return {
        "ok": True,
        "transcript": transcript,
        "events": sorted(set(events)),
        "output_pcm_bytes": output_bytes,
        "conversation_deleted": deleted,
        "conversation_reset": reset_confirmed,
    }


def main() -> None:
    print(json.dumps(asyncio.run(probe()), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
