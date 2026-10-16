const appJson = require('./app.json');

function getIosUrlScheme() {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
  const prefix = clientId.split('.apps.googleusercontent.com')[0];
  return prefix
    ? `com.googleusercontent.apps.${prefix}`
    : 'com.googleusercontent.apps.placeholder';
}

module.exports = {
  ...appJson,
  expo: {
    ...appJson.expo,
    plugins: [
      ...appJson.expo.plugins,
      ['@react-native-google-signin/google-signin', { iosUrlScheme: getIosUrlScheme() }],
    ],
  },
};
