#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mobile_dir="$repo_root/apps/mobile"
bucket=${APK_BUCKET:-example-jarvis-apks}
api_url=${EXPO_PUBLIC_API_URL:?Set EXPO_PUBLIC_API_URL to the browser-reachable Jarvis v1 API}
google_client_id=${EXPO_PUBLIC_GOOGLE_CLIENT_ID:?Set EXPO_PUBLIC_GOOGLE_CLIENT_ID to the Android OAuth web client ID}
apk_url=${EXPO_PUBLIC_APK_DOWNLOAD_URL:-https://storage.googleapis.com/example-jarvis-apks/releases/latest.apk}

# An APK can build successfully without Firebase and then silently fail to obtain
# a push token. Reject missing or unrelated client configuration before building.
node - "$mobile_dir" <<'NODE'
const fs = require('fs');
const path = require('path');
const mobileDir = process.argv[2];
try {
  const app = JSON.parse(fs.readFileSync(path.join(mobileDir, 'app.json'), 'utf8')).expo;
  const firebase = JSON.parse(fs.readFileSync(path.join(mobileDir, 'google-services.json'), 'utf8'));
  const client = firebase.client?.find(entry =>
    entry.client_info?.android_client_info?.package_name === app.android.package);
  if (!firebase.project_info?.project_number || !firebase.project_info?.project_id ||
      !client?.client_info?.mobilesdk_app_id || !client.api_key?.some(entry => entry.current_key)) {
    throw new Error('Firebase configuration does not match the Android package or is incomplete.');
  }
} catch (error) {
  console.error('Firebase Android configuration is required: save the matching google-services.json in apps/mobile before publishing.');
  process.exit(1);
}
NODE

lock_dir="$mobile_dir/.eas-apk-deploy.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  printf 'Another APK deployment is using %s.\n' "$mobile_dir" >&2
  exit 1
fi
tmp_dir=""
cleanup() {
  result=$?
  if [[ -n "$tmp_dir" && -f "$tmp_dir/eas.original.json" ]]; then
    cp -p "$tmp_dir/eas.original.json" "$mobile_dir/eas.json"
  fi
  rmdir "$lock_dir"
  if [[ -n "$tmp_dir" ]]; then
    if [[ "$result" -eq 0 ]]; then
      rm -rf "$tmp_dir"
    else
      printf 'APK deployment failed; build diagnostics retained in %s\n' "$tmp_dir" >&2
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/jarvis-apk.XXXXXX")
cp -p "$mobile_dir/eas.json" "$tmp_dir/eas.original.json"

# Shell variables reach local config evaluation but are not forwarded to EAS workers.
# Embed only the public runtime values in the uploaded build profile, then restore
# the exact local config on success, failure, or interruption.
node - "$mobile_dir/eas.json" "$api_url" "$google_client_id" "$apk_url" <<'NODE'
const fs = require('fs');
const [path, apiUrl, googleClientId, apkUrl] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
const profile = config.build.apk;
profile.env = {
  ...profile.env,
  EXPO_PUBLIC_API_URL: apiUrl,
  EXPO_PUBLIC_GOOGLE_CLIENT_ID: googleClientId,
  EXPO_PUBLIC_APK_DOWNLOAD_URL: apkUrl,
};
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

read -r version version_code < <(
  node -e '
    const config = require(process.argv[1]);
    process.stdout.write(`${config.expo.version} ${config.expo.android.versionCode}\n`);
  ' "$mobile_dir/app.json"
)

(
  cd "$mobile_dir"
  EXPO_PUBLIC_API_URL="$api_url" \
  EXPO_PUBLIC_GOOGLE_CLIENT_ID="$google_client_id" \
  EXPO_PUBLIC_APK_DOWNLOAD_URL="$apk_url" \
    npx eas-cli build \
      --platform android \
      --profile apk \
      --non-interactive \
      --wait \
      --json >"$tmp_dir/eas-build.log" 2>&1
)

artifact_url=$(
  node -e '
    const fs = require("fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const match = text.match(/\[\s*\{[\s\S]*\}\s*\]\s*$/);
    if (!match) throw new Error("EAS build output did not end with JSON");
    const [build] = JSON.parse(match[0]);
    if (build.status !== "FINISHED" || !build.artifacts?.buildUrl) {
      throw new Error(`EAS build did not finish successfully: ${build.status}`);
    }
    process.stdout.write(build.artifacts.buildUrl);
  ' "$tmp_dir/eas-build.log"
)

apk="$tmp_dir/jarvis-$version-$version_code.apk"
curl --fail --location --retry 3 --output "$apk" "$artifact_url"

versioned="gs://$bucket/releases/jarvis-$version-$version_code.apk"
latest="gs://$bucket/releases/latest.apk"
gcloud storage cp "$apk" "$versioned"
gcloud storage cp "$apk" "$latest"
gcloud storage objects update "$versioned" "$latest" \
  --content-type application/vnd.android.package-archive \
  --cache-control no-cache,max-age=0 \
  --content-disposition "attachment; filename=jarvis-android.apk"

printf 'Published Jarvis %s (%s) to %s and %s\n' "$version" "$version_code" "$versioned" "$latest"
