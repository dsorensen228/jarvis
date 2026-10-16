"""Persist task recipients and deliver terminal alerts without a connected app."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from jarvis_api.code_factory import CodeFactoryError
from jarvis_api.domain import utc_now
from jarvis_api.push import ANDROID_TASK_CHANNEL_ID, android_tokens, record_delivery, token_key

logger = logging.getLogger(__name__)
TERMINAL_STATUSES = {"success", "failed", "cancelled"}


class TaskNotificationService:
    def __init__(self, store: Any, factory: Any, push: Any, poll_seconds: float = 15) -> None:
        self.store, self.factory, self.push = store, factory, push
        self.poll_seconds = poll_seconds
        self._task: Optional[asyncio.Task] = None
        self._tracking_lock = asyncio.Lock()
        self._tick_lock = asyncio.Lock()

    async def track(
        self, user_id: str, task: Dict[str, Any], task_type: str, *, created: bool = False
    ) -> None:
        # Reading old history must not send a new completion notification.
        if not created and task.get("status") in TERMINAL_STATUSES:
            return
        key = hashlib.sha256(f"{user_id}:{task_type}:{task['id']}".encode()).hexdigest()
        async with self._tracking_lock:
            if await self.store.get_entity("task_notification", key, user_id):
                return
            await self.store.create_entity(
                "task_notification",
                user_id,
                {
                    "task_id": task["id"],
                    "task_type": task_type,
                    "status": "pending",
                    "accepted_token_ids": [],
                    "accepted_token_keys": [],
                },
                entity_id=key,
            )

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self.poll_seconds)
            try:
                await self.tick()
            except Exception:
                logger.exception("Notification monitor tick failed")

    async def tick(self) -> None:
        async with self._tick_lock:
            for row in await self.store.list_all_entities("task_notification", status="pending"):
                try:
                    await self._task_notification(row)
                except Exception as exc:
                    logger.warning("Task notification deferred (%s)", type(exc).__name__)
                    # Rotate failed/active rows so a busy queue cannot starve older work.
                    await self.store.update_entity(
                        "task_notification",
                        row["id"],
                        row["owner_id"],
                        {
                            "last_error": type(exc).__name__,
                        },
                    )
            await self._receipts()

    async def _task_notification(self, row: Dict[str, Any]) -> None:
        owner = row["owner_id"]
        patch: Dict[str, Any] = {"checked_at": utc_now().isoformat()}
        if row.get("retry_after") and datetime.fromisoformat(row["retry_after"]) > utc_now():
            await self.store.update_entity("task_notification", row["id"], owner, patch)
            return
        try:
            get_task = (
                self.factory.get_research_task
                if row["task_type"] == "research"
                else self.factory.get_task
            )
            task = row.get("terminal_task") or await get_task(row["task_id"])
        except CodeFactoryError as exc:
            if exc.status_code != 404:
                raise
            patch.update(status="complete", reason="task_removed")
        else:
            task_status = task.get("status")
            if task_status == "cancelled":
                patch.update(status="complete", reason="cancelled")
            elif task_status in {"success", "failed"}:
                patch["terminal_task"] = {
                    "id": task["id"],
                    "status": task_status,
                    "prompt": " ".join(str(task.get("prompt") or "").split())[:180],
                }
                accepted = set(row.get("accepted_token_ids", []))
                accepted_keys = set(row.get("accepted_token_keys", []))
                tokens = android_tokens(await self.store.list_entities("push_token", owner, 1000))
                targets = [token for token in tokens if token_key(token) not in accepted_keys]
                if not targets and accepted:
                    patch["status"] = "complete"
                else:
                    kind = row["task_type"]
                    status = "completed" if task_status == "success" else "failed"
                    label = "Research" if kind == "research" else "Coding"
                    result = await self.push.send(
                        tokens=targets,
                        title=f"{label} task {status}",
                        body=" ".join(str(task.get("prompt") or f"{label} task").split())[:180],
                        data={"type": f"{kind}_task", "task_id": task["id"], "status": status},
                        channel_id=ANDROID_TASK_CHANNEL_ID,
                    )
                    result = await record_delivery(
                        self.store,
                        owner,
                        result,
                        source_kind="task_notification",
                        source_id=row["id"],
                    )
                    accepted.update(receipt["token_id"] for receipt in result.get("receipts", []))
                    accepted_keys.update(
                        receipt["token_key"] for receipt in result.get("receipts", [])
                    )
                    previous = row.get("mobile_push", {})
                    result["receipts"] = previous.get("receipts", []) + result.get("receipts", [])
                    result["receipt_results"] = previous.get("receipt_results", {})
                    patch.update(
                        mobile_push=result,
                        accepted_token_ids=sorted(accepted),
                        accepted_token_keys=sorted(accepted_keys),
                    )
                    if result["status"] == "accepted":
                        patch["status"] = "complete"
        await self.store.update_entity("task_notification", row["id"], owner, patch)

    async def _receipts(self) -> None:
        rows = await self.store.list_all_entities("push_receipt", status="pending")
        due = [row for row in rows if datetime.fromisoformat(row["check_after"]) <= utc_now()]
        for start in range(0, len(due), 1000):
            batch = due[start : start + 1000]
            try:
                results = await self.push.receipts([row["id"] for row in batch])
            except Exception as exc:
                logger.warning("Expo receipt check deferred (%s)", type(exc).__name__)
                return
            for row in batch:
                result = results.get(row["id"])
                if result is None:
                    if datetime.fromisoformat(row["created_at"]) > utc_now() - timedelta(hours=24):
                        await self.store.update_entity(
                            "push_receipt",
                            row["id"],
                            row["owner_id"],
                            {
                                "check_after": (utc_now() + timedelta(minutes=15)).isoformat(),
                            },
                        )
                        continue
                    result = {"status": "error", "error": "ReceiptUnavailable"}
                await self.store.update_entity("push_receipt", row["id"], row["owner_id"], result)
                if result.get("error") == "DeviceNotRegistered" and row.get("token_id"):
                    await self.store.delete_entity("push_token", row["token_id"], row["owner_id"])
                await self._record_receipt(row, result)

    async def _record_receipt(self, row: Dict[str, Any], result: Dict[str, Any]) -> None:
        def update(source):
            delivery = dict(source.get("mobile_push", {}))
            outcomes = dict(delivery.get("receipt_results", {}))
            outcomes[row["id"]] = result
            delivery["receipt_results"] = outcomes
            delivery["receipt_status"] = (
                "error"
                if any(item["status"] == "error" for item in outcomes.values())
                else "delivered"
                if len(outcomes) == len(delivery.get("receipts", []))
                else "pending"
            )
            updated = {**source, "mobile_push": delivery}
            if row["source_kind"] == "task_notification" and result.get("error") in {
                "InvalidCredentials",
                "MessageRateExceeded",
                "MismatchSenderId",
            }:
                attempts = source.get("retry_attempts", 0) + 1
                updated.update(
                    status="pending",
                    retry_attempts=attempts,
                    retry_after=(
                        utc_now() + timedelta(seconds=min(3600, 30 * 2 ** min(attempts - 1, 7)))
                    ).isoformat(),
                    accepted_token_ids=[
                        token_id
                        for token_id in source.get("accepted_token_ids", [])
                        if token_id != row.get("token_id")
                    ],
                    accepted_token_keys=[
                        key
                        for key in source.get("accepted_token_keys", [])
                        if key != row.get("token_key")
                    ],
                )
                # The failed receipt remains in push_receipt for diagnosis; current delivery
                # now waits for a replacement receipt for this token.
                delivery["receipts"] = [
                    receipt
                    for receipt in delivery.get("receipts", [])
                    if receipt["id"] != row["id"]
                ]
                delivery["receipt_results"].pop(row["id"], None)
                delivery["receipt_status"] = "retry_pending"
                delivery["last_receipt_error"] = result["error"]
            return updated

        await self.store.mutate_entity(
            row["source_kind"], row["source_id"], row["owner_id"], update
        )
        if result["status"] == "error":
            logger.warning("Expo provider rejected notification (%s)", result["error"])
