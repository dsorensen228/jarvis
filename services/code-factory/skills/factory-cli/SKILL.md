---
name: factory-cli
description: Build or review command-line tools used by unattended Code Factory tasks, with reliable subprocess input, output, and failure behavior.
---

Every required input must be available through arguments, environment configuration, or
documented stdin. Missing required input must exit with a useful error in unattended mode;
never open menus, read a TTY, launch login, or prompt for confirmation during a task.

Use bounded timeouts and retries, idempotent operations, and useful subcommand help/examples.
Preserve argument boundaries with subprocess argument arrays. Keep credentials out of command
lines and logs. Send diagnostics to stderr and machine-readable results to stdout where useful.
Define exit behavior for partial failure and cancellation; test child-process cleanup and closed
stdin as well as the successful path. Preview destructive changes and require authorization in
the submitted task; missing authorization produces failure rather than a question.
