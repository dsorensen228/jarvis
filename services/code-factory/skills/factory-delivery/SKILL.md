---
name: factory-delivery
description: Implement, debug, verify, and deliver unattended Code Factory tasks across the Jarvis and Sherman workspace, including factory self-updates.
---

Read the external workspace AGENTS.md for the actual deployment inventory and delivery policy.
The submitted task authorizes its routine implementation and delivery. No human is available
during a factory run: infer ordinary details, make decisions, and never introduce an interview,
design approval, merge-choice menu, or permission checkpoint. An unresolved blocker must end
with a failed completion report after independent work is finished.

Use code, contracts, recent changes, logs, and a reproducible failing case to locate defects.
Trace the first incorrect state across component boundaries before changing downstream symptoms.
Test a concrete hypothesis, implement the smallest complete fix, and cover meaningful success
and failure behavior. For straightforward edits, use the relevant existing checks. Broaden tests
only when the change or evidence warrants it; do not repeat passing checks without a reason.

Keep independently deployed runtimes isolated. Choose jarvis, sherman, or both from the task.
Preserve unrelated changes and credentials. Follow the workspace policy to commit, integrate,
push, deploy affected targets, and inspect actual health. Use its existing Git origins and
installers. Resolve ordinary review findings and merge conflicts from evidence.

For Code Factory changes, verify the worker plus affected API/UI contracts. Never restart the
parent factory or run its installer from the agent child: the external updater reconciles the
merged code after the saved result. Explicitly identify any deferred self-update in the report.

Return the factory's completion schema. Report actual test/deployment evidence and material
assumptions concisely. Incomplete work is failed, even if the CLI itself returned zero.
