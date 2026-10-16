from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from jarvis_api.push import (
    ANDROID_CAMERA_PERSON_CHANNEL_ID,
    PERSON_DETECTED_PUSH_TYPE,
    ExpoPushClient,
    person_detected_messages,
)


class FakeResponse:
    def __init__(self, status_code: int = 200, payload: Optional[Dict[str, Any]] = None) -> None:
        self.status_code = status_code
        self._payload = payload or {"data": [{"status": "ok"}]}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self) -> Dict[str, Any]:
        return self._payload


class FakeHttpClient:
    def __init__(self) -> None:
        self.posts: List[Dict[str, Any]] = []

    async def post(self, url: str, json: Dict[str, Any]) -> FakeResponse:
        self.posts.append({"url": url, "json": json})
        return FakeResponse(
            payload={
                "data": [
                    {"status": "ok", "id": f"ticket-{len(self.posts)}-{i}"}
                    for i in range(len(json))
                ]
            }
        )


@pytest.mark.asyncio
async def test_person_detected_messages_use_android_channel_and_type() -> None:
    messages = person_detected_messages(
        tokens=[
            {"token": "ExponentPushToken[android]", "platform": "android"},
            {"token": "ExponentPushToken[ios]", "platform": "ios"},
            {"token": "ExponentPushToken[web]", "platform": "web"},
            {"token": "", "platform": "android"},
        ],
        title="Jarvis",
        body="Someone's at the side door.",
        data={
            "type": PERSON_DETECTED_PUSH_TYPE,
            "device_id": "camera-two",
            "event_id": "evt-1",
        },
    )
    assert len(messages) == 1
    message = messages[0]
    assert message["to"] == "ExponentPushToken[android]"
    assert message["title"] == "Jarvis"
    assert message["body"] == "Someone's at the side door."
    assert message["sound"] == "default"
    assert message["priority"] == "high"
    assert message["channelId"] == ANDROID_CAMERA_PERSON_CHANNEL_ID
    assert message["data"]["type"] == PERSON_DETECTED_PUSH_TYPE
    assert message["data"]["device_id"] == "camera-two"


@pytest.mark.asyncio
async def test_expo_push_client_posts_messages_in_batches() -> None:
    http = FakeHttpClient()
    client = ExpoPushClient(http)  # type: ignore[arg-type]
    tokens = [{"token": f"ExponentPushToken[{i}]", "platform": "android"} for i in range(101)]
    result = await client.send_person_detected(
        tokens=tokens,
        body="Someone's at the front door.",
        data={"type": PERSON_DETECTED_PUSH_TYPE, "device_id": "doorbell-camera", "event_id": "e2"},
    )
    assert result["status"] == "accepted"
    assert result["token_count"] == 101
    assert len(http.posts) == 2
    assert http.posts[0]["url"] == "https://exp.host/--/api/v2/push/send"
    assert len(http.posts[0]["json"]) == 100
    assert len(http.posts[1]["json"]) == 1


@pytest.mark.asyncio
async def test_expo_push_client_reports_no_targets_without_posting() -> None:
    http = FakeHttpClient()
    client = ExpoPushClient(http)  # type: ignore[arg-type]
    result = await client.send_person_detected(
        tokens=[{"token": "ExponentPushToken[ios]", "platform": "ios"}],
        body="Someone's at the door.",
        data={"type": PERSON_DETECTED_PUSH_TYPE},
    )
    assert result == {"status": "no_android_targets", "token_count": 0}
    assert http.posts == []


@pytest.mark.asyncio
async def test_http_200_ticket_rejection_is_not_reported_as_sent():
    import httpx

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "status": "error",
                            "message": "secret token",
                            "details": {"error": "DeviceNotRegistered"},
                        }
                    ]
                },
            )
        )
    ) as http:
        result = await ExpoPushClient(http).send_person_detected(
            tokens=[{"id": "stale", "token": "ExponentPushToken[secret]", "platform": "android"}],
            body="Someone's at the door.",
            data={},
        )
    assert result["status"] == "error"
    assert result["invalid_token_ids"] == ["stale"]
    assert result["errors"] == ["DeviceNotRegistered"]
    assert "secret" not in str(result)


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{"data": []}, {"data": [{"status": "ok"}]}])
async def test_missing_ticket_ids_are_not_reported_as_accepted(payload):
    import httpx

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    ) as http:
        result = await ExpoPushClient(http).send_person_detected(
            tokens=[{"token": "ExponentPushToken[one]", "platform": "android"}],
            body="At the door",
            data={},
        )
    assert result["status"] == "error"
