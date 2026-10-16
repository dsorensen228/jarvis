import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { ANDROID_CAMERA_PERSON_CHANNEL_ID } from './cameraPersonPushConstants';

export { ANDROID_CAMERA_PERSON_CHANNEL_ID };

export async function ensureCameraPersonNotificationSetup(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  await Notifications.setNotificationChannelAsync(ANDROID_CAMERA_PERSON_CHANNEL_ID, {
    name: 'Camera person alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    sound: 'default',
  });
}
