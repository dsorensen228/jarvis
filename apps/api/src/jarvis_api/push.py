"""Expo push delivery for Android camera person-detection alerts."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, MutableMapping, Sequence

import httpx

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_PUSH_BATCH_SIZE = 100
ANDROID_CAMERA_PERSON_CHANNEL_ID = "camera-person"
PERSON_DETECTED_PUSH_TYPE = "person_detected"
DEFAULT_PERSON_PUSH_TITLE = "Jarvis"


def person_detected_messages(
    *,
    tokens: Sequence[Mapping[str, Any]],
    title: str,
    body: str,
    data: Mapping[str, Any],
) -> List[Dict[str, Any]]:
    """Build Expo push messages for Android tokens only."""
    messages: List[Dict[str, Any]] = []
    for row in tokens:
        token = str(row.get("token") or "").strip()
        platform = str(row.get("platform") or "").strip().lower()
        if not token or platform != "android":
            continue
        messages.append(
            {
                "to": token,
                "title": title,
                "body": body,
                "sound": "default",
                "priority": "high",
                "channelId": ANDROID_CAMERA_PERSON_CHANNEL_ID,
                "data": dict(data),
            }
        )
    return messages


class ExpoPushClient:
    """Thin Expo push HTTP client used by camera person-detection alerts."""

    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self._http = http_client

    async def send_person_detected(
        self,
        *,
        tokens: Sequence[Mapping[str, Any]],
        body: str,
        data: Mapping[str, Any],
        title: str = DEFAULT_PERSON_PUSH_TITLE,
    ) -> Dict[str, Any]:
        messages = person_detected_messages(tokens=tokens, title=title, body=body, data=data)
        if not messages:
            return {"status": "no_android_targets", "token_count": 0}

        try:
            for start in range(0, len(messages), EXPO_PUSH_BATCH_SIZE):
                batch = messages[start : start + EXPO_PUSH_BATCH_SIZE]
                response = await self._http.post(EXPO_PUSH_URL, json=batch)
                response.raise_for_status()
        except Exception as exc:
            logger.warning("expo person-detected push failed: %s", exc)
            return {
                "status": "error",
                "token_count": len(messages),
                "detail": str(exc)[:500],
            }

        return {"status": "sent", "token_count": len(messages)}


async def notify_person_detected(
    *,
    store: Any,
    push_client: ExpoPushClient,
    user_id: str,
    device_id: str,
    event_id: str,
    alert_text: str,
) -> Dict[str, Any]:
    """Load the owner's Expo tokens and deliver an Android person-detected push."""
    rows = await store.list_entities("push_token", user_id, limit=1000)
    payload: MutableMapping[str, Any] = {
        "type": PERSON_DETECTED_PUSH_TYPE,
        "device_id": device_id,
        "event_id": event_id,
    }
    result = await push_client.send_person_detected(
        tokens=rows,
        body=alert_text,
        data=payload,
    )
    return dict(result)
