from __future__ import annotations

import json
from contextlib import contextmanager

import httpx
import pytest
from test_api import authenticated_client as entered_client

from jarvis_api.code_factory import CodeFactoryClient, CodeFactoryError


@contextmanager
def authenticated_client(settings, factory):
    # The shared helper enters its TestClient already; do not start lifespan twice.
    client = entered_client(settings, factory)
    try:
        yield client
    finally:
        client.__exit__(None, None, None)


TASK = {
    "id": "one",
    "prompt": "Do work",
    "status": "running",
    "workflow_id": "code-task-one",
    "created_at": "2026-09-27T12:00:00Z",
    "updated_at": "2026-09-27T12:00:00Z",
    "output_seq": 7,
}


class EventStream(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data
        self.closed = False

    async def __aiter__(self):
        yield self.data

    async def aclose(self):
        self.closed = True


def gateway(handler):
    client = CodeFactoryClient("http://factory.test", 30)
    client._client = httpx.AsyncClient(
        base_url="http://factory.test",
        transport=httpx.MockTransport(handler),
    )
    return client


def test_page_and_follow_up_proxy_contract(settings):
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path == "/v1/tasks/one":
            return httpx.Response(200, json=TASK)
        if request.url.path.endswith("/follow-up"):
            return httpx.Response(202, json={**TASK, "id": "two", "parent_task_id": "one"})
        if request.url.path.endswith("/output"):
            return httpx.Response(
                200,
                json={
                    "items": [],
                    "next_after": 7,
                    "has_more": False,
                    "truncated": True,
                    "task": TASK,
                },
            )
        return httpx.Response(200, json={"items": [TASK], "next_cursor": "next"})

    with authenticated_client(settings, gateway(handler)) as client:
        page = client.get("/v1/code-tasks?limit=2&view=history&cursor=opaque").json()
        assert page["next_cursor"] == "next"
        assert page["items"][0]["output_seq"] == 7
        assert dict(calls[-1].url.params) == {"limit": "2", "view": "history", "cursor": "opaque"}
        output = client.get("/v1/code-tasks/one/output?after=3&limit=2").json()
        assert output["truncated"] is True
        assert dict(calls[-1].url.params) == {"after": "3", "limit": "2"}
        follow_up = client.post("/v1/code-tasks/one/follow-up", json={"prompt": "  Add tests  "})
        assert follow_up.status_code == 202
        assert follow_up.json()["parent_task_id"] == "one"
        assert json.loads(calls[-1].content) == {"prompt": "Add tests"}
        before = len(calls)
        for path in (
            "/v1/code-tasks?view=active&status=running",
            "/v1/code-tasks?view=bogus",
            "/v1/code-tasks?limit=201",
            "/v1/code-tasks/one/output?after=-1",
        ):
            assert client.get(path).status_code == 422
        assert client.post("/v1/code-tasks/one/follow-up", json={"prompt": " "}).status_code == 422
        assert len(calls) == before
        client.headers.pop("Authorization")
        for path in ("/output", "/events"):
            assert client.get("/v1/code-tasks/one" + path).status_code == 401
        assert client.post("/v1/code-tasks/one/follow-up", json={"prompt": "x"}).status_code == 401


def test_event_stream_resumes_and_closes(settings):
    stream = EventStream(b'event: output\nid: 7\ndata: {"next_after":7}\n\n')
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path == "/v1/tasks/one":
            return httpx.Response(200, json=TASK)
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=stream)

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get("/v1/code-tasks/one/events?after=2", headers={"Last-Event-ID": "6"})
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.content == stream.data
        assert calls[-1].url.params["after"] == "6"
        assert stream.closed
        assert (
            client.get("/v1/code-tasks/one/events", headers={"Last-Event-ID": "bad"}).status_code
            == 422
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,content_type,expected", [(404, "application/json", 404), (200, "text/html", 502)]
)
async def test_failed_stream_is_closed_before_gateway_error(status, content_type, expected):
    stream = EventStream(b'{"detail":"missing"}')

    def handler(request):
        if request.url.path == "/v1/tasks/one":
            return httpx.Response(200, json=TASK)
        return httpx.Response(status, headers={"Content-Type": content_type}, stream=stream)

    client = gateway(handler)
    try:
        with pytest.raises(CodeFactoryError) as error:
            await client.open_task_events("one", 0)
        assert error.value.status_code == expected
        assert stream.closed
    finally:
        await client.close()
