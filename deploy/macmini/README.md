# Mac mini code host

The Mac mini is the authoritative Git host and autonomous coding control plane for Jarvis and
Sherman. Its layout is:

```text
~/git/jarvis.git                    bare upstream repository
~/git/sherman.git                   bare upstream repository
~/jarvis-workspace/AGENTS.md        autonomous delivery policy
~/jarvis-workspace/jarvis/          primary Jarvis working clone
~/jarvis-workspace/sherman/         primary Sherman working clone
~/jarvis-research/AGENTS.md         maintained research policy
~/jarvis-research/<task-id>/        per-task research files and report.html
```

Code Factory writes to the existing MongoDB Atlas instance in
`jarvis.code_factory_tasks`; it does not create a second Mongo instance or database. It
retrieves the URI from the existing `mongodb-uri` Google Secret Manager secret at launch.
Temporal and Code Factory run as separate native launch daemons, so the factory can restart after
changing itself without disturbing task state or Temporal history.

Run the idempotent installer from the Mac clone:

```bash
cd ~/jarvis-workspace/jarvis
deploy/macmini/install-code-factory.sh
```

Logs and persistent data are under `~/Library/Application Support/JarvisCodeFactory/` and
`~/Library/Logs/JarvisCodeFactory/`.

```bash
sudo launchctl print system/com.jarvis.temporal
sudo launchctl print system/com.jarvis.code-factory
curl http://localhost:8010/health/ready
```

Code Factory uses `/opt/homebrew/bin/codex` and the service user's ChatGPT subscription.
The installer installs the CLI when absent and checks for a saved ChatGPT login before restarting
services. On the Mac mini, sign in once as the service user (never root):

```bash
/opt/homebrew/bin/codex -c cli_auth_credentials_store='"file"' login
```

Use `login --device-auth` if signing in through SSH. Expired sessions require sign-in again;
`login status` checks stored credentials, so also run a small task to verify live access.
Credentials remain in `~/.codex/auth.json`; never copy them into a plist, Git, or task output.
The daemon runs a noninteractive shell and does not load `.zshrc` or require a Cursor/API key.

The installer makes factory-specific skills discoverable under
`~/jarvis-workspace/.agents/skills/`. Keep deployment inventory in the external `AGENTS.md` and
Codex MCP connections in the user's `~/.codex/config.toml`. Configure the mobile emulator MCP
with the existing local server command using `codex mcp add`; use the existing Atlas credentials
through the code host's credential provider. Do not copy Cursor-specific skills, approval gates,
or plugin paths into Codex. The owned skills describe equivalent unattended workflows.

The existing code host uses `mobile-mcp` for phone/watch control and the connected MongoDB
Atlas plugin for managed Atlas tools. Install and connect that plugin in the Mac mini's Codex
app; the CLI inherits it. Do not add a duplicate standalone Atlas MCP registration. Register
the existing emulator server command and provision the factory profile:

```bash
codex mcp add mobile-mcp -- /absolute/path/to/node /absolute/path/to/mobile-mcp/lib/index.js
# Provision the dedicated profile (the installer also runs this after uv sync):
services/code-factory/.venv/bin/python deploy/macmini/configure-codex-profile.py
codex --profile code-factory mcp list
codex plugin list --json
```

The worker selects file storage for MCP OAuth as well as ChatGPT auth, so the daemon can use
those sessions without Keychain interaction. Keep endpoint commands and credentials private.
Verify both tools from the daemon environment before declaring a new installation ready.
The profile sets `default_tools_approval_mode = "approve"` for the emulator server to retain
unattended MCP operations, and preserves an existing factory profile on subsequent installs.
It inherits user plugins and other tools while keeping this registration independent of desktop config
rewrites. The run's `approval_policy="never"` prevents
interactive approval or elicitation prompts; missing access is reported as a task failure.

All task clients must send one of `gpt-5.6-terra`, `gpt-6-sol`, or `gpt-6-astra`. Deploy the API
and UI updates with the worker because model selection is now required. Sol is the UI default.
The self-updater rerenders the factory launch daemon and refreshes its skills before restarting
only Code Factory. Temporal stays running.

## Configure the private workspace policy

The real `~/jarvis-workspace/AGENTS.md` is deployment-local configuration. It contains the
household's actual device inventory, SSH hosts, test-device assignments, and deployment details,
so it must not be committed to this repository. The installer requires it and preserves it on
every subsequent update.

For a new installation, copy the sanitized example and customize every placeholder before
running the installer:

```bash
mkdir -p ~/jarvis-workspace
cp ~/jarvis-workspace/jarvis/deploy/macmini/workspace-AGENTS.example.md \
  ~/jarvis-workspace/AGENTS.md
${EDITOR:-vi} ~/jarvis-workspace/AGENTS.md
cd ~/jarvis-workspace/jarvis
deploy/macmini/install-code-factory.sh
```

List every real production device, not only the representative test devices. When devices are
added or retired, update the external policy directly; repository updates will not overwrite it.


## Research workspace and reports

The installer initializes `~/jarvis-research` and renders `CODE_FACTORY_RESEARCH_WORKSPACE`
into the daemon environment. Set that variable before installation to choose another location;
it must be outside the engineering workspace and cannot contain it. The self-updater preserves
the running daemon's configured path when it reruns the factory installer.

The packaged `services/code-factory/src/code_factory/prompts/research-AGENTS.md` is the canonical
research policy. Installation and each research run refresh the research root policy, and each
task gets its own copy. Do not put deployment inventory or engineering skills in this directory.
The private engineering `~/jarvis-workspace/AGENTS.md` remains deployment-local and preserved.
The shared Codex process still has host access: workspace policy separates the work, not OS
permissions. Research tasks skip Git reconciliation and never schedule a factory self-update.

Reports are bounded to 2 MiB, validated and sanitized, then stored in the existing Atlas task
collection. Local `report.html` files may contain the agent's unsanitized original; clients
must use the stored report endpoint, not serve workspace files directly. The factory exposes
`GET /v1/tasks/{id}/report` as `{task_id, html}` only after successful research. Other task
responses contain `report_available` but omit HTML. See the
[worker report contract](../../services/code-factory/README.md#research-reports) for depth
semantics, filtering, follow-ups, and supported markup.

After deploying worker and API changes, submit a research task with a supported model, check
its progress and terminal status, fetch its report through the authenticated API, and confirm
that ordinary coding listings still contain historical coding tasks only.
