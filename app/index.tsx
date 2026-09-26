import * as FileSystem from 'expo-file-system';
import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { WebView } from 'react-native-webview';

// The `.hscroll` product carousels chain their horizontal overscroll to the page, which made the
// whole page drift sideways on a left/right swipe. `overscroll-behavior-x: none` severs that
// chain. Horizontal scrolling itself is already prevented by the site's own `body{overflow-x:
// hidden}`, which propagates to the viewport.
//
// Do NOT add an `overflow` rule to <html> here. The site sets `html,body,#root{height:100%}`, so
// making <html> non-visible stops body's overflow from propagating to the viewport and applies it
// to <body> instead - turning the fixed-height body into the scroll container. `window.scrollY`
// then reads 0 forever, and the site's scroll restoration (which saves/restores window.scrollY)
// silently breaks, sending Explore back to the top on every return.
const LOCK_HORIZONTAL_SCROLL = `
  (function () {
    var id = 'rn-lock-horizontal-scroll';
    if (!document.getElementById(id)) {
      var style = document.createElement('style');
      style.id = id;
      style.textContent = 'body{overscroll-behavior-x:none}';
      document.head.appendChild(style);
    }
  })();
  true;
`;

// ---------------------------------------------------------------------------------------------
// Last-page restoration
//
// A browser keeps the URL, so reopening the site lands you where you were. This WebView hardcoded
// the site root, so every cold launch restarted at "/" and the site then routed to home/dashboard.
// We persist the last *stable* route and use it as the WebView's initial source.
//
// The login token lives in localStorage ("wb.token"), which survives the app process, so a
// restored deep route stays authenticated. There is deliberately no expiry on the saved route:
// if the user is still authenticated, restore it however long ago they were last here. If the
// token has expired server-side, the site's own guards redirect to login exactly as they do today.
const SITE_URL = 'https://shantai-mahila-bajar-app-frontend.vercel.app/';
const SITE_ORIGIN = 'https://shantai-mahila-bajar-app-frontend.vercel.app';
const LAST_ROUTE_FILE = 'last-route.json';

// Default-deny allowlist. `:param` matches exactly one non-empty segment, and matching is on the
// full segment list, so nothing is matched by prefix: /seller/products is restorable while
// /seller/products/:productId/edit is not. Every route absent from this list is excluded, which
// covers /, the auth funnel, /shop/checkout, /shop/placed/:orderId, /seller/payment,
// /seller/waiting, /seller/upload and the two /edit forms.
const RESTORABLE_ROUTES = [
  // Customer
  '/shop',
  '/shop/cart',
  '/shop/orders',
  '/shop/categories',
  '/shop/c/:categoryId',
  '/shop/orders/:orderId',
  '/shop/profile',
  '/shop/notifications',
  '/shop/p/:productId',
  '/shop/seller/:sellerId',
  // Seller
  '/seller',
  '/seller/notifications',
  '/seller/orders',
  '/seller/help',
  '/seller/orders/:orderId',
  '/seller/products',
  '/seller/growth',
  '/seller/buyers',
  '/seller/profile',
  '/seller/reviews',
  '/seller/subscription',
];

const segmentsOf = (pathname: string) => pathname.split('/').filter(Boolean);

function isRestorablePath(pathname: string): boolean {
  const parts = segmentsOf(pathname);
  if (parts.length === 0) return false;
  return RESTORABLE_ROUTES.some((route) => {
    const pattern = segmentsOf(route);
    if (pattern.length !== parts.length) return false;
    return pattern.every((seg, i) => (seg.startsWith(':') ? parts[i].length > 0 : seg === parts[i]));
  });
}

// Same-origin + allowlisted. Applied on save *and* on read, so tightening the list later can
// never strand someone on a route that has since been excluded.
function isRestorableUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === SITE_ORIGIN && isRestorablePath(url.pathname);
  } catch {
    return false;
  }
}

// Cold-launch "up" target. Returns the section root for a restored *deep* route, or null when no
// up-step is warranted: a restored route that is already /shop or /seller, a non-restored launch
// (the site root), or anything off-origin. Note /shop/seller/:sellerId is a customer route, and
// keying off the first segment resolves it to /shop correctly.
function sectionRootFor(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== SITE_ORIGIN) return null;
    const parts = segmentsOf(url.pathname);
    if (parts.length < 2) return null;
    if (parts[0] === 'shop') return SITE_ORIGIN + '/shop';
    if (parts[0] === 'seller') return SITE_ORIGIN + '/seller';
    return null;
  } catch {
    return null;
  }
}

// Synchronous on purpose: this is read inside the useState initialiser, during the first render,
// before the WebView mounts. The WebView therefore gets its final `source` on its first and only
// render - no loading gate, no second navigation, and no home/dashboard flash.
function readSavedUrl(): string | null {
  try {
    const file = new File(Paths.document, LAST_ROUTE_FILE);
    if (!file.exists) return null;
    const saved = JSON.parse(file.textSync());
    return typeof saved?.url === 'string' && isRestorableUrl(saved.url) ? saved.url : null;
  } catch {
    return null;
  }
}

// Fire-and-forget. A storage failure must never affect navigation, so everything is swallowed.
function saveUrl(rawUrl: string): void {
  try {
    const file = new File(Paths.document, LAST_ROUTE_FILE);
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    // savedAt is recorded for diagnostics only - it is never used to expire the saved route.
    file.write(JSON.stringify({ url: rawUrl, savedAt: Date.now() }));
  } catch {}
}
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Push notifications
// Show the notification even while the app is open on another screen.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * A tap may only open one of OUR pages: a path, never a URL, never "//host"
 * and never "/\host" either - location.assign (and every browser) treats a
 * leading backslash as a slash, so "/\evil.com" is "//evil.com" in disguise.
 */
function safePath(p: unknown): string | null {
  return typeof p === 'string' && /^\/(?![\/\\])/.test(p) ? p : null;
}

/** FCM data can arrive in either place depending on how Android delivered it. */
function tapPath(r: Notifications.NotificationResponse | null): string | null {
  const req = r?.notification.request;
  const fromContent = (req?.content.data as { path?: unknown } | undefined)?.path;
  const fromTrigger = (req?.trigger as { remoteMessage?: { data?: { path?: unknown } } } | undefined)
    ?.remoteMessage?.data?.path;
  return safePath(fromContent ?? fromTrigger);
}

/**
 * The page to open on launch: a tapped notification > the saved last page > the site root.
 * Synchronous, like readSavedUrl, so a notification launch also gets its final `source` on the
 * first render - no detour through the saved page, and Back from the order steps up to /seller or
 * /shop rather than to whatever page happened to be saved.
 */
function launchTarget(): { url: string; tapId: string | null } {
  try {
    const r = Notifications.getLastNotificationResponse();
    const p = tapPath(r);
    if (p) return { url: SITE_ORIGIN + p, tapId: r!.notification.request.identifier };
  } catch (err) {
    // A failure here leaves the restored route in place rather than blanking the screen.
    console.warn('notification launch lookup failed', err);
  }
  return { url: readSavedUrl() ?? SITE_URL, tapId: null };
}
// ---------------------------------------------------------------------------------------------

export default function AppScreen() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  // Resolved once, before the WebView mounts, so `source` never changes and never reloads.
  const [launch] = useState(launchTarget);
  const initialUrl = launch.url;
  // The tap already acted on, so the launch tap is not replayed by the listener below.
  const handledTapId = useRef<string | null>(launch.tapId);
  const lastSavedUrl = useRef<string | null>(null);
  // Armed only when the app cold-launched on a deep route; consumed after one use.
  const pendingUpTarget = useRef<string | null>(sectionRootFor(initialUrl));
  const currentUrl = useRef<string>(initialUrl);
  const [loading, setLoading] = useState(true);
  // Set once the page has asked for push; null until then. Re-checked on every return to the
  // app, because the only way to turn a refused permission back on is in Android's settings.
  const pushGranted = useRef<boolean | null>(null);

  const sendTokenToPage = (token: string) => {
    webViewRef.current?.injectJavaScript(
      `window.__smbPushToken && window.__smbPushToken(${JSON.stringify(token)}); true;`,
    );
  };

  // Tells the page whether notifications can reach her, so a refusal is not invisible.
  const sendStatusToPage = (granted: boolean) => {
    webViewRef.current?.injectJavaScript(
      `window.__smbPushStatus && window.__smbPushStatus(${granted}); true;`,
    );
  };

  const reportPush = async (granted: boolean) => {
    pushGranted.current = granted;
    sendStatusToPage(granted);
    if (!granted) return;
    const t = await Notifications.getDevicePushTokenAsync();
    sendTokenToPage(String(t.data));
  };

  const enablePush = async () => {
    try {
      // After two refusals Android stops showing the prompt and this answers "denied" at once.
      const perm = await Notifications.requestPermissionsAsync();
      await reportPush(perm.status === 'granted');
    } catch (err) {
      console.warn('push setup failed', err);
    }
  };

  useEffect(() => {
    // Android 13 asks permission only for an app that has a channel.
    // A channel's importance and sound are fixed by Android once it exists. Changing them means a
    // new id here AND in app.json's expo-notifications `defaultChannel` (which writes the
    // default_notification_channel_id meta-data in AndroidManifest.xml).
    void Notifications.setNotificationChannelAsync('orders', {
      name: 'ऑर्डर व सूचना',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      lightColor: '#7b1e2e',
    });
    // The launch tap has been acted on; clear it so it can never reopen an old order later.
    if (handledTapId.current) {
      try {
        Notifications.clearLastNotificationResponse();
      } catch {}
    }
    const tap = Notifications.addNotificationResponseReceivedListener((r) => {
      const id = r.notification.request.identifier;
      if (id === handledTapId.current) return;
      handledTapId.current = id;
      try {
        Notifications.clearLastNotificationResponse();
      } catch {}
      const p = tapPath(r);
      if (p) webViewRef.current?.injectJavaScript(`window.location.assign(${JSON.stringify(p)}); true;`);
    });
    const rotate = Notifications.addPushTokenListener((t) => sendTokenToPage(String(t.data)));
    // Back from Android's settings: if she changed the notification permission there, say so.
    const resume = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || pushGranted.current === null) return;
      Notifications.getPermissionsAsync()
        .then((perm) => {
          const granted = perm.status === 'granted';
          if (granted !== pushGranted.current) return reportPush(granted);
        })
        .catch((err) => console.warn('push re-check failed', err));
    });
    return () => {
      tap.remove();
      rotate.remove();
      resume.remove();
    };
  }, []);

  // Handle back press
  useEffect(() => {
    const backAction = () => {
      if (canGoBack && webViewRef.current) {
        // Go back through the page's own history, exactly like the browser's Back button.
        // Native webView.goBack() traverses Android's WebBackForwardList instead, and does not
        // reliably round-trip window.history.state. React Router keeps `idx` and `key` in that
        // state, and falls back to the literal key "default" when it is missing - which collapses
        // every route onto one key and corrupts its scroll-position Map.
        webViewRef.current.injectJavaScript('window.history.back(); true;');
        return true;
      }
      // Cold-launch only. The app opened directly on a restored deep route, so the WebView has no
      // history behind it and Back would otherwise exit the app. Step up to the section root once.
      // Guarded on still being inside that section, so a logged-out redirect (e.g. /login/customer)
      // falls through and exits normally instead of jumping to /shop or /seller.
      if (
        pendingUpTarget.current &&
        sectionRootFor(currentUrl.current) === pendingUpTarget.current &&
        webViewRef.current
      ) {
        const target = pendingUpTarget.current;
        pendingUpTarget.current = null;
        // `replace`, not `assign`: it overwrites the deep entry rather than stacking on top of it,
        // so once at /shop or /seller the history is empty again and Back exits the app - the same
        // behaviour as a normal launch. Normal WebView/site navigation continues untouched.
        webViewRef.current.injectJavaScript(
          `window.location.replace(${JSON.stringify(target)}); true;`
        );
        return true;
      }
      return false;
    };
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [canGoBack]);

  // Downloads. The site no longer starts any inside the APK, so this is a safety net: fetch into
  // the app's own storage (no permission needed on any Android version) and offer to share it.
  // The old react-native-blob-util path needed the storage permissions and was never reached,
  // because this one catches its own errors.
  const handleDownload = async (url: string) => {
    try {
      const fileName = url.split('/').pop()?.split('?')[0] || `file_${Date.now()}`;
      const result = await FileSystem.downloadAsync(url, Paths.document.uri + fileName);
      if (result.status !== 200) throw new Error(`status ${result.status}`);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('फाइल डाउनलोड झाली', fileName);
        return;
      }
      Alert.alert('फाइल डाउनलोड झाली', 'ही फाइल पाठवायची आहे का?', [
        { text: 'नाही', style: 'cancel' },
        {
          text: 'पाठवा',
          onPress: () => {
            Sharing.shareAsync(result.uri).catch((err) => console.error('Share error:', err));
          },
        },
      ]);
    } catch (error) {
      console.error('Download error:', error);
      Alert.alert('फाइल डाउनलोड झाली नाही', 'इंटरनेट तपासा आणि पुन्हा प्रयत्न करा.');
    }
  };

  // Handle external apps (UPI payments, WhatsApp, Phone calls, Email, etc.)
  const handleExternalUrl = async (url: string) => {
    try {
      console.log('Opening external URL:', url);
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        // Attempt open anyway as fallback
        await Linking.openURL(url);
      }
    } catch (error) {
      console.error('Failed to open external app:', error);
      if (url.toLowerCase().startsWith('upi:')) {
        Alert.alert(
          'UPI ॲप सापडले नाही',
          'पैसे भरण्यासाठी Google Pay, PhonePe, Paytm किंवा BHIM यांपैकी एखादे UPI ॲप फोनमध्ये इन्स्टॉल करा.'
        );
      } else {
        Alert.alert('हे उघडता आले नाही', 'हे उघडणारे ॲप या फोनमध्ये नाही.');
      }
    }
  };

  return (
    <View style={styles.container}>
      {loading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#2196F3" />
        </View>
      )}
      <WebView
        ref={webViewRef}
        source={{ uri: initialUrl }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        originWhitelist={['*']}
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        // Disable pinch-to-zoom on Android (maps to WebSettings.builtInZoomControls)
        setBuiltInZoomControls={false}
        // Stop Android 12+ stretch overscroll from springing/wobbling the page at scroll edges
        overScrollMode="never"
        injectedJavaScript={LOCK_HORIZONTAL_SCROLL}
        // Also what makes window.ReactNativeWebView exist in the page at all.
        onMessage={(e) => {
          try {
            const type = JSON.parse(e.nativeEvent.data)?.type;
            if (type === 'push:enable') void enablePush();
            // The page's "turn notifications on" button, shown after she refused the prompt.
            if (type === 'push:settings') void Linking.openSettings();
          } catch {
            // Not ours.
          }
        }}
        onShouldStartLoadWithRequest={(request) => {
          console.log('Intercepted URL:', request.url);
          const rawUrl = request.url;
          const lowerUrl = rawUrl.toLowerCase();

          // 1. Intercept external protocols (UPI payments, WhatsApp, Tel, Mailto, etc.)
          const isWebProtocol =
            lowerUrl.startsWith('http://') ||
            lowerUrl.startsWith('https://') ||
            lowerUrl.startsWith('about:') ||
            lowerUrl.startsWith('data:') ||
            lowerUrl.startsWith('blob:');

          if (!isWebProtocol) {
            handleExternalUrl(rawUrl);
            return false; // Prevent WebView from trying to navigate internally to custom scheme
          }

          // 2. Enhanced file detection - check for common file extensions and download parameters
          const isDownloadFile = 
            lowerUrl.includes('.csv') ||
            lowerUrl.includes('.pdf') || 
            lowerUrl.includes('.xlsx') ||
            lowerUrl.includes('.xls') ||
            lowerUrl.includes('.doc') ||
            lowerUrl.includes('.docx') ||
            lowerUrl.includes('.txt') ||
            lowerUrl.includes('.zip') ||
            lowerUrl.includes('download=') ||
            lowerUrl.includes('attachment=') ||
            lowerUrl.includes('export=') ||
            rawUrl.includes('Content-Disposition');

          if (isDownloadFile) {
            console.log('Detected download URL, initiating download...');
            handleDownload(rawUrl);
            return false; // prevent WebView from navigating
          }
          
          return true; // allow normal navigation
        }}
        onNavigationStateChange={(navState) => {
          setCanGoBack(navState.canGoBack);
          currentUrl.current = navState.url;
          // Persist the last stable route. Skipped mid-load, and deduped because this callback
          // fires several times per navigation.
          if (
            !navState.loading &&
            navState.url !== lastSavedUrl.current &&
            isRestorableUrl(navState.url)
          ) {
            lastSavedUrl.current = navState.url;
            saveUrl(navState.url);
          }
        }}
        onLoadEnd={() => setLoading(false)}
        onError={({ nativeEvent }) => {
          if (nativeEvent.description?.includes('ERR_UNKNOWN_URL_SCHEME')) {
            return;
          }
          // renderError below shows her what went wrong; a pop-up on top only repeated it in English.
          console.warn('WebView error: ', nativeEvent);
        }}
        startInLoadingState={true}
        // react-native-webview renders this view BESIDE the WebView (siblings in one column), not
        // instead of it, so both views below must cover the WebView absolutely - otherwise
        // Android's English "Web page not available" page shows in the other half of the screen.
        renderError={(errorName) => {
          if (errorName?.includes('ERR_UNKNOWN_URL_SCHEME')) {
            return (
              <View style={styles.errorContainer}>
                <ActivityIndicator size="large" color="#2196F3" />
              </View>
            );
          }
          return (
            <View style={styles.errorContainer}>
              <Text style={styles.errorTitle}>पान उघडता आले नाही</Text>
              <Text style={styles.errorBody}>इंटरनेट चालू आहे का ते पहा आणि पुन्हा प्रयत्न करा.</Text>
              <Pressable style={styles.errorButton} onPress={() => webViewRef.current?.reload()}>
                <Text style={styles.errorButtonText}>पुन्हा प्रयत्न करा</Text>
              </Pressable>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    margin: 0,
    padding: 0,
    backgroundColor: '#fff',
  },
  webview: {
    flex: 1,
    margin: 0,
    padding: 0,
  },
  errorContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#7b1e2e',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 16,
    color: '#333',
    marginBottom: 24,
    textAlign: 'center',
  },
  errorButton: {
    backgroundColor: '#7b1e2e',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  errorButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.8)',
    zIndex: 1,
  },
});
