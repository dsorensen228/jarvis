# Code Factory for Wear OS

Standalone Wear OS client for [Code Factory](../../services/code-factory/README.md). It uses the
same Google Sign-In plus Jarvis session flow as the Jarvis watch app:

- Google Sign-In with `POST /v1/auth/google` and `/v1/auth/refresh`;
- authenticated coding and research endpoints on the Jarvis API.

Open the app to scroll a list of coding tasks. All, Active, and History filters use cursor
pagination; older tasks load automatically as you reach the end. Refresh retries failures without
signing you out for a temporary network error. Task detail streams live activity, reconnects from
its last event, and closes the connection when the watch sleeps or you leave the screen. Finished
results use readable, scrollable text. Stop a queued/running task or dictate a follow-up; follow-ups
run after the original task finishes and preserve its context. The plus control creates a prompt: tap the purple
terminal logo to start on-watch speech recognition, tap again to stop (30-second timeout, no
end-of-speech detection), then confirm the transcript. The agent chooses whether to change jarvis,
sherman, or both. Select Terra, Sol, or Astra; Sol starts selected and a model is always required.

Swipe horizontally between **Code** and **Research** at the task lists. Each mode keeps its own
All/Active/History filter, loaded pages, and scroll position. The two-dot indicator identifies the
current page. Paging is disabled inside a task, prompt, or report; swipe right or use Back to
return to the parent screen. On the first list, swiping from the left edge exits the app.

Research uses the same dictate-and-confirm flow with a required model and Concise, Standard
(default), or In depth report detail. Open a task to view progress or stop it. Research activity
polls the incremental output endpoint while visible; it stops when the watch sleeps or the mode
is hidden. Completed tasks with reports offer **Read report**. Research has no coding follow-up
action because the research API does not support it.

Reports render as native, unscaled text because Wear OS does not support WebView. Compact text
uses 12sp with 17sp line spacing; **Larger text** uses 14sp, and both respect system font scaling.
Use the crown/bezel or vertical swipes to read, and **Sections** to jump to headings. Full prose,
lists, source labels and URLs are retained. Tables become labeled rows; diagrams show their
titles, descriptions, and text labels, with a notice when the graphic needs the phone/web viewer.
The watch does not execute HTML or load linked content. Original graphical reports remain
available in the mobile/web app.

The navigation follows [Wear paging guidance](https://developer.android.com/training/wearables/compose/pagination)
and the [essential-text minimum](https://developer.android.com/docs/quality-guidelines/wear-app-quality).
The reader avoids [unsupported WebView](https://developer.android.com/develop/ui/views/layout/webapps/managing-webview).

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
  ./gradlew :wear:assembleDebug :wear:testDebugUnitTest :wear:lintDebug
```

The APK is `wear/build/outputs/apk/debug/wear-debug.apk`.

For device verification, build `:wear:assembleDebugAndroidTest`, install both APKs with `adb
install -r`, then run `am instrument -w` with
`com.jarvis.wearfactory.debug.test/androidx.test.runner.AndroidJUnitRunner`. Installing in
place preserves the existing account. The suite covers mode gestures, independent filters,
research confirmation, report section jumps/retry, and the existing code-task controls.
`LiveResearchSmokeTest` skips by default; enable it with `-e liveResearch true` to read the
installed account's existing code/research history and a completed report without creating tasks.

The existing deployment target is the Mac mini's `Wear_OS_XL_Round` emulator (`emulator-5556`).
Build on that host with its existing `local.properties` and signing key, then update the installed
debug package in place. There is no configured physical-watch release target or Wear release
signing/publishing pipeline in this project.

Android emulators may not resolve mDNS names such as `jarvis-api.local`. Use the public default
above, or a reachable LAN IP for a deliberate local override. Rebuild/install after changing
`WEAR_API_BASE_URL`; an old APK retains its compiled URL. Network resolution failures must be
fixed before evaluating sign-in.
