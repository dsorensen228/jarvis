import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/** Must stay in sync with jarvis_api/push.py. */
export const ANDROID_TASK_STATUS_CHANNEL_ID = 'task-status';
export async function ensureTaskNotificationSetup(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_TASK_STATUS_CHANNEL_ID, {
    name: 'Coding and research tasks',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    sound: 'default',
  });
}
