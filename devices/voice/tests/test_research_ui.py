from __future__ import annotations

import json

import httpx
import pytest
from test_ui import FakeVoice, _ui_client

from jarvis_voice.api import JarvisApiClient


class ResearchBackend:
    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.payload = {"id": "research-1", "task_type": "research", "status": "pending"}
        self.status = 200
        self.unavailable = False

    def handle(self, request):
        self.requests.append(request)
        if request.url.path == "/v1/auth/token":
            return httpx.Response(200, json={"access_token": "runtime-token"})
        if self.unavailable:
            raise httpx.ConnectError("API unavailable", request=request)
        if request.url.path == "/v1/speech/transcribe":
            return httpx.Response(200, json={"text": "Compare energy storage methods"})
        return httpx.Response(self.status, json=self.payload)


@pytest.fixture
async def research_client(monkeypatch, tmp_path):
    backend = ResearchBackend()
    api = JarvisApiClient("http://jarvis.test", "owner", "runtime-password")
    await api._http.aclose()
    api._http = httpx.AsyncClient(
        base_url=api.base_url, transport=httpx.MockTransport(backend.handle)
    )
    voice = FakeVoice()
    client = await _ui_client(monkeypatch, tmp_path, api, voice)
    try:
        yield client, backend, voice
    finally:
        await client.close()
        await api.close()


@pytest.mark.parametrize(
    ("model", "verbosity"),
    [("gpt-5.6-terra", "concise"), ("gpt-6-sol", "standard"), ("gpt-6-astra", "in_depth")],
)
async def test_research_creation_uses_runtime_identity_and_validated_fields(
    research_client, model, verbosity
):
    client, backend, _ = research_client
    backend.status = 202
    response = await client.post(
        "/api/research-tasks",
        json={
            "prompt": "  Compare energy storage methods  ",
            "model": model,
            "verbosity": verbosity,
            "task_type": "code",
            "user_id": "another-owner",
        },
        headers={"Authorization": "Bearer browser-token"},
    )
    assert response.status == 202
    assert (await response.json())["task_type"] == "research"
    upstream = backend.requests[-1]
    assert upstream.method == "POST"
    assert upstream.url.path == "/v1/research-tasks"
    assert upstream.headers["Authorization"] == "Bearer runtime-token"
    assert json.loads(upstream.content) == {
        "prompt": "Compare energy storage methods",
        "model": model,
        "verbosity": verbosity,
    }
    assert "runtime-token" not in await response.text()
    config = await (await client.get("/api/config")).text()
    assert "runtime-token" not in config
    assert "runtime-password" not in config


async def test_research_creation_defaults_verbosity_and_accepts_maximum_prompt(research_client):
    client, backend, _ = research_client
    response = await client.post(
        "/api/research-tasks", json={"prompt": "x" * 32000, "model": "gpt-6-sol"}
    )
    assert response.status == 202
    assert json.loads(backend.requests[-1].content)["verbosity"] == "standard"


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        "prompt",
        {},
        {"prompt": "   ", "model": "gpt-6-sol"},
        {"prompt": 42, "model": "gpt-6-sol"},
        {"prompt": "x" * 32001, "model": "gpt-6-sol"},
        {"prompt": "Compare", "model": None},
        {"prompt": "Compare", "model": ""},
        {"prompt": "Compare", "model": "unsupported"},
        {"prompt": "Compare", "model": ["gpt-6-sol"]},
        {"prompt": "Compare", "model": "gpt-6-sol", "verbosity": "brief"},
        {"prompt": "Compare", "model": "gpt-6-sol", "verbosity": None},
        {"prompt": "Compare", "model": "gpt-6-sol", "verbosity": ["concise"]},
    ],
    ids=[
        "null",
        "array",
        "string",
        "missing",
        "blank",
        "numeric-prompt",
        "long-prompt",
        "null-model",
        "blank-model",
        "unknown-model",
        "array-model",
        "unknown-verbosity",
        "null-verbosity",
        "array-verbosity",
    ],
)
async def test_research_creation_rejects_invalid_payload_before_authentication(
    research_client, body
):
    client, backend, _ = research_client
    response = await client.post(
        "/api/research-tasks", data=json.dumps(body), headers={"Content-Type": "application/json"}
    )
    assert response.status == 422
    assert (await response.json())["detail"]
    assert backend.requests == []


async def test_research_creation_rejects_malformed_json(research_client):
    client, backend, _ = research_client
    response = await client.post(
        "/api/research-tasks", data="{", headers={"Content-Type": "application/json"}
    )
    assert response.status == 422
    assert (await response.json())["detail"]
    assert backend.requests == []


@pytest.mark.parametrize(
    ("local_query", "expected_query"),
    [
        ("", {"limit": "30"}),
        (
            "?limit=2&view=history&cursor=older",
            {"limit": "2", "view": "history", "cursor": "older"},
        ),
        ("?status=running&user_id=other&task_type=code", {"limit": "30", "status": "running"}),
    ],
)
async def test_research_list_preserves_pagination_without_browser_identity(
    research_client, local_query, expected_query
):
    client, backend, _ = research_client
    backend.payload = {
        "items": [{"id": "research-1", "task_type": "research"}],
        "next_cursor": "older",
    }
    response = await client.get(f"/api/research-tasks{local_query}")
    assert response.status == 200
    assert (await response.json())["next_cursor"] == "older"
    upstream = backend.requests[-1]
    assert upstream.url.path == "/v1/research-tasks"
    assert dict(upstream.url.params) == expected_query


@pytest.mark.parametrize("suffix", ["", "/cancel", "/output?after=4&limit=2&user_id=other"])
async def test_research_detail_cancel_and_output_preserve_task_scope(research_client, suffix):
    client, backend, _ = research_client
    method = "POST" if suffix == "/cancel" else "GET"
    response = await client.request(method, f"/api/research-tasks/research%2Fone{suffix}")
    assert response.status == 200
    assert (await response.json())["id"] == "research-1"
    upstream = backend.requests[-1]
    assert upstream.method == method
    assert upstream.url.raw_path.split(b"?")[0] == (
        b"/v1/research-tasks/research%2Fone" + suffix.split("?")[0].encode()
    )
    assert dict(upstream.url.params) == (
        {"after": "4", "limit": "2"} if "/output" in suffix else {}
    )


async def test_research_report_returns_html_as_uncached_json(research_client):
    client, backend, _ = research_client
    backend.payload = {"task_id": "research-1", "html": "<h1>Research</h1><p>Sources verified.</p>"}
    response = await client.get("/api/research-tasks/research-1/report")
    assert response.status == 200
    assert response.content_type == "application/json"
    assert response.headers["Cache-Control"] == "no-store"
    assert await response.json() == backend.payload
    assert backend.requests[-1].url.path == "/v1/research-tasks/research-1/report"


@pytest.mark.parametrize(
    ("method", "suffix", "status"),
    [
        ("POST", "", 422),
        ("GET", "", 401),
        ("GET", "/one", 403),
        ("POST", "/one/cancel", 409),
        ("GET", "/one/output", 503),
        ("GET", "/one/report", 404),
    ],
)
async def test_research_preserves_upstream_error_status(research_client, method, suffix, status):
    client, backend, _ = research_client
    backend.status = status
    backend.payload = {"detail": "Research unavailable"}
    response = await client.request(
        method, f"/api/research-tasks{suffix}", json={"prompt": "Compare", "model": "gpt-6-sol"}
    )
    assert response.status == status
    assert await response.json() == {"detail": "Research unavailable"}
    if suffix.endswith("/report"):
        assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize(("method", "suffix"), [("POST", ""), ("GET", "/one/report")])
async def test_research_network_failure_returns_gateway_error(research_client, method, suffix):
    client, backend, _ = research_client
    backend.unavailable = True
    response = await client.request(
        method, f"/api/research-tasks{suffix}", json={"prompt": "Compare", "model": "gpt-6-sol"}
    )
    assert response.status == 502
    assert "API unavailable" in (await response.json())["detail"]


async def test_research_recording_transcribes_without_creating_a_task(research_client):
    client, backend, voice = research_client
    started = await client.post("/api/research-tasks/recording/start")
    assert started.status == 200
    assert await started.json() == {"recording": True}
    stopped = await client.post("/api/research-tasks/recording/stop")
    assert stopped.status == 200
    assert await stopped.json() == {"transcript": "Compare energy storage methods"}
    assert voice.start_count == 1
    assert [request.url.path for request in backend.requests] == [
        "/v1/auth/token",
        "/v1/speech/transcribe",
    ]
    assert backend.requests[-1].content == b"pcm"
    assert dict(backend.requests[-1].url.params) == {"sample_rate": "16000"}
