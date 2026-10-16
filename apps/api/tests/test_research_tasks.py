from __future__ import annotations

import json

import httpx
import pytest
from test_code_factory import TASK, authenticated_client, gateway

RESEARCH = {
    **TASK,
    "id": "research-1",
    "task_type": "research",
    "model": "gpt-6-sol",
    "verbosity": "standard",
    "report_available": False,
}


def test_research_routes_require_authentication(settings):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=RESEARCH)

    with authenticated_client(settings, gateway(handler)) as client:
        client.headers.pop("Authorization")
        for method, path in (
            ("POST", "/v1/research-tasks"),
            ("GET", "/v1/research-tasks"),
            ("GET", "/v1/research-tasks/research-1"),
            ("POST", "/v1/research-tasks/research-1/cancel"),
            ("GET", "/v1/research-tasks/research-1/report"),
            ("GET", "/v1/research-tasks/research-1/output"),
        ):
            response = client.request(
                method, path, json={"prompt": "Investigate", "model": "gpt-6-sol"}
            )
            assert response.status_code == 401, response.text
    assert calls == []


@pytest.mark.parametrize("model", ["gpt-6-sol", "gpt-5.6-terra", "gpt-6-astra"])
@pytest.mark.parametrize("verbosity", [None, "concise", "standard", "in_depth"])
def test_research_creation_forwards_selected_model_and_detail_level(settings, model, verbosity):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(202, json={**RESEARCH, **json.loads(request.content)})

    body = {"prompt": "  Compare the alternatives  ", "model": model}
    if verbosity is not None:
        body["verbosity"] = verbosity
    with authenticated_client(settings, gateway(handler)) as client:
        response = client.post("/v1/research-tasks", json=body)
    assert response.status_code == 202, response.text
    assert response.json()["verbosity"] == (verbosity or "standard")
    assert response.json()["task_type"] == "research"
    assert calls[0].method == "POST"
    assert calls[0].url.path == "/v1/tasks"
    assert json.loads(calls[0].content) == {
        "prompt": "Compare the alternatives",
        "model": model,
        "task_type": "research",
        "verbosity": verbosity or "standard",
    }


def test_research_validation_never_calls_worker(settings):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=RESEARCH)

    with authenticated_client(settings, gateway(handler)) as client:
        for body in (
            {"prompt": "", "model": "gpt-6-sol"},
            {"prompt": " \n\t ", "model": "gpt-6-sol"},
            {"prompt": "x" * 32001, "model": "gpt-6-sol"},
            {"prompt": "Investigate"},
            {"prompt": "Investigate", "model": "unknown"},
            {"prompt": "Investigate", "model": "gpt-6-sol", "verbosity": "brief"},
            {"prompt": "Investigate", "model": "gpt-6-sol", "verbosity": None},
        ):
            assert client.post("/v1/research-tasks", json=body).status_code == 422
        for query in (
            "?limit=0",
            "?limit=201",
            "?view=bogus",
            "?status=bogus",
            "?view=active&status=running",
            "?cursor=" + "x" * 1025,
        ):
            assert client.get("/v1/research-tasks" + query).status_code == 422
    assert calls == []


def test_research_page_filters_are_forwarded_without_changing_code_lists(settings):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"items": [], "next_cursor": "next"})

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get("/v1/research-tasks?limit=2&view=history&cursor=opaque")
        assert response.status_code == 200, response.text
        assert response.json() == {"items": [], "next_cursor": "next"}
        assert dict(calls[-1].url.params) == {
            "limit": "2",
            "view": "history",
            "cursor": "opaque",
            "task_type": "research",
        }
        assert client.get("/v1/research-tasks?status=running").status_code == 200
        assert dict(calls[-1].url.params) == {
            "limit": "30",
            "view": "all",
            "status": "running",
            "task_type": "research",
        }
        assert client.get("/v1/code-tasks").status_code == 200
        assert dict(calls[-1].url.params) == {"limit": "30", "view": "all"}


@pytest.mark.parametrize("task_type", ["code", None])
def test_research_rejects_code_tasks_before_cancel_or_report(settings, task_type):
    calls = []
    task = dict(TASK)
    if task_type is not None:
        task["task_type"] = task_type

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/output"):
            return httpx.Response(200, json=output_page(task))
        return httpx.Response(200, json=task)

    with authenticated_client(settings, gateway(handler)) as client:
        assert client.get("/v1/research-tasks/one").status_code == 404
        assert client.post("/v1/research-tasks/one/cancel").status_code == 404
        assert client.get("/v1/research-tasks/one/report").status_code == 404
        assert client.get("/v1/research-tasks/one/output").status_code == 404
    assert [(call.method, call.url.path) for call in calls] == [
        ("GET", "/v1/tasks/one"),
        ("GET", "/v1/tasks/one"),
        ("GET", "/v1/tasks/one"),
        ("GET", "/v1/tasks/one/output"),
    ]


def test_code_routes_reject_research_before_side_effects_or_streams(settings):
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/output"):
            return httpx.Response(200, json=output_page(RESEARCH))
        return httpx.Response(200, json=RESEARCH)

    with authenticated_client(settings, gateway(handler)) as client:
        for method, suffix in (
            ("GET", ""),
            ("POST", "/cancel"),
            ("GET", "/output"),
            ("GET", "/events"),
            ("POST", "/follow-up"),
        ):
            response = client.request(
                method,
                "/v1/code-tasks/research-1" + suffix,
                json={"prompt": "Continue"},
            )
            assert response.status_code == 404, response.text
    assert [(call.method, call.url.path) for call in calls] == [
        ("GET", "/v1/tasks/research-1"),
        ("GET", "/v1/tasks/research-1"),
        ("GET", "/v1/tasks/research-1/output"),
        ("GET", "/v1/tasks/research-1"),
        ("GET", "/v1/tasks/research-1"),
    ]


def test_research_detail_and_cancel_never_embed_html(settings):
    calls = []

    def handler(request):
        calls.append(request)
        status = "cancel_requested" if request.method == "POST" else "running"
        return httpx.Response(200, json={**RESEARCH, "status": status, "report_html": "secret"})

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get("/v1/research-tasks/research-1")
        assert response.status_code == 200, response.text
        assert response.json()["report_available"] is False
        assert "report_html" not in response.json()
        response = client.post("/v1/research-tasks/research-1/cancel")
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "cancel_requested"
        assert "report_html" not in response.json()
    assert [(call.method, call.url.path) for call in calls] == [
        ("GET", "/v1/tasks/research-1"),
        ("GET", "/v1/tasks/research-1"),
        ("POST", "/v1/tasks/research-1/cancel"),
    ]


def test_report_returns_html_as_authenticated_json(settings):
    calls = []
    html = "<!doctype html><html><body><h1>Findings</h1></body></html>"

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/report"):
            return httpx.Response(200, json={"task_id": "research-1", "html": html})
        return httpx.Response(200, json={**RESEARCH, "status": "success", "report_available": True})

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get("/v1/research-tasks/research-1/report")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/json"
    assert response.headers.get("cache-control") == "no-store"
    assert response.json() == {"task_id": "research-1", "html": html}
    assert calls[-1].url.path == "/v1/tasks/research-1/report"


@pytest.mark.parametrize("task_status", ["pending", "running", "failed", "cancelled"])
def test_report_is_unavailable_until_research_succeeds(settings, task_status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={**RESEARCH, "status": task_status})

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get("/v1/research-tasks/research-1/report")
    assert response.status_code == 404, response.text
    assert [call.url.path for call in calls] == ["/v1/tasks/research-1"]


@pytest.mark.parametrize(
    "failure,expected",
    [
        (httpx.Response(404, json={"detail": "Missing task"}), 404),
        (httpx.Response(503, json={"detail": "Worker unavailable"}), 502),
        (httpx.Response(200, content=b"not json"), 502),
        (httpx.Response(200, json=[]), 502),
        (httpx.ReadTimeout("slow worker"), 504),
        (httpx.ConnectError("offline worker"), 502),
    ],
)
def test_research_worker_errors_are_gateway_errors(settings, failure, expected):
    def handler(request):
        if isinstance(failure, Exception):
            raise failure
        return failure

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get("/v1/research-tasks")
    assert response.status_code == expected, response.text
    assert response.json()["detail"]


@pytest.mark.parametrize("report", [{}, {"task_id": "research-1", "html": 42}])
def test_malformed_report_is_a_gateway_error(settings, report):
    def handler(request):
        if request.url.path.endswith("/report"):
            return httpx.Response(200, json=report)
        return httpx.Response(200, json={**RESEARCH, "status": "success"})

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get("/v1/research-tasks/research-1/report")
    assert response.status_code == 502, response.text


def test_research_activity_output_polls_with_research_metadata(settings):
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/output"):
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "seq": 7,
                            "kind": "assistant",
                            "text": "Comparing sources",
                            "created_at": "2026-09-27T12:00:00Z",
                        }
                    ],
                    "next_after": 7,
                    "has_more": False,
                    "truncated": False,
                    "task": {**RESEARCH, "status": "success", "report_available": True},
                },
            )
        return httpx.Response(200, json=RESEARCH)

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get("/v1/research-tasks/research-1/output?after=3&limit=2")
        assert response.status_code == 200, response.text
        assert response.json()["items"][0]["text"] == "Comparing sources"
        assert response.json()["next_after"] == 7
        assert response.json()["task"]["report_available"] is True
        assert response.json()["task"]["task_type"] == "research"
        assert dict(calls[-1].url.params) == {"after": "3", "limit": "2"}
        before = len(calls)
        for query in ("?after=-1", "?limit=0", "?limit=201"):
            assert client.get("/v1/research-tasks/research-1/output" + query).status_code == 422
        assert len(calls) == before
    assert [(call.method, call.url.path) for call in calls] == [
        ("GET", "/v1/tasks/research-1/output"),
    ]


def output_page(task):
    return {
        "items": [],
        "next_after": 7,
        "has_more": False,
        "truncated": False,
        "task": task,
    }


@pytest.mark.parametrize(
    "surface,task",
    [("code", TASK), ("code", {**TASK, "task_type": "code"}), ("research", RESEARCH)],
)
def test_activity_poll_uses_only_database_output_when_task_lookup_is_unavailable(
    settings, surface, task
):
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/output"):
            return httpx.Response(200, json=output_page(task))
        return httpx.Response(503, json={"detail": "Temporal is unavailable"})

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get(f"/v1/{surface}-tasks/{task['id']}/output?after=3&limit=2")
    assert response.status_code == 200, response.text
    assert response.json()["task"]["id"] == task["id"]
    assert response.json()["next_after"] == 7
    assert [(call.method, call.url.path) for call in calls] == [
        ("GET", f"/v1/tasks/{task['id']}/output")
    ]
    assert dict(calls[0].url.params) == {"after": "3", "limit": "2"}


@pytest.mark.parametrize("surface", ["code", "research"])
@pytest.mark.parametrize("payload", [[], {}, {"task": None}, {"task": []}, {"task": {}}])
def test_malformed_activity_page_is_a_gateway_error(settings, surface, payload):
    def handler(request):
        if request.url.path.endswith("/output"):
            return httpx.Response(200, json=payload)
        task = TASK if surface == "code" else RESEARCH
        return httpx.Response(200, json=task)

    with authenticated_client(settings, gateway(handler)) as client:
        response = client.get(f"/v1/{surface}-tasks/one/output")
    assert response.status_code == 502, response.text
