#!/bin/zsh
set -euo pipefail

task_id=${1:-manual}
home_dir=${CODE_FACTORY_HOME:-/Users/example}
workspace=${CODE_FACTORY_WORKSPACE:-$home_dir/jarvis-workspace}
repo_dir=$workspace/jarvis
support_dir=$home_dir/Library/Application\ Support/JarvisCodeFactory
lock_dir=$support_dir/update.lock

sleep 10
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "A code-factory update is already running; task=$task_id"
  exit 0
fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

echo "Starting code-factory self-update for task $task_id"
cd "$repo_dir"
/usr/bin/git fetch origin main
if [[ "$(/usr/bin/git branch --show-current)" != "main" ]]; then
  echo "Refusing self-update because the primary Jarvis clone is not on main" >&2
  exit 1
fi
if [[ -n "$(/usr/bin/git status --porcelain)" ]]; then
  echo "Refusing self-update because the primary Jarvis clone is dirty" >&2
  exit 1
fi
/usr/bin/git merge --ff-only origin/main

# Refresh the launch definition and workspace skills as well as the Python package.
# The factory-only installer leaves Temporal running and verifies service readiness.
"$repo_dir/deploy/macmini/install-code-factory.sh" --factory-only
echo "Code-factory self-update completed for task $task_id"
