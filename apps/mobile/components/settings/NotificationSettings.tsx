import Constants from 'expo-constants';
import React, { useState } from 'react';
import { Linking, Platform } from 'react-native';
import { retryPushNotifications, usePushNotificationStatus } from '@/lib/pushNotificationState';
import { SettingsButton, SettingsGroup, SettingsNotice } from './SettingsUI';

export function NotificationSettings() {
  const status = usePushNotificationStatus();
  const [settingsError, setSettingsError] = useState<string | null>(null);
  if (Platform.OS === 'web') return null;
  const openSettings = async () => {
    setSettingsError(null);
    try {
      if (Platform.OS === 'android' && Constants.expoConfig?.android?.package) {
        try {
          await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
            { key: 'android.provider.extra.APP_PACKAGE', value: Constants.expoConfig.android.package },
          ]);
          return;
        } catch { /* Older Android devices fall back to the app settings page. */ }
      }
      await Linking.openSettings();
    } catch { setSettingsError('Could not open settings. Open Android Settings, then Apps, Jarvis, Notifications.'); }
  };
  return <SettingsGroup title="System notifications">
    <SettingsNotice message={status.message} tone={status.phase === 'error' || status.phase === 'denied' ? 'error' : 'info'} />
    <SettingsButton label="Retry notifications" onPress={retryPushNotifications} loading={status.phase === 'registering'} variant="secondary" />
    <SettingsButton label="Notification settings" onPress={() => void openSettings()} variant="secondary" />
    {settingsError && <SettingsNotice message={settingsError} />}
  </SettingsGroup>;
}
