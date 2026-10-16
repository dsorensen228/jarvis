"""Authenticated API gateway client for the LAN-only Code Factory service."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx


class CodeFactoryError(RuntimeError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class CodeFactoryClient:
    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout_seconds),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def create_task(self, prompt: str, model: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"prompt": prompt}
        if model:
            payload["model"] = model
        return await self._request(
            "POST",
            "/v1/tasks",
            json=payload,
        )

    async def list_tasks(
        self, limit: int, task_status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {"limit": limit}
        if task_status:
            params["status"] = task_status
        result = await self._request("GET", "/v1/tasks", params=params)
        if not isinstance(result, list):
            raise CodeFactoryError(502, "Code Factory returned an invalid task list")
        return result

    async def get_task(self, task_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/v1/tasks/{task_id}")

    async def cancel_task(self, task_id: str) -> Dict[str, Any]:
        return await self._request("POST", f"/v1/tasks/{task_id}/cancel")

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise CodeFactoryError(504, "Code Factory request timed out") from exc
        except httpx.HTTPError as exc:
            raise CodeFactoryError(502, "Code Factory is unavailable") from exc

        if response.is_error:
            detail = "Code Factory request failed"
            try:
                payload = response.json()
                if isinstance(payload, dict) and payload.get("detail"):
                    detail = str(payload["detail"])
            except ValueError:
                pass
            status_code = response.status_code if response.status_code < 500 else 502
            raise CodeFactoryError(status_code, detail)
        try:
            return response.json()
        except ValueError as exc:
            raise CodeFactoryError(502, "Code Factory returned invalid JSON") from exc
