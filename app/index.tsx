import * as FileSystem from 'expo-file-system';
import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Linking,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  View
} from 'react-native';
import RNBlobUtil from 'react-native-blob-util';
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
// ---------------------------------------------------------------------------------------------

export default function AppScreen() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  // Resolved once, before the WebView mounts, so `source` never changes and never reloads.
  // A tapped notification outranks the saved route, which outranks the site root. The
  // notification answer only arrives asynchronously, so this is the one thing that may change
  // `source` after mount, and only on a notification launch.
  const [initialUrl, setInitialUrl] = useState(() => readSavedUrl() ?? SITE_URL);
  const lastSavedUrl = useRef<string | null>(null);
  // Armed only when the app cold-launched on a restored deep route; consumed after one use.
  const pendingUpTarget = useRef<string | null>(sectionRootFor(initialUrl));
  const currentUrl = useRef<string>(initialUrl);
  const [loading, setLoading] = useState(true);

  const sendTokenToPage = (token: string) => {
    webViewRef.current?.injectJavaScript(
      `window.__smbPushToken && window.__smbPushToken(${JSON.stringify(token)}); true;`,
    );
  };

  const enablePush = async () => {
    try {
      const perm = await Notifications.requestPermissionsAsync();
      if (perm.status !== 'granted') return;
      const t = await Notifications.getDevicePushTokenAsync();
      sendTokenToPage(String(t.data));
    } catch (err) {
      console.warn('push setup failed', err);
    }
  };

  useEffect(() => {
    // Android 13 asks permission only for an app that has a channel.
    void Notifications.setNotificationChannelAsync('orders', {
      name: 'ऑर्डर व सूचना',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      lightColor: '#7b1e2e',
    });
    // Cold launch from a tapped notification: open that page instead of the restored route, and
    // re-aim the one-time "up" step at whichever page won. A failure here leaves the restored
    // route in place rather than blanking the screen, hence the catch.
    Notifications.getLastNotificationResponseAsync()
      .then((r) => {
        const p = tapPath(r);
        if (!p) return;
        const url = SITE_ORIGIN + p;
        setInitialUrl(url);
        pendingUpTarget.current = sectionRootFor(url);
      })
      .catch((err) => console.warn('notification launch lookup failed', err));
    const tap = Notifications.addNotificationResponseReceivedListener((r) => {
      const p = tapPath(r);
      if (p) webViewRef.current?.injectJavaScript(`window.location.assign(${JSON.stringify(p)}); true;`);
    });
    const rotate = Notifications.addPushTokenListener((t) => sendTokenToPage(String(t.data)));
    return () => {
      tap.remove();
      rotate.remove();
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

  // Alternative download using Expo FileSystem (better for modern Android)
  const handleDownloadWithExpo = async (url: string) => {
    try {
      console.log('Starting Expo download for URL:', url);
      
      // Extract filename
      const urlParts = url.split('/');
      const fileName = urlParts[urlParts.length - 1].split('?')[0] || `file_${Date.now()}.csv`;
      const fileUri = Paths.document.uri + fileName;
      
      console.log('Downloading to:', fileUri);
      
      // Show loading indicator
      Alert.alert('Download Started', 'Your file is being downloaded...');
      
      // Download the file
      const downloadResult = await FileSystem.downloadAsync(url, fileUri);
      
      console.log('Download result:', downloadResult);
      
      if (downloadResult.status === 200) {
        // Check if sharing is available
        const isAvailable = await Sharing.isAvailableAsync();
        
        if (isAvailable) {
          Alert.alert(
            'Download Complete',
            'File downloaded successfully! Would you like to share it?',
            [
              { text: 'Cancel', style: 'cancel' },
              { 
                text: 'Share', 
                onPress: async () => {
                  try {
                    await Sharing.shareAsync(downloadResult.uri);
                  } catch (shareError) {
                    console.error('Share error:', shareError);
                    Alert.alert('Share Failed', 'Could not share the file.');
                  }
                }
              }
            ]
          );
        } else {
          Alert.alert('Download Complete', `File saved to: ${downloadResult.uri}`);
        }
      } else {
        throw new Error(`Download failed with status: ${downloadResult.status}`);
      }
      
      return false;
    } catch (error) {
      console.error('Expo download error:', error);
      Alert.alert(
        'Download Failed', 
        `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
      );
      return false;
    }
  };

  // Download handler with fallback strategy
  const handleDownload = async (url: string) => {
    try {
      console.log('Starting download for URL:', url);
      
      // For modern Android versions, prefer Expo FileSystem approach
      if (Platform.OS === 'android') {
        // Try Expo approach first (works better on Android 11+)
        try {
          return await handleDownloadWithExpo(url);
        } catch (expoError) {
          console.log('Expo download failed, trying RNBlobUtil:', expoError);
          // Fallback to RNBlobUtil approach
        }
      }
      
      // Original RNBlobUtil approach (fallback or iOS)
      if (Platform.OS === 'android') {
        const permissions = [
          PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
        ];

        const granted = await PermissionsAndroid.requestMultiple(permissions);
        
        console.log('Permissions granted:', granted);
        
        const hasPermission = Object.values(granted).some(
          permission => permission === PermissionsAndroid.RESULTS.GRANTED
        );
        
        if (!hasPermission) {
          // If permissions denied, try Expo approach as fallback
          console.log('Permissions denied, trying Expo approach...');
          return await handleDownloadWithExpo(url);
        }
      }

      const { fs, config } = RNBlobUtil;
      
      const urlParts = url.split('/');
      const fileName = urlParts[urlParts.length - 1].split('?')[0];
      const ext = fileName.includes('.') ? fileName.split('.').pop() : 'csv';
      const timestamp = new Date().getTime();
      const downloadFileName = `file_${timestamp}.${ext}`;
      
      console.log('RNBlobUtil download config:', {
        fileName: downloadFileName,
        extension: ext,
        downloadDir: fs.dirs.DownloadDir
      });

      const downloadConfig = {
        fileCache: true,
        appendExt: ext,
        addAndroidDownloads: {
          useDownloadManager: true,
          notification: true,
          mime: getMimeType(ext || 'csv'),
          description: 'Downloading file...',
          mediaScannable: true,
        },
      };

      console.log('Starting RNBlobUtil fetch...');

      config(downloadConfig)
        .fetch('GET', url, {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        })
        .then((res) => {
          console.log('RNBlobUtil download successful:', res.path());
          Alert.alert(
            'Download Complete', 
            `File saved successfully!\nPath: ${res.path()}`,
            [{ text: 'OK' }]
          );
        })
        .catch(async (err) => {
          console.error('RNBlobUtil download error:', err);
          // Final fallback to Expo approach
          console.log('RNBlobUtil failed, final attempt with Expo...');
          try {
            return await handleDownloadWithExpo(url);
          } catch {
            Alert.alert(
              'Download Failed', 
              `All download methods failed. Error: ${err.message || 'Unknown error occurred'}`,
              [{ text: 'OK' }]
            );
          }
        });

      return false;
    } catch (error) {
      console.error('Download handler error:', error);
      // Final fallback to Expo
      try {
        return await handleDownloadWithExpo(url);
      } catch {
        Alert.alert(
          'Download Error', 
          `Failed to start download: ${error instanceof Error ? error.message : 'Unknown error'}`,
          [{ text: 'OK' }]
        );
        return false;
      }
    }
  };

  // Helper function to get MIME type based on file extension
  const getMimeType = (extension: string): string => {
    const mimeTypes: { [key: string]: string } = {
      'pdf': 'application/pdf',
      'csv': 'text/csv',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls': 'application/vnd.ms-excel',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'txt': 'text/plain',
      'zip': 'application/zip',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
    };
    return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
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
          'UPI App Not Found',
          'Please install a UPI payment app like Google Pay, PhonePe, Paytm, or BHIM to complete this payment.'
        );
      } else {
        Alert.alert('Cannot Open App', 'No application found on your device to handle this action.');
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
            if (JSON.parse(e.nativeEvent.data)?.type === 'push:enable') void enablePush();
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
          Alert.alert('WebView error', nativeEvent.description);
          console.warn('WebView error: ', nativeEvent);
        }}
        startInLoadingState={true}
        renderError={(errorName) => {
          if (errorName?.includes('ERR_UNKNOWN_URL_SCHEME')) {
            return (
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#2196F3" />
              </View>
            );
          }
          return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: 'red' }}>Failed to load page: {errorName}</Text>
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
