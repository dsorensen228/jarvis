"""Client for the dedicated local vision-language model runtime."""

from __future__ import annotations

import base64
from typing import Any, Dict

import httpx

from jarvis_api.config import Settings


class VisionClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.vision_base_url,
            timeout=httpx.Timeout(settings.vision_request_timeout_seconds, connect=5.0),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def ready(self) -> bool:
        try:
            response = await self._client.get("/models", timeout=2.0)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    async def describe(self, image: bytes, media_type: str, prompt: str) -> str:
        if not image:
            raise ValueError("camera returned an empty image")
        data_url = "data:{};base64,{}".format(
            media_type or "image/jpeg", base64.b64encode(image).decode("ascii")
        )
        payload: Dict[str, Any] = {
            "model": self.settings.vision_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            "temperature": 0,
            "max_tokens": 400,
        }
        response = await self._client.post("/chat/completions", json=payload)
        response.raise_for_status()
        choices = response.json().get("choices") or []
        if not choices:
            raise RuntimeError("vision model returned no answer")
        content = choices[0].get("message", {}).get("content")
        if isinstance(content, list):
            content = " ".join(
                str(part.get("text") or "") for part in content if isinstance(part, dict)
            )
        answer = str(content or "").strip()
        if not answer:
            raise RuntimeError("vision model returned an empty answer")
        return answer
