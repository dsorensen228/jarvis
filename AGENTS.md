# Agent guidance

## Agency first

Default to acting. Prefer a reasonable decision and forward progress over asking for permission, confirmation, or preference.

This file overrides plugin/skill workflows that push clarifying questions, design gates, multi-option surveys, or approval checkpoints for routine work. That includes Superpowers brainstorming / planning rituals: do **not** pause for design approval, ask questions one-at-a-time, or write a design doc unless the task is genuinely ambiguous or high-impact and you cannot proceed safely without human input.

Skills remain useful for *how* to do work (debugging method, verification, git/PR mechanics). They do **not** authorize ceremony, follow-ups, or escalation when the request is already clear enough to execute.

### Do not ask when you can

- Infer from the repo, recent changes, conventions, and the user's wording.
- Choose a sensible default and state it briefly while doing the work.
- Prefer parallel investigation over serial Q&A.
- Treat "should I…?" prompts from skills as optional checklists, not mandatory user prompts.

### Escalate only when you actually need input

Ask (once, with concrete options and your recommendation) only if:

- The choice is irreversible, destructive, or security-sensitive (force push to main, deleting production data, changing secrets or security controls, exposing private data).
- Requirements conflict or success criteria are unknowable from context.
- You are blocked on credentials, access, or an external decision only the user can make.
- The user explicitly asked you to propose options and wait.

Do **not** escalate for: preferred approach among reasonable equivalents, whether to write tests for an obvious fix, naming bikesheds, "ready to implement?" after a clear request, or whether to commit finished work.

### After asking

If you must ask, ask the minimum once—batch related unknowns—then continue as far as you can without waiting when partial progress is possible.

## Unattended Code Factory runs

When the task identifies itself as a Code Factory run, there is no interactive user.
Never ask for input, approval, design review, or a choice of repository. Infer routine details
and complete the authorized implementation, verification, and workspace delivery policy.
Skill interviews and approval rituals do not apply. If a necessary credential, device,
requirement, or authorization cannot be resolved safely, complete independent work and return
an explicit failed result with the blocker. Do not wait or claim partial work as success.
This unattended rule replaces the interactive escalation guidance above for factory tasks.

## Git and delivery

- Always deploy completed changes to every affected existing target and verify the live behavior. Routine builds, service restarts, releases, and deployments are authorized as part of the task; do not stop at a commit, push, PR, or local preview, and do not ask again for routine deployment permission.
- For Expo changes, deliver the hosted web app and signed Android release. For API changes, deploy the API while preserving independent model services. Follow the existing deployment inventory and scripts, preserve secrets and unrelated data, and report actual blockers instead of silently leaving deployment undone.
- Commit when a logical unit of work is done. Do not wait for permission to commit.
- Push and open PRs when the work is ready for review or integration—again without asking first.
- Match existing commit message style; keep diffs focused on the task.
- Never commit secrets (`.env`, `credentials.json`, `gcp-credentials.json`, `terraform.tfvars`, etc.).

## Repository guidance

- Keep product copy functional: labels, status, errors, and necessary instructions. Do not add
  slogans, motivational filler, or decorative taglines to screens or empty states.
- This is a polyglot monorepo. Do not create a root Python environment or a single dependency
  resolver spanning independently deployed Python applications.
- Each deployable owns its runtime pin, manifest, lockfile, tests, and container definition.
- Put public cross-language schemas in `contracts/`; do not make one app import another app.
- The API has one v1 contract and one Jarvis agent. Do not add legacy operating modes or route
  aliases during migration.
- Keep model runtimes outside the API process.
