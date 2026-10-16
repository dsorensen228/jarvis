import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { ensureCameraPersonNotificationSetup } from '@/lib/cameraPersonNotifications';
import { PERSON_DETECTED_PUSH_TYPE } from '@/lib/cameraPersonPushConstants';
import { navigateHomeToCameras } from '@/lib/homeNavigationBridge';

function readData(
  response: Notifications.NotificationResponse | null | undefined
): Record<string, string> | null {
  if (!response) {
    return null;
  }
  const raw = response.notification.request.content.data as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v != null) {
      o[k] = String(v);
    }
  }
  return o;
}

/**
 * Registers the Android camera-person channel and routes person-detected push
 * taps to the Cameras tab (optionally selecting the source camera).
 */
export function CameraPersonNotificationBridge() {
  const coldStartSeen = useRef<Set<string>>(new Set());

  const handleResponse = useCallback(
    async (response: Notifications.NotificationResponse | null | undefined) => {
      if (!response) {
        return;
      }

      const data = readData(response);
      const action = response.actionIdentifier;
      if (action !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
        return;
      }
      if (data?.type !== PERSON_DETECTED_PUSH_TYPE) {
        return;
      }
      navigateHomeToCameras(data.device_id || undefined);
    },
    []
  );

  useEffect(() => {
    void ensureCameraPersonNotificationSetup();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      void handleResponse(r);
    });
    return () => sub.remove();
  }, [handleResponse]);

  const last = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (Platform.OS === 'web' || !last) {
      return;
    }
    const nid = last.notification.request.identifier;
    if (coldStartSeen.current.has(nid)) {
      return;
    }
    coldStartSeen.current.add(nid);
    void handleResponse(last);
  }, [last, handleResponse]);

  return null;
}
