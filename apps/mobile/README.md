# Jarvis mobile and web app

The Expo 52 application targets Android, iOS, and web. It uses the canonical Jarvis `/v1` API for
chat, projects, todos, shopping lists, timers, integrations, devices, cameras, and settings.

Live microphone/audio chat was intentionally removed during migration. Message text-to-speech and
local timer alarm audio remain.

```bash
npm ci
EXPO_PUBLIC_API_URL=http://jarvis-api.local:8000 \
EXPO_PUBLIC_GOOGLE_CLIENT_ID=your-web-oauth-client.apps.googleusercontent.com \
  npm run typecheck
EXPO_PUBLIC_API_URL=http://jarvis-api.local:8000 \
EXPO_PUBLIC_GOOGLE_CLIENT_ID=your-web-oauth-client.apps.googleusercontent.com \
  npm run build:web
```

Google Sign-In exchanges a Google ID token at `POST /v1/auth/google`; the API maps an explicitly
allowlisted Google subject to the local Jarvis owner. The hosted web image accepts the API URL and
Web OAuth client ID as Docker build arguments and rewrites both from the Cloud Run environment at
startup. Use `scripts/deploy-mobile-web.sh` from the repository root to build with Cloud Build and
deploy the existing Cloud Run `web` service. Set `NO_TRAFFIC=true` to create a tagged revision
without moving production traffic.

The Settings → About screen links to `EXPO_PUBLIC_APK_DOWNLOAD_URL`. The deploy script defaults to
the public, stable `example-jarvis-apks/releases/latest.apk` object; replace that object only with
an APK signed by the existing EAS Android key so installed copies can upgrade in place.

Publish a signed Android build with `scripts/deploy-mobile-apk.sh`. It waits for the EAS `apk`
profile, uploads an immutable versioned copy, and replaces the stable Settings download target.

## Android system notifications

Door person detections and completed/failed coding or research tasks use Expo push delivery.
The signed APK needs `apps/mobile/google-services.json` from the existing Firebase Android app
for `com.jarvis.app`, plus that Firebase project's FCM v1 sending credential configured
on the existing EAS project. The client configuration is ignored by Git and included in the EAS
build archive; service-account keys must never be added to the repository or build archive.
The APK deployment script rejects missing or mismatched Firebase client configuration.

After upgrading, open Jarvis and sign in. Android channels are created before requesting
notification permission, then the app registers its Expo token with the API. Registration
retries after connection recovery, returning to the app, or native token changes. Settings →
App & connections → System notifications shows registration status, a retry action, and a
shortcut to Android notification settings. An Android permission previously denied permanently
must be enabled there. Phone updates preserve that system preference.

The API sends alerts while the app is in the background. Door alerts open their camera; coding
and research alerts open the corresponding task, including when an alert launches the app.
