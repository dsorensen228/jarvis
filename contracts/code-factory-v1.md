# Code Factory v1

Manual Code Factory requests use the authenticated Jarvis API under `/v1/code-tasks`.
The LAN service uses the same shapes under `/v1/tasks`; touchscreen proxies use
`/api/code-tasks`. These endpoints are not tools exposed to the Jarvis voice agent.

The shared factory also runs [research tasks](research-v1.md). Its list defaults to
`task_type=code`, including historical records without a type. Research is excluded from
coding lists and uses its own authenticated `/v1/research-tasks` surface. Cursor filters
include task type.

The Jarvis API persists notification recipients when an authenticated user submits a task or
follow-up, including chat and voice submissions. Viewing a running task also subscribes that user;
viewing completed history does not generate an alert. The API polls subscribed tasks independently
of clients and emits Android Expo pushes on `success` or `failed`, using channel `task-status` and
data `{type: "code_task", task_id, status: "completed" | "failed"}`. Cancellation is silent.
Subscriptions and per-device delivery receipts survive API restarts. Successful devices are
excluded from retries; rejected tickets and retryable provider errors remain pending. The service
does not need the mobile app open or a Code Factory process callback to deliver these alerts.

## Browse jobs

`GET /v1/code-tasks?limit=30&view=all&cursor=...` returns:

```json
{"items": [], "next_cursor": null}
```

`limit` is 1–200. `view` is `all`, `active`, or `history`. Active includes `pending`,
`queued`, `running`, and `cancel_requested`; history includes `success`, `failed`,
and `cancelled`. An optional individual `status` can replace a non-default view.

Jobs are ordered by descending creation time and ID. `next_cursor` is an opaque,
filter-bound continuation token (at most 1,024 characters). Pass it unchanged on the
next request; null means the end. Starting a new filter starts a new traversal.
Refreshing page one must not discard previously loaded history. Deduplicate by ID
and use `updated_at`/`output_seq` to avoid regressing newer job state.

## Live activity

`GET /v1/code-tasks/{id}/output?after=0&limit=100` returns:

```json
{
  "items": [{"seq": 1, "kind": "status", "text": "Agent connected", "created_at": "2026-09-27T12:00:00Z"}],
  "next_after": 1,
  "has_more": false,
  "truncated": false,
  "task": {"id": "...", "status": "running", "output_seq": 1}
}
```

The abbreviated `task` above is a full task record in actual responses. Output kinds
are `assistant`, `command`, `tool`, `error`, and `status`. Sequence numbers increase
atomically per job. Read subsequent pages using `next_after`; drain `has_more` before
waiting for more. Clients deduplicate by sequence number. The service persists the
most recent 300 entries with up to 2,000 characters each. `truncated` reports that
the requested cursor precedes retained output. Reasoning and raw protocol events are
excluded from this activity feed. Final results and bounded diagnostic previews
remain available on the task record. Older jobs may have no activity entries.

`GET /v1/code-tasks/{id}/events?after=0` streams the same output page as SSE:

```text
id: 1
event: output
data: {"items":[],"next_after":1,"has_more":false,"truncated":false,"task":{...}}

```

The first frame supplies current state, including completed jobs. Subsequent frames
contain output or state changes. Heartbeat comments keep idle connections alive.
The stream closes after all output for a terminal job is delivered. Reconnect using
`after` or `Last-Event-ID`; when both are present the larger value wins. Transport
failure may emit `event: error`, then close. A client must reconnect or fall back to
the finite output endpoint, retaining received entries. Native clients without
streaming fetch support may poll this endpoint while the detail view is visible.

## Follow-up and cancellation

`POST /v1/code-tasks/{id}/follow-up` accepts `{"prompt":"...","model":"gpt-6-sol"}`.
Model is optional and defaults to the parent's supported model (or the default
model for older records). It returns a new task with status 202 and
`parent_task_id` set. Prompts contain 1–32,000 characters after validation.

A follow-up waits for its parent to reach a terminal state, then starts a separate
job with the previous request, saved outcome, and new instructions. It does not
inject instructions into an executing agent. Interfaces label this action
“Queue follow-up” for active jobs and “Continue task” for finished jobs. Chained
follow-ups retain the link to their immediate parent.

`POST /v1/code-tasks/{id}/cancel` requests cancellation of that job only. UI state
remains “Stopping” until the service reports the terminal outcome. Queued follow-ups
are independent jobs and must be cancelled separately when no longer wanted.

The generated OpenAPI schema in `openapi/jarvis-v1.json` defines the public request
and response fields, including `parent_task_id`, `output_seq`, and the page shapes.
