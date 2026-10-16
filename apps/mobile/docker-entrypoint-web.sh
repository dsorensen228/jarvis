#!/bin/sh
set -e
ROOT=/usr/share/nginx/html
OUT="$ROOT/runtime-env.js"
api=$(printf '%s' "${EXPO_PUBLIC_API_URL:-}" | sed 's/\\/\\\\/g; s/"/\\"/g')
google=$(printf '%s' "${EXPO_PUBLIC_GOOGLE_CLIENT_ID:-}" | sed 's/\\/\\\\/g; s/"/\\"/g')
apk=$(printf '%s' "${EXPO_PUBLIC_APK_DOWNLOAD_URL:-}" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf 'window.__RUNTIME_EXPO_PUBLIC__ = {"EXPO_PUBLIC_API_URL":"%s","EXPO_PUBLIC_GOOGLE_CLIENT_ID":"%s","EXPO_PUBLIC_APK_DOWNLOAD_URL":"%s"};\n' "$api" "$google" "$apk" >"$OUT"
if ! grep -q '/runtime-env.js' "$ROOT/index.html"; then
  sed -i 's#</head>#<script src="/runtime-env.js"></script></head>#' "$ROOT/index.html"
fi
exec nginx -g 'daemon off;'
