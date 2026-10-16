#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is only for the Jarvis Mac code host." >&2
  exit 2
fi

factory_only=false
if [[ "${1:-}" == "--factory-only" ]]; then
  factory_only=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--factory-only]" >&2
  exit 2
fi

home_dir=$HOME
user_name=$(id -un)
workspace=${CODE_FACTORY_WORKSPACE:-$home_dir/jarvis-workspace}
research_workspace=${CODE_FACTORY_RESEARCH_WORKSPACE:-$home_dir/jarvis-research}
repo_dir=${CODE_FACTORY_REPO:-$workspace/jarvis}
service_dir=$repo_dir/services/code-factory
support_dir=$home_dir/Library/Application\ Support/JarvisCodeFactory
log_dir=$home_dir/Library/Logs/JarvisCodeFactory
generated_dir=$support_dir/launchd
workspace_policy=$workspace/AGENTS.md

mkdir -p "$support_dir" "$log_dir" "$generated_dir"

if [[ ! -s "$workspace_policy" ]]; then
  echo "Code Factory requires a customized policy at $workspace_policy." >&2
  echo "Copy deploy/macmini/workspace-AGENTS.example.md there and replace its example inventory before installing." >&2
  exit 2
fi

brew=/opt/homebrew/bin/brew
for formula in uv temporal tmux; do
  "$brew" list "$formula" >/dev/null 2>&1 || "$brew" install "$formula"
done

# Codex uses the service user's saved ChatGPT subscription login, including from launchd.
if [[ ! -x /opt/homebrew/bin/codex ]]; then
  "$brew" install --cask codex
fi
if ! /opt/homebrew/bin/codex -c 'cli_auth_credentials_store="file"' login status 2>&1 \
    | /usr/bin/grep -q 'Logged in using ChatGPT'; then
  echo "Sign in as $user_name: /opt/homebrew/bin/codex -c 'cli_auth_credentials_store=\"file\"' login" >&2
  exit 2
fi

# Workspace-scoped skills are shared by both repository roots, without changing user plugins.
mkdir -p "$workspace/.agents/skills"
for skill in "$service_dir"/skills/*; do
  target="$workspace/.agents/skills/${skill:t}"
  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "Preserving existing skill directory at $target; resolve the name conflict before installing." >&2
    exit 2
  fi
  ln -sfn "$skill" "$target"
done

gcloud=$home_dir/google-cloud-sdk/bin/gcloud
if [[ ! -x "$gcloud" ]]; then
  echo "Google Cloud CLI is required at $gcloud to retrieve the existing Atlas URI." >&2
  exit 2
fi
"$gcloud" secrets versions access latest \
  --secret=mongodb-uri --project=example-gcp-project >/dev/null

# Remove the standalone Mongo launch daemon created by the first Code Factory iteration. Tasks
# use Jarvis's existing Atlas instance and jarvis database instead.
/usr/bin/sudo -n /bin/launchctl bootout system/com.jarvis.mongodb >/dev/null 2>&1 || true
/usr/bin/sudo -n /bin/rm -f /Library/LaunchDaemons/com.jarvis.mongodb.plist

cd "$service_dir"
/opt/homebrew/bin/uv sync --locked
./.venv/bin/python "$repo_dir/deploy/macmini/configure-codex-profile.py"
CODE_FACTORY_WORKSPACE="$workspace" CODE_FACTORY_RESEARCH_WORKSPACE="$research_workspace" \
  ./.venv/bin/python -c 'from code_factory.config import Settings; from code_factory.research import initialize_workspace; initialize_workspace(Settings.from_env())'
/opt/homebrew/bin/uv run ruff check .
/opt/homebrew/bin/uv run ruff format --check .
/opt/homebrew/bin/uv run pytest

/usr/bin/install -m 0755 "$repo_dir/deploy/macmini/update-code-factory.sh" \
  "$support_dir/update-code-factory.sh"

render() {
  local source=$1
  local target=$2
  /usr/bin/sed \
    -e "s|__USER__|$user_name|g" \
    -e "s|__HOME__|$home_dir|g" \
    -e "s|__WORKSPACE__|$workspace|g" \
    -e "s|__RESEARCH_WORKSPACE__|$research_workspace|g" \
    -e "s|__REPO_DIR__|$repo_dir|g" \
    -e "s|__SUPPORT_DIR__|$support_dir|g" \
    -e "s|__LOG_DIR__|$log_dir|g" \
    "$source" >"$target"
}

labels=(code-factory)
if [[ "$factory_only" != true ]]; then
  labels=(temporal code-factory)
fi
for label in "${labels[@]}"; do
  render "$repo_dir/deploy/macmini/com.jarvis.$label.plist.in" \
    "$generated_dir/com.jarvis.$label.plist"
  /usr/bin/plutil -lint "$generated_dir/com.jarvis.$label.plist"
  /usr/bin/sudo -n /usr/bin/install -o root -g wheel -m 0644 \
    "$generated_dir/com.jarvis.$label.plist" "/Library/LaunchDaemons/com.jarvis.$label.plist"
  /usr/bin/sudo -n /bin/launchctl bootout "system/com.jarvis.$label" >/dev/null 2>&1 || true
  loaded=false
  for _ in {1..5}; do
    if /usr/bin/sudo -n /bin/launchctl bootstrap \
      system "/Library/LaunchDaemons/com.jarvis.$label.plist"; then
      loaded=true
      break
    fi
    sleep 1
  done
  if [[ "$loaded" != true ]]; then
    echo "Could not load com.jarvis.$label after five attempts." >&2
    exit 1
  fi
  /usr/bin/sudo -n /bin/launchctl enable "system/com.jarvis.$label"
done

for port in 7233 8010; do
  for _ in {1..60}; do
    /usr/bin/nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! /usr/bin/nc -z 127.0.0.1 "$port"; then
    echo "Service failed to listen on port $port" >&2
    exit 1
  fi
done

/usr/bin/curl --fail --silent --show-error http://127.0.0.1:8010/health/live
echo
/usr/bin/curl --fail --silent --show-error http://127.0.0.1:8010/health/ready
echo
echo "Code Factory installation complete."
