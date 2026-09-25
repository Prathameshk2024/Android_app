# Download Debug Guide

## Issues Found and Fixed

### 1. **Android Permissions Issue**

- **Problem**: Using deprecated `WRITE_EXTERNAL_STORAGE` for Android 13+
- **Solution**: Added multiple permission requests and fallback to Expo FileSystem

### 2. **Missing Permissions in app.json**

- **Problem**: Storage permissions not declared in app configuration
- **Solution**: Added `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `MANAGE_EXTERNAL_STORAGE`

### 3. **Limited File Detection**

- **Problem**: Only checking for exact file extensions
- **Solution**: Enhanced detection for download URLs and query parameters

### 4. **No Fallback Strategy**

- **Problem**: Single download method without alternatives
- **Solution**: Implemented multi-tier fallback: RNBlobUtil → Expo FileSystem → Sharing

## Testing Steps

1. **Build and Install the App**:

   ```bash
   cd "c:\Users\mones\Desktop\logs\appgold"
   npx expo run:android
   ```

2. **Test Download Scenarios**:

   - Navigate to a page with CSV downloads
   - Check browser console logs for "Intercepted URL"
   - Test different file types (CSV, PDF, XLSX)

3. **Check Console Logs**:

   - Look for: "Starting download for URL:", "Download successful:", or error messages
   - Android logs: `npx react-native log-android`

4. **Verify File Location**:
   - Check Downloads folder on device
   - Look for sharing prompt if download completes

## Common Issues and Solutions

### Issue: No Download Triggered

- **Check**: Console logs for "Intercepted URL"
- **Solution**: URL might not match detection patterns, add more patterns

### Issue: Permission Denied

- **Check**: Android settings > App > Permissions
- **Solution**: Manually grant storage permissions or use Expo approach

### Issue: Download Fails

- **Check**: Network connectivity and URL accessibility
- **Solution**: Try different download method or check server CORS

### Issue: File Not Found After Download

- **Check**: Android Downloads folder or app documents
- **Solution**: Use sharing feature to locate file

## Monitoring Commands

```bash
# Watch React Native logs
npx react-native log-android

# Check Metro bundler
npx expo start --clear

# Reinstall dependencies
rm -rf node_modules && npm install
```

## Alternative Test URLs

Test with these sample download URLs:

- CSV: `https://example.com/data.csv`
- PDF: `https://example.com/document.pdf`
- Excel: `https://example.com/spreadsheet.xlsx`
