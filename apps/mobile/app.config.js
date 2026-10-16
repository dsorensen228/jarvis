const fs = require('fs');
const path = require('path');
const appJson = require('./app.json');

function getIosUrlScheme() {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
  const prefix = clientId.split('.apps.googleusercontent.com')[0];
  return prefix
    ? `com.googleusercontent.apps.${prefix}`
    : 'com.googleusercontent.apps.placeholder';
}

// Firebase client configuration is deployment-local. EAS uploads it via
// .easignore, while web and developer checks can run without the Android file.
const googleServicesFile = './google-services.json';
module.exports = {
  ...appJson,
  expo: {
    ...appJson.expo,
    android: {
      ...appJson.expo.android,
      ...(fs.existsSync(path.join(__dirname, googleServicesFile))
        ? { googleServicesFile }
        : {}),
    },
    plugins: [
      ...appJson.expo.plugins,
      ['@react-native-google-signin/google-signin', { iosUrlScheme: getIosUrlScheme() }],
    ],
  },
};
