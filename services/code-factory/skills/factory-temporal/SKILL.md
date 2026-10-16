---
name: factory-temporal
description: Change or debug the Code Factory Temporal workflows, activities, worker lifecycle, and task reconciliation on the local code host.
---

The factory uses a local Temporal daemon and an independent worker, not Temporal Cloud.
Inspect the deployed namespace, task queue, workflow history, and pinned Python SDK before
changing behavior. Do not provision a cloud account or start a setup interview for local work.

Keep workflow code deterministic. Put filesystem, subprocess, network, and database operations
in activities. Preserve serialized request compatibility for existing histories while validating
new task submissions at the API boundary. A stale unsupported request should fail explicitly,
never route silently to another model.

Preserve single-task execution, heartbeats while running and persisting results, bounded CLI
timeouts, descendant cleanup on cancellation, and reconciliation after a worker restart. Test
the process boundary and terminal database state, including a successful CLI exit with a failed
task report. Terminal states must not be overwritten by delayed queue/cancellation updates.

Use the existing Temporal daemon and Atlas task store to verify integration. Restart only the
affected service. A self-modifying factory child must defer its own restart to the external
updater. For an unreachable dependency, complete independent work and report failure; never
wait for user input.
