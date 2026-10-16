# Code Factory

Code Factory is the native macOS control plane for autonomous work in the Jarvis workspace. It
accepts coding and research prompts over HTTP, records their complete lifecycle in Jarvis's existing MongoDB
Atlas instance, and uses a local Temporal server to execute one Codex CLI task at a time.
Records live in `jarvis.code_factory_tasks`. Coding runs from
`~/jarvis-workspace`, so the external workspace-level `AGENTS.md` is the source of delivery
policy. It is deployment-local configuration and is intentionally not stored in this repository;
start from `deploy/macmini/workspace-AGENTS.example.md` when provisioning a new code host.

## API

```bash
curl -X POST http://code-host.local:8010/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"Add the requested feature and deploy it.","model":"gpt-6-sol"}'

curl http://code-host.local:8010/v1/tasks
curl http://code-host.local:8010/v1/tasks/<task-id>
curl -X POST http://code-host.local:8010/v1/tasks/<task-id>/cancel
curl 'http://code-host.local:8010/v1/tasks?view=active&limit=30'
curl 'http://code-host.local:8010/v1/tasks/<task-id>/output?after=0&limit=100'
curl -N 'http://code-host.local:8010/v1/tasks/<task-id>/events?after=0'
curl -X POST http://code-host.local:8010/v1/tasks/<task-id>/follow-up \
  -H 'content-type: application/json' \
  -d '{"prompt":"Add keyboard navigation to the page."}'
```

Statuses are `pending`, `queued`, `running`, `cancel_requested`, `cancelled`, `success`, and
`failed`. Every new task requires an explicit supported model. The mobile/web, touchscreen,
and Wear OS selectors offer Terra (`gpt-5.6-terra`), Sol (`gpt-6-sol`), and Astra (`gpt-6-astra`),
with Sol selected by default; clicking a selected model keeps it selected. There is no automatic
routing or fallback. Historical records may have missing or older model IDs and remain readable.
For coding tasks, the agent chooses jarvis, sherman, or both. MongoDB retains the prompt, chosen model, completion
report, captured standard output/error, exit code, timestamps, changed paths, and self-update state.

## Unattended Codex execution

The worker runs `codex exec --profile code-factory --json` with `approval_policy="never"`, `danger-full-access`,
closed stdin, and `--skip-git-repo-check` because the working directory contains two Git clones.
The trusted code host retains its existing SSH, build, and deployment authority. Each run pins
the chosen model and medium reasoning effort. `CODE_FACTORY_AGENT_PATH` defaults to
`/opt/homebrew/bin/codex`. Authentication uses the daemon user's saved ChatGPT login with file
credential storage; API key overrides are removed from the child environment.

The packaged [run instructions](src/code_factory/prompts/unattended.md) require autonomous
completion without questions or approval gates. A genuine blocker produces a failed report
and terminates instead of waiting. The [completion schema](src/code_factory/prompts/result.schema.json)
requires `status` and `result`. Codex JSONL `item.completed` and `turn.completed`/`turn.failed`
events are normalized to the existing UI result field. A missing/invalid report, incomplete turn,
nonzero exit, or reported failure fails the task. Progress messages never count as completion.

The installer exposes the maintained factory skills in the workspace's `.agents/skills/`.
They cover delivery/debugging and Atlas verification without interactive workflow gates.
They replace the factory's former Cursor/Superpowers workflows; third-party caches remain intact.
The installer provisions `~/.codex/code-factory.config.toml` for the existing mobile-mcp.
This profile survives desktop config rewrites and inherits the user's installed plugins,
including the connected MongoDB Atlas plugin, and other tools. Credentials stay in the same
Codex home; there is no copied login to drift or expire.

Task responses retain ordinary parsed results up to 32 KiB. Event-stream arrays return the final
result when present, or a preview of the assistant text when an agent exited without a result.
Larger results return a marked preview; complete structured output remains in Atlas.
Raw `stdout` and `stderr` are previews
of the last 4,000 characters per stream, prefixed with `[earlier output omitted]` when truncated.
MongoDB applies the preview before sending data to the factory, including on status updates;
the full captured logs remain stored in Atlas. This keeps list polling and task details usable
even when an agent fills its 2 MiB capture buffer. List responses are
`{items: TaskRecord[], next_cursor: string | null}` and default to 50 tasks. Use `limit=1..200`,
`cursor`, and either an individual `status` or `view=all|active|history` (default `all`).
Cursors retain their filter and sort by creation time and ID, so newly submitted tasks do not
duplicate or displace older pages. A cursor used with a different filter returns HTTP 400.
Status repair runs in the background, so a list request never waits
for reconciliation of every active workflow. MongoDB reads have a 10-second deadline; result
writes allow 60 seconds to upload captured logs. Storage failures return a retryable HTTP 503
instead of retaining blocked reads indefinitely. Activities keep heartbeating while saving
results, so slow uploads do not turn completed work into a Temporal heartbeat timeout.

Normalized progress is persisted while the agent runs, independently of the final transcript.
`GET /v1/tasks/{id}/output?after=0&limit=100` returns
`{items: [{seq,kind,text,created_at}], next_after, has_more, truncated, task}`. Kinds are
`assistant`, `command`, `tool`, `error`, and `status`; reasoning and raw protocol records are
excluded. Each task retains its latest 300 events, with at most 2,000 characters each. A
`truncated` response means earlier events have aged out; clients should display a gap marker.
Use `next_after` for the next request and drain `has_more` pages before waiting for new output.
The snapshot `task` includes the latest status and result, including jobs created before this
stream was introduced. Sequence allocation and retention are atomic in MongoDB.

`GET /v1/tasks/{id}/events` streams that same page as SSE `event: output`, with `id` equal to
`next_after`. It accepts `after` and `Last-Event-ID` for reconnects, sends idle heartbeats,
and closes after all output for a terminal task is delivered. The polling endpoint is the
fallback for clients without streaming support. Temporary progress-storage failures do not
abort the agent, and persistence retries retain a bounded in-memory queue.

`POST /v1/tasks/{id}/follow-up` accepts `{prompt, model?}` and returns a separate queued task
with `parent_task_id`. It inherits the parent's supported model by default (Sol for historical
records without a supported model). A durable workflow dependency waits for the parent to reach
a terminal status, including when the parent is still queued or the worker restarts. Short
dependency checks release the worker slot between checks so they cannot block the parent.
The single worker runs one coding or research activity at a time. When a follow-up starts, it reads the parent's
original request and latest saved result as context. This is a queued continuation, not live
injection into a running Codex turn. Cancelling either task does not cancel the other.

## Research reports

Submit research through the same task service and required model choices:

```bash
curl -X POST http://code-host.local:8010/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"Compare the available options with sources.","model":"gpt-6-sol","task_type":"research","verbosity":"standard"}'
curl 'http://code-host.local:8010/v1/tasks?task_type=research&view=history'
curl 'http://code-host.local:8010/v1/tasks/<task-id>/report'
```

`task_type` is `code` (default) or `research`. List filtering defaults to `code`, including
historical records without a type. Pagination cursors bind type, status, and view; changing
any filter requires a new first page. Individual details, progress, cancellation, and SSE
remain available by task ID. Follow-ups inherit the parent's type and verbosity, as well as
its model unless explicitly overridden. A research follow-up receives the previous successful
report as `previous-report.html` in its own task directory.

`verbosity` defaults to `standard` and controls detail per item, never the requested scope:

- `concise`: direct essentials with minimal elaboration.
- `standard`: balanced explanation and relevant evidence.
- `in_depth`: considerable detail with useful reasoning, context, evidence, and caveats.

All levels cover the complete request. An exhaustive concise list can still be long. There
are no prose-length quotas, and unnecessary sections, filler, and repetition are discouraged.
The [research instructions](src/code_factory/prompts/research.md) and
[research workspace policy](src/code_factory/prompts/research-AGENTS.md) require verified sources,
near-claim citations, material dates and uncertainty, and useful tables or static SVG diagrams.

Research runs from `~/jarvis-research/<task-id>/`, configurable with
`CODE_FACTORY_RESEARCH_WORKSPACE`. This root must be separate from the engineering workspace;
neither may contain the other. The installer initializes it, and each run refreshes the canonical
`AGENTS.md` in the root and task directory. These instructions authorize research and report
creation, not repository changes or deployments. The same Codex profile and host credentials
are used; directory separation is a workflow policy, not an OS sandbox. Research does not
inspect Git revisions, collect changed repository paths, or schedule self-updates.

The agent writes UTF-8 `report.html` and still returns the ordinary structured completion status.
Success additionally requires a meaningful report. The worker refuses symlinks, nonregular
files, unreadable/invalid UTF-8 content, and artifacts over 2 MiB (a storage/rendering limit,
not a writing-length target). It sanitizes HTML with [nh3](https://nh3.readthedocs.io/en/stable/)
before persistence: semantic HTML, tables, and static inline SVG are allowed; scripts, CSS,
forms, embedded frames, animation, and external assets are removed. HTTP(S) source links open
outside the report viewer; local heading links remain inside it. The viewer supplies styling
for `research-report`, `lead`, `callout`, `metric-grid`, `metric`, `table-wrap`, `source-list`,
and `muted`.

Task metadata contains `task_type`, `verbosity`, and `report_available`. Report HTML is excluded
from list, detail, write responses, and progress/SSE projections. Only
`GET /v1/tasks/{id}/report` returns `{task_id, html}`, and only for a successful research task
with a stored report; all other cases return 404. The sanitized report remains in Atlas
independently of the Mac's task files. Missing or invalid reports fail explicitly and preserve
agent diagnostics. Cancellation and timeouts use the existing process cleanup and lifecycle.

## Development

```bash
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

Temporal and Code Factory are independent native launch daemons. The Atlas URI is read at launch
from the existing `mongodb-uri` Google Secret Manager secret and is never copied into Git or a
plist. Updating Code Factory does not restart Temporal or affect Atlas. Run
`deploy/macmini/install-code-factory.sh` on the Mac to install or update the services.

Agent output streams while the task runs. By default, an agent is stopped after 15 minutes
without stdout/stderr or two hours of total execution; configure positive values with
`CODE_FACTORY_AGENT_IDLE_TIMEOUT_SECONDS` and `CODE_FACTORY_AGENT_TIMEOUT_SECONDS`.
A final structured result gets a 10-second shutdown grace period, after which the factory
terminates the agent and its remaining children while retaining the result. Explicit agent
errors fail the task even when the CLI exits zero. Timeout failures retain recent output
(up to 2 MiB per stream) and the timeout reason.

A background reconciliation pass runs at startup and every 15 seconds to synchronize unfinished
Mongo records with closed Temporal workflows. Workflow failures, timeouts, termination, and
missing workflows become visible failures; transient Temporal outages leave task state alone.
Terminal status writes are conditional so a late queue acknowledgment or cancellation cannot
overwrite a completed result.
