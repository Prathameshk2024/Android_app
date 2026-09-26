# Downloads in the wrapper

The site no longer starts any download inside the APK. The handler in
`app/index.tsx` (`handleDownload`) is kept as a safety net only.

- `onShouldStartLoadWithRequest` treats a URL as a download when it contains a
  file extension (`.csv`, `.pdf`, `.xlsx`, `.xls`, `.doc(x)`, `.txt`, `.zip`) or
  `download=`, `attachment=` or `export=`.
- The file is fetched with `expo-file-system` into the app's own document
  folder, then offered to Android's share sheet (`expo-sharing`). That needs no
  permission on any Android version.
- The APK declares **no** storage permission. `react-native-blob-util` merges
  `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` in; the main
  `AndroidManifest.xml` removes them (`tools:node="remove"`) and `app.json`
  blocks them (`blockedPermissions`). Nothing calls `react-native-blob-util`
  any more, so it can be uninstalled.

To check a download by hand: `npx react-native log-android`, then look for
`Intercepted URL` and `Download error`.
