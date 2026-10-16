"""Authenticated API gateway client for the LAN-only Code Factory service."""

from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import quote

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

    async def create_task(self, prompt: str, model: str) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"prompt": prompt, "model": model}
        return await self._request(
            "POST",
            "/v1/tasks",
            json=payload,
        )

    async def list_tasks(
        self,
        limit: int,
        task_status: Optional[str] = None,
        cursor: Optional[str] = None,
        view: str = "all",
    ) -> Dict[str, Any]:
        return await self._list_tasks(limit, task_status, cursor, view)

    async def create_research_task(
        self, prompt: str, model: str, verbosity: str = "standard"
    ) -> Dict[str, Any]:
        return await self._request(
            "POST",
            "/v1/tasks",
            json={
                "prompt": prompt,
                "model": model,
                "task_type": "research",
                "verbosity": verbosity,
            },
        )

    async def list_research_tasks(
        self,
        limit: int,
        task_status: Optional[str] = None,
        cursor: Optional[str] = None,
        view: str = "all",
    ) -> Dict[str, Any]:
        return await self._list_tasks(limit, task_status, cursor, view, "research")

    async def _list_tasks(
        self,
        limit: int,
        task_status: Optional[str],
        cursor: Optional[str],
        view: str,
        task_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": limit, "view": view}
        if task_type:
            params["task_type"] = task_type
        if task_status:
            params["status"] = task_status
        if cursor:
            params["cursor"] = cursor
        result = await self._request("GET", "/v1/tasks", params=params)
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise CodeFactoryError(502, "Code Factory returned an invalid task list")
        return result

    async def _get_task(self, task_id: str, task_type: str) -> Dict[str, Any]:
        result = await self._request("GET", f"/v1/tasks/{quote(task_id, safe='')}")
        if not isinstance(result, dict):
            raise CodeFactoryError(502, "Code Factory returned an invalid task")
        if result.get("task_type", "code") != task_type:
            raise CodeFactoryError(404, "Task not found")
        return result

    async def get_task(self, task_id: str) -> Dict[str, Any]:
        return await self._get_task(task_id, "code")

    async def get_research_task(self, task_id: str) -> Dict[str, Any]:
        return await self._get_task(task_id, "research")

    async def cancel_task(self, task_id: str) -> Dict[str, Any]:
        await self.get_task(task_id)
        return await self._request("POST", f"/v1/tasks/{quote(task_id, safe='')}/cancel")

    async def cancel_research_task(self, task_id: str) -> Dict[str, Any]:
        await self.get_research_task(task_id)
        return await self._request("POST", f"/v1/tasks/{quote(task_id, safe='')}/cancel")

    async def research_report(self, task_id: str) -> Dict[str, Any]:
        task = await self.get_research_task(task_id)
        if task.get("status") != "success":
            raise CodeFactoryError(404, "Research report is not available")
        result = await self._request("GET", f"/v1/tasks/{quote(task_id, safe='')}/report")
        if (
            not isinstance(result, dict)
            or result.get("task_id") != task_id
            or not isinstance(result.get("html"), str)
        ):
            raise CodeFactoryError(502, "Code Factory returned an invalid research report")
        return result

    async def task_output(self, task_id: str, after: int, limit: int) -> Dict[str, Any]:
        return await self._task_output(task_id, after, limit, "code")

    async def research_task_output(self, task_id: str, after: int, limit: int) -> Dict[str, Any]:
        return await self._task_output(task_id, after, limit, "research")

    async def _task_output(
        self, task_id: str, after: int, limit: int, task_type: str
    ) -> Dict[str, Any]:
        # Output is database-only; a task lookup would wait for workflow reconciliation.
        result = await self._request(
            "GET",
            f"/v1/tasks/{quote(task_id, safe='')}/output",
            params={"after": after, "limit": limit},
        )
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("task"), dict)
            or result["task"].get("id") != task_id
        ):
            raise CodeFactoryError(502, "Code Factory returned an invalid output page")
        if result["task"].get("task_type", "code") != task_type:
            raise CodeFactoryError(404, "Task not found")
        return result

    async def follow_up(
        self, task_id: str, prompt: str, model: Optional[str] = None
    ) -> Dict[str, Any]:
        await self.get_task(task_id)
        payload: Dict[str, Any] = {"prompt": prompt}
        if model is not None:
            payload["model"] = model
        return await self._request(
            "POST",
            f"/v1/tasks/{quote(task_id, safe='')}/follow-up",
            json=payload,
        )

    async def open_task_events(self, task_id: str, after: int) -> httpx.Response:
        """Open before downstream headers; the caller owns closing the stream."""
        await self.get_task(task_id)
        request = self._client.build_request(
            "GET",
            f"/v1/tasks/{quote(task_id, safe='')}/events",
            params={"after": after},
            headers={"Accept": "text/event-stream"},
            timeout=httpx.Timeout(30.0, read=45.0),
        )
        try:
            response = await self._client.send(request, stream=True)
        except httpx.TimeoutException as exc:
            raise CodeFactoryError(504, "Code Factory stream timed out") from exc
        except httpx.HTTPError as exc:
            raise CodeFactoryError(502, "Code Factory is unavailable") from exc
        try:
            if response.is_error:
                await response.aread()
                self._raise_response_error(response)
            if response.headers.get("content-type", "").split(";", 1)[0] != "text/event-stream":
                raise CodeFactoryError(502, "Code Factory returned an invalid event stream")
        except BaseException:
            await response.aclose()
            raise
        return response

    @staticmethod
    def _raise_response_error(response: httpx.Response) -> None:
        if not response.is_error:
            return
        detail = "Code Factory request failed"
        try:
            payload = response.json()
            if isinstance(payload, dict) and payload.get("detail"):
                detail = str(payload["detail"])
        except ValueError:
            pass
        status_code = response.status_code if response.status_code < 500 else 502
        raise CodeFactoryError(status_code, detail)

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise CodeFactoryError(504, "Code Factory request timed out") from exc
        except httpx.HTTPError as exc:
            raise CodeFactoryError(502, "Code Factory is unavailable") from exc

        self._raise_response_error(response)
        try:
            return response.json()
        except ValueError as exc:
            raise CodeFactoryError(502, "Code Factory returned invalid JSON") from exc
