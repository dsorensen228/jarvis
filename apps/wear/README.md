# Jarvis for Wear OS

The Wear OS app preserves the original watch interaction: tap the Jarvis avatar to listen, speak a
command, read and hear the reply, tap again for another turn, or long-press to sign out. Android's
on-watch `SpeechRecognizer` supplies text; the Jetson runs the Jarvis turn and Kokoro synthesis.

The app uses only the v1 backend:

- Google Sign-In plus `POST /v1/auth/google` and `/v1/auth/refresh` for Jarvis sessions;
- `POST /v1/wear/chat` with `Accept: text/event-stream` for immediate response text followed by
  mono PCM audio. The [Wear stream contract](../../contracts/realtime/wear-v1.md) defines the events.

Tapping lights the purple listening rim. While Jarvis thinks, two purple arcs orbit the avatar,
matching the voice device. The first response text replaces the avatar immediately and continues
to update as it streams; speech plays when synthesis finishes. Long replies can be scrolled.
The shared Jarvis agent includes named light controls and smart-device/TV controls alongside its
existing tools; no separate watch tool catalog is needed.

## Build

Create `local.properties` (never commit it):

```properties
sdk.dir=/Users/you/Library/Android/sdk
WEAR_API_BASE_URL=https://jarvis-api.example.com
WEAR_GOOGLE_WEB_CLIENT_ID=your-web-oauth-client.apps.googleusercontent.com
```

The ID used by `requestIdToken` must be the Web OAuth client ID. The Google Cloud project must also
have an Android OAuth client for `com.jarvis.wearjarvis` and the signing certificate SHA-1.

The API URL defaults to the same public tunnel as mobile and Wear Code Factory. Android
emulators may not resolve `jarvis-api.local`; replace that value in an existing `local.properties`
and rebuild/reinstall the APK. Saved LAN, loopback, and `.local` addresses automatically use the
build default on upgrade, so existing installations can reach Jarvis away from home Wi-Fi.
Explicit public URLs remain supported. Resolve network failures before diagnosing Google sign-in.

Then build:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./gradlew :wear:assembleDebug :wear:testDebugUnitTest :wear:assembleDebugAndroidTest
```

The APK is `wear/build/outputs/apk/debug/wear-debug.apk`. The package identities remain
`com.jarvis.wearjarvis` for release and `com.jarvis.wearjarvis.debug` for debug, so
this migration does not create an unrelated application on existing watches.

For a physical watch, enable developer options and wireless debugging, pair with `adb`, install the
APK, and verify microphone permission, token refresh, a multi-turn conversation, PCM playback, and
the 15-second auto-close behavior.

The existing Mac mini Wear emulator uses the debug package and that host's debug signing key;
build on that host and install with `adb -s emulator-5556 install -r` to preserve its sign-in.
Run `:wear:connectedDebugAndroidTest` with only the Wear target selected (`ANDROID_SERIAL`) for
the listening → thinking → streamed-text UI regression. A physical release requires the watch's
existing release signing configuration; do not replace it with a newly generated key.
