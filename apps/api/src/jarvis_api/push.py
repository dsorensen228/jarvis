"""Android Expo alerts with validated tickets and durable provider receipts."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import timedelta
from typing import Any, Dict, List, Mapping, Sequence

import httpx

from jarvis_api.domain import utc_now

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
EXPO_PUSH_BATCH_SIZE = 100
ANDROID_CAMERA_PERSON_CHANNEL_ID = "camera-person"
ANDROID_TASK_CHANNEL_ID = "task-status"
PERSON_DETECTED_PUSH_TYPE = "person_detected"
DEFAULT_PERSON_PUSH_TITLE = "Jarvis"
# Store codes, never provider messages: Expo error text can contain the push token.
EXPO_ERRORS = {
    "DeviceNotRegistered",
    "MessageTooBig",
    "MessageRateExceeded",
    "MismatchSenderId",
    "InvalidCredentials",
    "UNAUTHORIZED",
    "PUSH_TOO_MANY_EXPERIENCE_IDS",
    "PUSH_TOO_MANY_NOTIFICATIONS",
    "VALIDATION_ERROR",
}


def _error_code(ticket: Mapping[str, Any]) -> str:
    details = ticket.get("details")
    code = details.get("error") if isinstance(details, dict) else ticket.get("code")
    return code if isinstance(code, str) and code in EXPO_ERRORS else "PushRejected"


def android_tokens(tokens: Sequence[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
    result = []
    seen = set()
    for row in tokens:
        token = str(row.get("token") or "").strip()
        if (
            token
            and token not in seen
            and str(row.get("platform") or "").lower() == "android"
            and row.get("provider", "expo") == "expo"
        ):
            result.append(row)
            seen.add(token)
    return result


def token_key(row: Mapping[str, Any]) -> str:
    return hashlib.sha256(str(row["token"]).strip().encode()).hexdigest()


def person_detected_messages(
    *, tokens: Sequence[Mapping[str, Any]], title: str, body: str, data: Mapping[str, Any]
) -> List[Dict[str, Any]]:
    return _messages(tokens, title, body, data, ANDROID_CAMERA_PERSON_CHANNEL_ID)


def _messages(tokens, title, body, data, channel_id):
    return [
        {
            "to": str(row["token"]).strip(),
            "title": title,
            "body": body,
            "sound": "default",
            "priority": "high",
            "channelId": channel_id,
            "data": dict(data),
        }
        for row in android_tokens(tokens)
    ]


class ExpoPushClient:
    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self._http = http_client

    async def _post(self, url: str, payload: Any) -> Any:
        for attempt in range(3):
            try:
                response = await self._http.post(url, json=payload)
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as exc:
                if attempt == 2 or (
                    exc.response.status_code != 429 and exc.response.status_code < 500
                ):
                    raise
            except httpx.TransportError:
                if attempt == 2:
                    raise
            await asyncio.sleep(2**attempt)

    async def send_person_detected(
        self,
        *,
        tokens: Sequence[Mapping[str, Any]],
        body: str,
        data: Mapping[str, Any],
        title: str = DEFAULT_PERSON_PUSH_TITLE,
    ) -> Dict[str, Any]:
        return await self.send(
            tokens=tokens,
            body=body,
            data=data,
            title=title,
            channel_id=ANDROID_CAMERA_PERSON_CHANNEL_ID,
        )

    async def send(
        self,
        *,
        tokens: Sequence[Mapping[str, Any]],
        title: str,
        body: str,
        data: Mapping[str, Any],
        channel_id: str,
    ) -> Dict[str, Any]:
        targets = android_tokens(tokens)
        messages = _messages(targets, title, body, data, channel_id)
        if not messages:
            return {"status": "no_android_targets", "token_count": 0}
        receipts, errors, invalid_ids = [], [], []
        for start in range(0, len(messages), EXPO_PUSH_BATCH_SIZE):
            batch = messages[start : start + EXPO_PUSH_BATCH_SIZE]
            try:
                payload = await self._post(EXPO_PUSH_URL, batch)
                tickets = payload.get("data") if isinstance(payload, dict) else None
                if not isinstance(tickets, list) or len(tickets) != len(batch):
                    errors.append("InvalidPushResponse")
                    continue
                for row, ticket in zip(targets[start : start + len(batch)], tickets):
                    if not isinstance(ticket, dict):
                        errors.append("InvalidPushResponse")
                    elif (
                        ticket.get("status") == "ok"
                        and isinstance(ticket.get("id"), str)
                        and ticket["id"]
                    ):
                        receipts.append(
                            {
                                "id": ticket["id"],
                                "token_id": row.get("id"),
                                "token_key": token_key(row),
                            }
                        )
                    else:
                        code = _error_code(ticket)
                        errors.append(code)
                        if code == "DeviceNotRegistered" and row.get("id"):
                            invalid_ids.append(row["id"])
            except Exception as exc:
                # Exception strings can include provider response content; only log the class.
                code = type(exc).__name__
                logger.warning("Expo push request failed (%s)", code)
                errors.append(code)
        result = {
            "status": "partial" if receipts and errors else "error" if errors else "accepted",
            "token_count": len(messages),
            "accepted_count": len(receipts),
            "receipts": receipts,
            "invalid_token_ids": invalid_ids,
            "errors": sorted(set(errors)),
        }
        if errors:
            logger.warning("Expo rejected push delivery: %s", ", ".join(result["errors"]))
        return result

    async def receipts(self, ids: Sequence[str]) -> Dict[str, Any]:
        payload = await self._post(EXPO_RECEIPTS_URL, {"ids": list(ids)})
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            raise ValueError("Invalid Expo receipt response")
        return {
            receipt_id: {
                "status": "delivered" if receipt.get("status") == "ok" else "error",
                "error": "" if receipt.get("status") == "ok" else _error_code(receipt),
            }
            for receipt_id, receipt in data.items()
            if isinstance(receipt, dict)
        }


async def record_delivery(
    store: Any,
    user_id: str,
    result: Dict[str, Any],
    *,
    source_kind: str,
    source_id: str,
) -> Dict[str, Any]:
    for token_id in result.get("invalid_token_ids", []):
        await store.delete_entity("push_token", token_id, user_id)
    for receipt in result.get("receipts", []):
        await store.create_entity(
            "push_receipt",
            user_id,
            {
                "token_id": receipt.get("token_id"),
                "token_key": receipt.get("token_key"),
                "source_kind": source_kind,
                "source_id": source_id,
                "check_after": (utc_now() + timedelta(minutes=15)).isoformat(),
                "status": "pending",
            },
            entity_id=receipt["id"],
        )
    return dict(result)


async def notify_person_detected(
    *,
    store: Any,
    push_client: ExpoPushClient,
    user_id: str,
    device_id: str,
    event_id: str,
    alert_text: str,
) -> Dict[str, Any]:
    rows = await store.list_entities("push_token", user_id, limit=1000)
    result = await push_client.send_person_detected(
        tokens=rows,
        body=alert_text,
        data={"type": PERSON_DETECTED_PUSH_TYPE, "device_id": device_id, "event_id": event_id},
    )
    return await record_delivery(
        store, user_id, result, source_kind="camera_event", source_id=event_id
    )
