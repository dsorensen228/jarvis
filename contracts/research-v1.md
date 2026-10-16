# Research v1

Research is a manual Expo web/Android and Wear Factory feature. Its authenticated Jarvis endpoints are
under `/v1/research-tasks`; it is not exposed as a voice-agent tool. The Mac mini runs
research through the existing Code Factory queue and Codex process lifecycle.

Research shares the [durable task notification lifecycle](code-factory-v1.md): completion and failure
pushes use Android channel `task-status` with data
`{type: "research_task", task_id, status: "completed" | "failed"}`. The API records the authenticated
recipient on submission and monitors completion while the app is closed.

## Requests and lifecycle

`POST /v1/research-tasks` accepts:

```json
{"prompt":"Compare energy storage methods","model":"gpt-6-sol","verbosity":"standard"}
```

The prompt must contain text and be at most 32,000 characters. Model is required and
uses the same choices as coding: `gpt-5.6-terra`, `gpt-6-sol`, or `gpt-6-astra`.
`verbosity` defaults to `standard` and controls detail per point, not report length:

- `concise`: essential detail with minimal elaboration, covering the complete scope.
- `standard`: balanced explanation, context, and supporting evidence.
- `in_depth`: thorough reasoning, context, evidence, caveats, and implications.

An exhaustive concise list can be long. Every mode avoids filler and repetition.

The task uses the coding lifecycle statuses. List, detail, and activity snapshots add
`task_type: "research"`, `verbosity`, and `report_available` to ordinary task metadata.
They never include the HTML artifact.

- `GET /v1/research-tasks`: paginated `{items, next_cursor}`, with the same `limit`,
  `cursor`, `view`, and `status` semantics as [coding tasks](code-factory-v1.md).
- `GET /v1/research-tasks/{id}`: task detail.
- `POST /v1/research-tasks/{id}/cancel`: cancel the task.
- `GET /v1/research-tasks/{id}/output?after=0&limit=100`: incremental activity with
  `{items, next_after, has_more, truncated, task}`. Drain pages before waiting for updates.
- `GET /v1/research-tasks/{id}/report`: `{task_id, html}`, with `Cache-Control: no-store`.
  Only successful research with an available artifact can return a report; otherwise 404.

Coding endpoints reject research task IDs, and research endpoints reject coding IDs.
The internal factory `/v1/tasks` creation body additionally includes `task_type: "research"`.
Its list filter defaults to `code`, including historical records without a type.
Research clients request `task_type=research`; pagination cursors are bound to the type.

## HTML reports

Each run writes UTF-8 `report.html` under `CODE_FACTORY_RESEARCH_WORKSPACE/<task UUID>`
(default `~/jarvis-research`). The generated local `AGENTS.md` and research prompt specify
the report contract, source verification, depth, and workspace boundaries. Research skips
engineering Git inspection and factory self-updates.

Success requires a regular, nonempty HTML file containing meaningful semantic content.
The worker rejects symbolic or hard-linked files, devices, invalid UTF-8, and artifacts exceeding 2 MiB, then
sanitizes the HTML and persists it in MongoDB. This byte limit protects storage and viewers;
it is not a word or page target. Reports remain retrievable independently of the local file.

The report is a fragment. The viewer owns responsive typography, light/dark theme, and
these optional classes: `research-report`, `lead`, `callout`, `metric-grid`, `metric`,
`table-wrap`, `source-list`, and `muted`. Semantic tables and static inline SVG are supported.
SVG labels should inherit the theme or use `currentColor`; explicit shape colors remain valid.
External source links use HTTP(S), open outside the report, and receive `noopener noreferrer`.
Local `#id` links stay in the document.

Wear Factory retrieves the same report artifact and converts its semantic content into a native
reader (Wear OS does not provide WebView). It preserves prose and source URLs, reflows tables
into labeled rows, and exposes diagram titles, descriptions, and labels. Graphical originals
remain available in the web/Android viewers.

Scripts, CSS from the report, forms, embedded pages, external assets, and SVG animation are
removed. Web renders in a sandboxed iframe without scripts or same-origin access; Android
uses a WebView with JavaScript, file access, and storage disabled. Both wrap the fragment
in a trusted document with a restrictive content policy. Report HTML is never inserted
into the application's own document.
