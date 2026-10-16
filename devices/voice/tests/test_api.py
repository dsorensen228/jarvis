import httpx
import pytest

from jarvis_voice.api import JarvisApiClient


class EventStream(httpx.AsyncByteStream):
    def __init__(self, data=b"event: output\ndata: {}\n\n"):
        self.data = data
        self.closed = False

    async def __aiter__(self):
        yield self.data

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_stream_refreshes_expired_auth_and_preserves_resume_cursor():
    rejected = EventStream()
    accepted = EventStream()
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path == "/v1/auth/token":
            return httpx.Response(200, json={"access_token": "new"})
        if request.headers["Authorization"] == "Bearer stale":
            return httpx.Response(401, stream=rejected)
        assert request.headers["Last-Event-ID"] == "12"
        assert request.url.params["after"] == "10"
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=accepted)

    api = JarvisApiClient("http://api.test", "owner", "password")
    await api._http.aclose()
    api._http = httpx.AsyncClient(base_url=api.base_url, transport=httpx.MockTransport(handler))
    api._token = "stale"
    api._token_expires_at = float("inf")
    try:
        response = await api.open_event_stream(
            "/v1/code-tasks/one/events", params={"after": 10}, last_event_id="12"
        )
        assert rejected.closed
        assert not accepted.closed
        assert await response.aread() == accepted.data
        await response.aclose()
        assert accepted.closed
        assert len(calls) == 3
    finally:
        await api.close()
