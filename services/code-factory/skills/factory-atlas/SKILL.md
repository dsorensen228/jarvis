---
name: factory-atlas
description: Diagnose and verify Jarvis MongoDB Atlas persistence, queries, indexes, and schema changes during unattended Code Factory tasks.
---

Use the existing Atlas deployment and intended collection; do not substitute local MongoDB.
Discover the configured MongoDB MCP tools or use the deployable's existing database client
and credential provider. Never print connection strings, tokens, or personal records. If a
required connection cannot be established, report a failed task without requesting credentials.

Inspect collection schemas, indexes, and representative projected records before writing a
query. Verify field names and types; bound reads with filters, projections, and limits. Trace
empty results to filters, types, and actual data. Preserve the application's driver conventions.

For performance work, compare explain plans and examined/returned counts for the actual query.
Check existing indexes before proposing an additional one. For schema work, use observed access
patterns, bounded embedded data, document size limits, and migration/recovery requirements.
Inspect existing search/vector indexes when the task concerns those features; do not prescribe
a new search product for ordinary database filtering.

Routine narrowly scoped writes required by the submitted task and workspace policy are already
authorized. Do not add approval prompts. Preserve production records outside that scope; never
perform broad destructive operations without task authorization. Use uniquely identified test
fixtures and remove only those fixtures. Verify the intended precondition and postcondition.
Finish independent work and return failure if necessary authorization or access is missing.
