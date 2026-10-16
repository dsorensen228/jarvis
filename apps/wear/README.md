# Jarvis for Wear OS

The Wear OS app preserves the original watch interaction: tap the Jarvis avatar to listen, speak a
command, read and hear the reply, tap again for another turn, or long-press to sign out. Android's
on-watch `SpeechRecognizer` supplies text; the Jetson runs the Jarvis turn and Kokoro synthesis.

The app uses only the v1 backend:

- Google Sign-In plus `POST /v1/auth/google` and `/v1/auth/refresh` for Jarvis sessions;
- `POST /v1/wear/chat` for a low-round-trip response plus mono PCM audio.

## Build

Create `local.properties` (never commit it):

```properties
sdk.dir=/Users/you/Library/Android/sdk
WEAR_API_BASE_URL=http://jarvis-api.local:8000
WEAR_GOOGLE_WEB_CLIENT_ID=your-web-oauth-client.apps.googleusercontent.com
```

The ID used by `requestIdToken` must be the Web OAuth client ID. The Google Cloud project must also
have an Android OAuth client for `com.jarvis.wearjarvis` and the signing certificate SHA-1.

Then build:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./gradlew :wear:assembleDebug
```

The APK is `wear/build/outputs/apk/debug/wear-debug.apk`. The package identities remain
`com.jarvis.wearjarvis` for release and `com.jarvis.wearjarvis.debug` for debug, so
this migration does not create an unrelated application on existing watches.

For a physical watch, enable developer options and wireless debugging, pair with `adb`, install the
APK, and verify microphone permission, token refresh, a multi-turn conversation, PCM playback, and
the 15-second auto-close behavior.
