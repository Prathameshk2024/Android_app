import * as FileSystem from 'expo-file-system';
import { Paths } from 'expo-file-system';
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

export default function AppScreen() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);

  // Handle back press
  useEffect(() => {
    const backAction = () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
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
        source={{ uri: 'https://shantai-mahila-bajar-app-frontend.vercel.app/' }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        originWhitelist={['*']}
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
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
        onNavigationStateChange={(navState) => setCanGoBack(navState.canGoBack)}
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
