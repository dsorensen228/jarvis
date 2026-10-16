#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mobile_dir="$repo_root/apps/mobile"
bucket=${APK_BUCKET:-example-jarvis-apks}
api_url=${EXPO_PUBLIC_API_URL:?Set EXPO_PUBLIC_API_URL to the browser-reachable Jarvis v1 API}
google_client_id=${EXPO_PUBLIC_GOOGLE_CLIENT_ID:?Set EXPO_PUBLIC_GOOGLE_CLIENT_ID to the Android OAuth web client ID}
apk_url=${EXPO_PUBLIC_APK_DOWNLOAD_URL:-https://storage.googleapis.com/example-jarvis-apks/releases/latest.apk}
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/jarvis-apk.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

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
