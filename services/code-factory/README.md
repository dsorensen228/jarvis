# Code Factory

Code Factory is the native macOS control plane for autonomous work in the Jarvis workspace. It
accepts coding prompts over HTTP, records their complete lifecycle in Jarvis's existing MongoDB
Atlas instance, and uses a local Temporal server to execute one Cursor Agent task at a time.
Records live in `jarvis.code_factory_tasks`. The agent runs from
`~/jarvis-workspace`, so the external workspace-level `AGENTS.md` is the source of delivery
policy. It is deployment-local configuration and is intentionally not stored in this repository;
start from `deploy/macmini/workspace-AGENTS.example.md` when provisioning a new code host.

## API

```bash
curl -X POST http://code-host.local:8010/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"Add the requested feature and deploy it."}'

# Optional override; omit model to run Cursor with --model auto.
curl -X POST http://code-host.local:8010/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"Debug the failing service.","model":"gpt-5.6-sol-medium"}'

curl http://code-host.local:8010/v1/tasks
curl http://code-host.local:8010/v1/tasks/<task-id>
curl -X POST http://code-host.local:8010/v1/tasks/<task-id>/cancel
```

Statuses are `pending`, `queued`, `running`, `cancel_requested`, `cancelled`, `success`, and
`failed`. Callers submit a prompt and may pin one supported model for a particular task. With no
override, the factory explicitly invokes Cursor's automatic selector with `--model auto`. The
agent decides whether to change jarvis, sherman, or both. MongoDB retains the submitted prompt,
optional override, parsed agent JSON (when valid), raw standard
output/error, exit code, timestamps, changed paths, and whether a factory self-update was queued.

Task responses retain ordinary parsed results up to 32 KiB. Event-stream arrays return the final
result when present, or a preview of the assistant text when an agent exited without a result.
Larger results return a marked preview; complete structured output remains in Atlas.
Raw `stdout` and `stderr` are previews
of the last 4,000 characters per stream, prefixed with `[earlier output omitted]` when truncated.
MongoDB applies the preview before sending data to the factory, including on status updates;
the full captured logs remain stored in Atlas. This keeps list polling and task details usable
even when an agent fills its 2 MiB capture buffer. List responses default to 50 tasks and accept
`limit=1..200` and `status`; status repair runs in the background, so a list request never waits
for reconciliation of every active workflow. MongoDB reads have a 10-second deadline; result
writes allow 60 seconds to upload captured logs. Storage failures return a retryable HTTP 503
instead of retaining blocked reads indefinitely. Activities keep heartbeating while saving
results, so slow uploads do not turn completed work into a Temporal heartbeat timeout.

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
