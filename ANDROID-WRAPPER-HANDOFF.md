# Android wrapper: handoff

Condensed from a review done on 25–26 September 2026 from the web-app repo
(`Shantai_mahila_bajar_app`, branch `prathamesh2`). Start a new session in the
wrapper's own folder with this file, and treat everything below as findings to
confirm, not settled fact — every claim names the line it came from.

## What this project is

- The Android APK for शांताई महिला बाजार (Shantai Mahila Bazar), a marketplace
  for rural women sellers in Maharashtra.
- An **Expo / React Native WebView** wrapper. `app/index.tsx` (636 lines) is the
  whole app. Its one screen loads the production web app over the network:
  `https://shantai-mahila-bajar-app-frontend.vercel.app/` (`SITE_URL`, line 54).
- Nothing of the site is bundled in. A Vercel deploy of the web app is an APK
  update; the APK is rebuilt only when the wrapper itself changes.
- Package name `com.siddharam_sutar.mywebviewapp` (cannot change after the first
  Play upload). Expo SDK 54, React Native 0.81, `react-native-webview` 13.16,
  `expo-notifications` 0.32. `android/` is committed (prebuilt).
- The web app, API and all business rules live in the other repo. Its
  `CLAUDE.md` ("Deployment shape") and `docs/DEPLOY.md` §6 describe this wrapper.

## Which repo and branch

**Use `https://github.com/Prathameshk2024/Android_app`, branch `sub-main`**
(commit `0e3af60`, 26 Sept 00:34). It is the only copy with everything.

| Repo / branch | State |
|---|---|
| `Prathameshk2024/Android_app` **`sub-main`** | Push notifications **and** the navigation fixes. Use this. |
| `Prathameshk2024/Android_app` `main` | Push, plus zoom-off and no-overscroll only. Missing the Back fix, last-page restore and sideways-drift fix. Do not build from it. |
| `ArpitaHanjagi/Android_App` `main` | Navigation fixes, **no push at all**. Superseded. |
| local `appgold-main` (named in the web repo's docs) | Not found on this machine. Superseded. |

`sub-main` contains (all verified in `app/index.tsx`):

- **Back** runs `window.history.back()` via `injectJavaScript` (line 250 on),
  never `webViewRef.goBack()`. This is load-bearing: native `goBack()` does not
  reliably keep `window.history.state`, React Router falls back to the key
  `"default"`, and the site's scroll memory breaks ("Back goes to the top").
- **Reopens on the last page**: `RESTORABLE_ROUTES` allow-list (line 63),
  `readSavedUrl`/`saveUrl` to `last-route.json`, plus a one-time Back step up
  to `/shop` or `/seller` after a cold launch on a deep page
  (`pendingUpTarget`, `window.location.replace`).
- **Sideways drift fix**: `LOCK_HORIZONTAL_SCROLL` injected CSS
  (`overscroll-behavior-x: none`). Its comment says never add an `overflow` rule
  to `<html>` — that breaks `window.scrollY` and the site's scroll restore.
- `setBuiltInZoomControls={false}`, `overScrollMode="never"`.
- **Push**: `orders` channel created on start (line 219), `onMessage` handler
  (line 523), `enablePush()` (line 206), tap-to-open (`tapPath`/`safePath`,
  lines 172–177), token rotation listener.
- **Start page rule**: tapped notification > saved last page > site root.
  `initialUrl` starts as the saved page; `getLastNotificationResponseAsync()`
  (line 228, now with `.catch`) swaps in the notification's page and re-aims
  `pendingUpTarget`.

> Line numbers above and below refer to `0e3af60`. The 26 September follow-up
> (see "Status after the follow-up") moved code around in `app/index.tsx`;
> search by name, not by line.

## The push handshake (contract with the web app)

1. The page (`frontend/src/lib/pushBridge.ts` in the web repo) posts
   `{ type: 'push:enable' }` through `window.ReactNativeWebView.postMessage` —
   only inside the APK, only when a seller or buyer is signed in, again on each
   sign-in and language change.
2. `window.ReactNativeWebView` exists **only because `onMessage` is set** on the
   WebView. Removing that prop silently disables push.
3. The wrapper asks Android permission and calls
   `window.__smbPushStatus(granted)` with the answer. If granted, it gets the
   FCM token (`getDevicePushTokenAsync`) and calls
   `window.__smbPushToken(token)`.
4. The page sends the token to `POST /api/push/token`. The server keeps the
   token on the session, so logout stops notifications.
5. On `granted === false` the page shows a card with a "सेटिंग उघडा" button,
   which posts `{ type: 'push:settings' }`; the wrapper calls
   `Linking.openSettings()`. When she returns to the app (`AppState` active)
   the wrapper re-checks and reports again, sending the token if now granted.
6. A notification's `data.path` is opened on tap only if it starts with `/` and
   not `//` or `/\` (`safePath`).

An APK built before this follow-up never calls `__smbPushStatus`, so the card
never shows there. That is intended, not a bug.

## Permissions: current state

`app.json` `android.permissions` and the main `AndroidManifest.xml` declare the
same list, and both block the two storage permissions:

| Permission | Why |
|---|---|
| `CAMERA` | Declared, never requested — keeps the photo picker gallery-only (below) |
| `INTERNET` | The site |
| `POST_NOTIFICATIONS` | Push on Android 13+. expo-notifications 0.32.17 also merges it in |
| `RECORD_AUDIO` | Voice typing |
| `VIBRATE` | Harmless; expo-haptics merges it in anyway |
| `READ_/WRITE_EXTERNAL_STORAGE` | **Blocked** (`tools:node="remove"` + `blockedPermissions`). `react-native-blob-util` merges them in |

Library manifests also merge in (checked in their published sources, not in a
built APK): `RECEIVE_BOOT_COMPLETED` (expo-notifications),
`ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `ACCESS_WIFI_STATE`,
`DOWNLOAD_WITHOUT_NOTIFICATION` (react-native-blob-util). All are normal-level;
none needs a Play declaration. Firebase Messaging comes in through Gradle and
was not checked.

Not needed at all: clipboard (the site only writes), gallery access (Android's
picker needs no permission), background running (FCM delivers to a closed app).

### Why `CAMERA` stays

Checked in `react-native-webview` 13.16 source (`RNCWebViewModuleImpl.
startPhotoPickerIntent` / `needsCameraPermission`): when the page opens
`<input type="file" accept="image/*">` (the web app's `PhotoPicker`):

- `CAMERA` declared but not granted → picker offers **gallery only**, no prompt.
  This matches the product rule "one photo, from the gallery".
- `CAMERA` removed → the picker **adds a "take photo" option** via the camera app.

So removing it changes behaviour. Leave a comment saying so. (Real camera
capture is on the web app's "not built yet" list; removing `CAMERA` is the
cheapest way to get it when wanted.)

### How to change permissions safely

- `android/` is committed, so editing `app.json` alone does nothing until
  `npx expo prebuild --platform android` — **never `--clean`**, which discards
  hand-made native changes. Commit first, prebuild, then diff `android/`.
  Or edit `app.json` and the manifest by hand, identically.
- Libraries merge their own permissions in. Check the final list with
  `aapt dump permissions <apk>`. Block an unwanted merged one with
  `android.blockedPermissions` in `app.json`.

## Status after the follow-up (26 September 2026)

Built as a release APK (debug-signed) and **tested on a Samsung Galaxy S24 FE
(Android 16) and a second phone on 26 September**: every item of the test
checklist below passed, except the mic (skipped). Testing found one bug, fixed
in `ea8689a`: the load-error screen took half the height and Android's English
"Web page not available" page showed above it — react-native-webview renders
`renderError`'s view beside the WebView, so it must cover it absolutely.

| # | Issue | State |
|---|---|---|
| 1 | Permission cleanup | Done; confirmed with `aapt` on the release APK |
| 2 | `POST_NOTIFICATIONS` | Done; present in the release APK |
| 3 | Refused permission invisible | Done in both repos (handshake steps 3 and 5) |
| 4 | Mic never requested | **Open**, not tested |
| 5 | Cold-start tap loads twice | Done: synchronous `getLastNotificationResponse()` in `launchTarget()` picks the start page before the first render; Back then steps up to `/seller` or `/shop` |
| 6 | Stale launch response | Done: `clearLastNotificationResponse()` after use (it exists in 0.32.17) |
| 7 | Cold-start tap navigates twice | Done: taps de-duplicated by notification identifier |
| 8 | Channel settings fixed | Comment at `setNotificationChannelAsync` |
| 9 | English pop-ups | Done: Marathi alerts, Marathi error screen with a retry button; the extra "WebView error" alert is gone |
| 10 | Debug keystore | Gradle ready; **the keystore itself does not exist yet** (below) |
| 11 | `debug-download.md` | Rewritten |

## Still to do

1. **Create the Play upload keystore** (command in `README.md`), put the four
   `SMB_UPLOAD_*` values in `~/.gradle/gradle.properties` on the building
   machine, and back the `.jks` and passwords up somewhere safe. Losing them
   means a Play support request to reset the upload key.
2. **Mic (issue 4)**: fresh install → tap a mic in a form. If the site shows its
   "denied" message, the cheapest fix is web-side: call
   `navigator.mediaDevices.getUserMedia({ audio: true })` once, stop the
   stream, then start recognition. Android System WebView may also not support
   the Web Speech API at all; then the site's "not supported" message is what
   she will see.
3. **Release to Play**: raise `versionCode`, build signed with the upload
   key, and run `aapt dump permissions` on that APK once more.
4. The wrapper's GitHub repo was renamed to `Prathameshk2024/SMB_android`
   (GitHub redirects the old URL). Update the local remote with
   `git remote set-url origin https://github.com/Prathameshk2024/SMB_android.git`,
   and the old name in this file and in the web repo's docs.
5. Optional: `npm uninstall react-native-blob-util`, since nothing calls it
   now. After that the storage blocks become redundant but harmless.

## Keep in mind

- **Never remove `onMessage`** from the WebView. It is what creates
  `window.ReactNativeWebView`, so push dies silently without it.
- **Never use `webViewRef.goBack()`** for Back; keep `window.history.back()`.
- **Never add an `overflow` rule to `<html>`** in injected CSS.
- **Never `expo prebuild --clean`**: `android/` has hand edits (manifest
  comments and `tools:node="remove"`, release signing in `app/build.gradle`).
  A plain prebuild can also rewrite the manifest; diff `android/` after one.
- **Keep `app.json` and `AndroidManifest.xml` permissions identical.**
- **Changing the notification channel** (importance, sound) needs a new
  channel id in `app/index.tsx` and in `app.json`'s `defaultChannel`
  (`default_notification_channel_id` in the manifest).
- **A new web route** that should reopen after a restart must be added to
  `RESTORABLE_ROUTES`; everything else is excluded by default.
- **Package name** `com.siddharam_sutar.mywebviewapp` is permanent after the
  first Play upload.
- `versionCode` is `1` in `android/app/build.gradle`; each Play upload needs
  it raised.
- Any location permission coming back (e.g. through a new library) means a
  Play declaration form. Run `aapt` after adding any native dependency.
- Xiaomi/Oppo/Vivo/Realme block closed-app notifications until Autostart is
  allowed and battery is "No restrictions"; the app cannot request that, and
  the web app's seller help card explains it.
- `components/HelloWave.tsx` and `ParallaxScrollView.tsx` are unused Expo
  template files that fail `tsc` (missing `react-native-reanimated`). Harmless,
  but they make `tsc -p .` noisy.

## Test checklist on a real phone

- Fresh install → sign in as seller → Android notification prompt appears now,
  not on the landing page.
- Order placed for that seller from another device: foreground, background, and
  swiped away — "नवीन ऑर्डर आले आहे" arrives with sound each time.
- Tap the notification with the app closed → opens that order directly (no
  flash of the last page); Back goes to `/seller`, Back again exits.
- Tap a notification with the app open → opens that order once.
- Refuse the prompt → the "फोनवर सूचना बंद आहेत" card appears → "सेटिंग उघडा"
  opens Android settings → turn notifications on → back in the app the card
  disappears. "नंतर करते" hides it until the app is closed.
- Fresh install → tap a mic in any form field → prompt or "denied" (issue 4).
- Add a product photo → picker shows gallery only.
- Airplane mode → cold launch → Marathi error screen; turn data on →
  "पुन्हा प्रयत्न करा" loads the site.
- UPI payment with no UPI app installed → Marathi pop-up.
- Scroll deep in the catalogue → open a product → Back → same place.
- Kill and reopen the app → reopens on the last page; Back steps up to
  `/shop` or `/seller` once, then exits.
- `aapt dump permissions` on the release APK matches the intended list.
