# Code Factory for Wear OS

Standalone Wear OS client for [Code Factory](../../services/code-factory/README.md). It uses the
same Google Sign-In plus Jarvis session flow as the Jarvis watch app:

- Google Sign-In with `POST /v1/auth/google` and `/v1/auth/refresh`;
- authenticated `GET/POST /v1/code-tasks` on the Jarvis API.

Open the app to scroll a list of coding tasks. The plus control creates a prompt: tap the purple
terminal logo to start on-watch speech recognition, tap again to stop (30-second timeout, no
end-of-speech detection), then confirm the transcript. The agent chooses whether to change jarvis,
sherman, or both.

## Build

Create `local.properties` (never commit it):

```properties
sdk.dir=/Users/you/Library/Android/sdk
WEAR_API_BASE_URL=https://jarvis-api.example.com
WEAR_GOOGLE_WEB_CLIENT_ID=your-web-oauth-client.apps.googleusercontent.com
```

`WEAR_API_BASE_URL` defaults to the same reserved Jetson ngrok tunnel as the Expo mobile app so
the watch works off home Wi-Fi. Override only when you intentionally want a LAN URL.

`requestIdToken` must use the Web OAuth client ID. The Google Cloud project must also have an
Android OAuth client for `com.jarvis.wearfactory` (and `com.jarvis.wearfactory.debug`
for debug builds) with the signing certificate SHA-1.

Then build:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./gradlew :wear:assembleDebug :wear:testDebugUnitTest
```

The APK is `wear/build/outputs/apk/debug/wear-debug.apk`.
