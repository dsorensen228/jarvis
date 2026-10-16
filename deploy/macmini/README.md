# Mac mini code host

The Mac mini is the authoritative Git host and autonomous coding control plane for Jarvis and
Sherman. Its layout is:

```text
~/git/jarvis.git                    bare upstream repository
~/git/sherman.git                   bare upstream repository
~/jarvis-workspace/AGENTS.md        autonomous delivery policy
~/jarvis-workspace/jarvis/          primary Jarvis working clone
~/jarvis-workspace/sherman/         primary Sherman working clone
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

Cursor Agent uses `CURSOR_API_KEY` exported by the Mac's `.zshrc`; the key is passed directly to
the daemon process and is not copied into Git or its launchd plist.

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
