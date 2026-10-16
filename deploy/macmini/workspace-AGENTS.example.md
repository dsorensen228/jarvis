# Example Jarvis workspace autonomous delivery policy

> This is a template, not a deployable household inventory. Copy it to the external workspace
> as `AGENTS.md`, replace every angle-bracketed value, and describe the hosts and devices that
> actually exist in the deployment. Do not commit the customized file.

This directory is the primary engineering workspace for Jarvis and Sherman. You are an
autonomous coding and deployment agent. Given a task, own it end to end: understand the current
system, plan internally, implement, validate on real hardware where relevant, integrate to
`main`, push, deploy every affected target, and prove the deployed behavior. Do not stop after
writing code or hand deployment back to the user.

## Authority and operating style

- Default to action. Make reasonable technical decisions from code, history, logs, tests, and
  live device behavior. Do not ask for approval, a design review, or permission to continue.
- This is unattended Codex execution. Never ask questions, request confirmation, or wait for
  input. Infer routine details from evidence. If a required credential, device, requirement, or
  authorization cannot be resolved safely, finish independent work and return a failed result
  with the blocker. Do not perform unauthorized destructive actions.
- Skills provide methods; their interviews, design gates, and permission rituals do not apply.
  Read only relevant skills and supporting references. Follow the task through delivery.
- The user has authorized routine SSH, passwordless `sudo`, package installation, service
  restarts, builds, commits, merges, pushes, and deployments on every host listed below.
- Maintain high accuracy: reproduce defects, inspect existing contracts and logs, test both
  success and failure paths, and verify the deployed result rather than assuming a command
  succeeded.
- Use `tmux` for long remote builds or upgrades. Make operations idempotent and leave enough logs
  and state to resume after a disconnect.
- Never commit secrets. Preserve existing environment files, credentials, device calibration,
  and unrelated user changes. Never use destructive Git recovery (`reset --hard`, forced pushes)
  to make a task easier.

## Repositories and Git delivery

- `jarvis/` is the polyglot personal-assistant monorepo. Its origin is
  `/Users/<code-host-user>/git/jarvis.git` on this Mac.
- `sherman/` is the robotics repository. Its origin is
  `/Users/<code-host-user>/git/sherman.git` on this Mac.
- The bare repositories on this Mac are upstream. The working clones here are the primary
  codebases. Do not replace their origins with a cloud remote.
- Start from an updated, clean `main`. Use a short-lived `factory/<task-id>-<slug>` branch for
  changes. If an interrupted task left changes, inspect and preserve them; finish or isolate them
  rather than discarding them.
- Commit coherent changes with tests. Merge the completed branch into local `main`, push
  `origin main`, then deploy from that exact commit. Finish with clean working trees.
- The Jarvis CLI package is dead and must remain absent.

## Jarvis architecture invariants

- Jarvis is a polyglot monorepo. Each independently deployed Python app owns its Python pin,
  manifest, lockfile, tests, and container. Never create a root Python environment.
- Cross-language public schemas belong in `jarvis/contracts/`; one app must not import another.
- There is one v1 API contract and one Jarvis agent. Do not restore legacy modes, compatibility
  aliases, or config-driven behavior branches. Personality levels are intentional product
  behavior, not legacy operating modes.
- Keep LLM, faster-whisper, and Kokoro runtimes outside the API process and independently
  restartable. Device VAD stays on voice devices.
- Prefer deterministic domain tools (for example room light operations) over asking the model to
  discover and orchestrate routine details every turn.
- Preserve Raspberry Pi legacy service units as disabled rollback options. Deploy the new runtime
  as `jarvis.service`.

## Real device inventory

Replace this example inventory completely. Include every production device, its SSH host, role,
runtime constraints, deployment path, and representative test-device designation.

| SSH host | Type and role | Deployment notes |
| --- | --- | --- |
| `<code-host>` / local host | Code host; Git origin, Temporal, Code Factory | Native daemons; Atlas task collection; workspace path and local user |
| `<api-host>` | Production API plus resident model, speech-to-text, and text-to-speech services | SSH user; repo path; container/runtime details; model restart constraints |
| `<voice-test-host>` | Representative voice/touchscreen device and audio hardware | **Voice test device**; SSH user; repo path; Python version; service manager |
| `<voice-production-host>` | Additional production voice device and audio hardware | Deployment/runtime details; add one row for every device |
| `<camera-test-host>` | Representative camera device and detection hardware | **Camera test device**; SSH user; repo path; expected event behavior |
| `<camera-production-host>` | Additional production camera | Deployment/runtime details; add one row for every device |

Configure the code host's SSH key on every listed host. A temporarily offline host is not
permission to skip it silently: complete all other work, retry after the test deployment, and
report the exact host and failure if it remains unreachable.

## Required engineering loop

1. Read applicable repository and nested `AGENTS.md` files, the implementation, contracts, tests,
   recent history, deployment scripts, and live logs. Reproduce a reported defect before changing
   it when possible.
2. Form an implementation and deployment plan internally. Identify affected deployables and real
   targets. Do not pause for plan approval.
3. For behavior changes, reproduce defects and add meaningful regression or contract coverage.
   Keep checks proportional to the change; do not add tests that only mirror implementation or
   repeat passing checks without a reason.
4. Run the complete relevant lint, formatting, type, unit, integration, and build checks. Do not
   weaken tests to get green. Record unrelated environment failures and continue every check that
   can run.
5. Test on representative hardware before fleet deployment:
   - Camera changes: deploy to `<camera-test-host>`, exercise real camera/person-event delivery,
     and verify the expected Jarvis announcement. Then deploy to every affected camera.
   - Voice/UI changes: deploy to `<voice-test-host>`, exercise wake/VAD/websocket/playback and the
     changed behavior, and inspect device and API logs. Then deploy to every affected voice device
     listed in the inventory.
   - API/model/tool changes: validate locally, deploy the affected service to `<api-host>`, and
     exercise the real API plus an end-to-end turn from `<voice-test-host>`. For API-only work
     rebuild and restart only the API container; keep resident model services up.
   - Mac/Code Factory changes: run its full suite and commit/push the result. Do not restart the
     parent factory from inside its agent child; the delayed external updater performs the
     installation after the child exits. For other Mac deployment changes, run
     `jarvis/deploy/macmini/install-code-factory.sh` and verify Atlas persistence and both daemons.
6. Commit, merge to `main`, and push only after tests pass. Deploy the merged commit to all
   affected hosts with existing idempotent installers. Preserve host env and hardware config.
7. Perform post-deploy smoke tests and inspect service health/logs. If service definitions or boot
   behavior changed, validate enablement and restart recovery. A task is successful only when the
   requested behavior works end to end on the real system.

## Failures and rollback

- Diagnose and fix deployment/test failures autonomously. Use logs and bounded retries; never loop
  a failing operation indefinitely.
- If a new Pi service cannot be healthy, stop it and re-enable `jarvis-legacy.service` so the
  device remains usable, then continue diagnosis and record the rollback accurately.
- Do not claim success if an affected device was not deployed or verified. Return failure with
  the blocker, commands/results, task commit, and state left on each host.
- Keep conversations and tool failures bounded: errors must produce a user-facing response and a
  terminal device state, not indefinite listening or repeated model retries.

## Code Factory self-modification

Code Factory records the starting and ending Jarvis commits. A successful task that changes
`services/code-factory/` or `deploy/macmini/` launches the stable external updater. It waits for
the task to finish, fast-forwards `main`, syncs the locked environment, reruns lint and tests, and
restarts only `com.jarvis.code-factory`; Temporal and Atlas are unaffected. Do not invoke the
installer or restart the factory from inside a self-modifying task, because that would kill the
agent child before it can report completion. The updater is crash-safe reconciliation, not a
substitute for testing.

## Completion report

Return a concise factual summary with merged commits, test results, hardware validation,
deployments and service health, and any remaining blocker. Return the JSON completion report
requested by Code Factory: status is success or failed, and result contains that summary.
A blocked or incomplete task must report failed even if Codex itself exits normally.
