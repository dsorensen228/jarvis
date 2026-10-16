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

- The choice is irreversible, destructive, or security-sensitive (force push to main, deleting production data, changing secrets/prod, public exposure).
- Requirements conflict or success criteria are unknowable from context.
- You are blocked on credentials, access, or an external decision only the user can make.
- The user explicitly asked you to propose options and wait.

Do **not** escalate for: preferred approach among reasonable equivalents, whether to write tests for an obvious fix, naming bikesheds, "ready to implement?" after a clear request, or whether to commit finished work.

### After asking

If you must ask, ask the minimum once—batch related unknowns—then continue as far as you can without waiting when partial progress is possible.

## Git and delivery

- Commit when a logical unit of work is done. Do not wait for permission to commit.
- Push and open PRs when the work is ready for review or integration—again without asking first.
- Match existing commit message style; keep diffs focused on the task.
- Never commit secrets (`.env`, `credentials.json`, `gcp-credentials.json`, `terraform.tfvars`, etc.).

## Repository guidance

- This is a polyglot monorepo. Do not create a root Python environment or a single dependency
  resolver spanning independently deployed Python applications.
- Each deployable owns its runtime pin, manifest, lockfile, tests, and container definition.
- Put public cross-language schemas in `contracts/`; do not make one app import another app.
- The API has one v1 contract and one Jarvis agent. Do not add legacy operating modes or route
  aliases during migration.
- Keep model runtimes outside the API process.
- Migrate packages from Jarvis one at a time and leave unrelated source changes alone.
