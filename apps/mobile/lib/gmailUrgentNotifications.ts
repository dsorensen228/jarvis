import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import {
  ANDROID_URGENT_EMAIL_CHANNEL_ID,
  GMAIL_URGENT_CATEGORY_ID,
} from './gmailUrgentPushConstants';

export { ANDROID_URGENT_EMAIL_CHANNEL_ID, GMAIL_URGENT_CATEGORY_ID };

export async function ensureGmailUrgentNotificationSetup(): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }

  await Notifications.setNotificationCategoryAsync(GMAIL_URGENT_CATEGORY_ID, [
    {
      identifier: 'open_gmail',
      buttonTitle: 'Open Gmail',
      options: {
        opensAppToForeground: false,
      },
    },
  ]);

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(ANDROID_URGENT_EMAIL_CHANNEL_ID, {
      name: 'Urgent email',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
    });
  }
}
