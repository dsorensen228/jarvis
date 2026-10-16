import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { registerPushToken, unregisterPushToken } from '@/lib/api-client';
import { ensureCameraPersonNotificationSetup } from '@/lib/cameraPersonNotifications';
import { ensureGmailUrgentNotificationSetup } from '@/lib/gmailUrgentNotifications';
import { ensureTaskNotificationSetup } from '@/lib/taskNotifications';
import { registerPushNotificationRetry, setPushNotificationStatus } from '@/lib/pushNotificationState';

const RETRY_DELAYS = [5000, 30000, 60000];
type Registration = { token: string; accessToken: string; userId?: string };

export function PushTokenBridge() {
  const { accessToken, user } = useAuth();
  const userId = user?.id;
  const session = useRef({ accessToken, userId });
  session.current = { accessToken, userId };
  // Keep pending registrations too: a timed-out request may still reach the server.
  const registrations = useRef(new Map<string, Registration>());

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    let running = false;
    let rotatedWhileRunning = false;
    let nativeToken: Notifications.DevicePushToken | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const remove = async (key: string, record: Registration) => {
      if (registrations.current.get(key) === record) registrations.current.delete(key);
      await unregisterPushToken({ token: record.token, provider: 'expo' }, record.accessToken).catch(() => {});
    };
    const accountCleanup: Promise<void>[] = [];
    for (const [key, record] of registrations.current) {
      if (!accessToken || record.userId !== userId) accountCleanup.push(remove(key, record));
      else record.accessToken = accessToken;
    }
    if (!accessToken) {
      setPushNotificationStatus({ phase: 'signed_out', message: 'Sign in to enable notifications.' });
      return;
    }

    async function sync(requestPermission = false) {
      if (cancelled || running) return;
      running = true;
      clearTimeout(retryTimer);
      setPushNotificationStatus({ phase: 'registering', message: 'Checking notifications…' });
      try {
        await Promise.all(accountCleanup);
        if (cancelled) return;
        // Android 13 requires a channel before requesting permission or an FCM token.
        await Promise.all([ensureCameraPersonNotificationSetup(), ensureGmailUrgentNotificationSetup(), ensureTaskNotificationSetup()]);
        if (cancelled) return;
        let permission = await Notifications.getPermissionsAsync();
        if (permission.status !== 'granted' && permission.canAskAgain && requestPermission) {
          permission = await Notifications.requestPermissionsAsync();
        }
        if (cancelled) return;
        if (permission.status !== 'granted') {
          setPushNotificationStatus({ phase: 'denied', message: 'Notifications are off. Allow notifications in your device settings for door, coding, and research alerts.' });
          return;
        }
        const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
        if (!projectId) throw new Error('Push project configuration is missing');
        const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId, ...(nativeToken ? { devicePushToken: nativeToken } : {}) });
        if (cancelled) return;
        if (!token) throw new Error('No push token was returned');
        const key = `${userId}:${token}`;
        const record = registrations.current.get(key) ?? { token, accessToken: accessToken!, userId };
        registrations.current.set(key, record);
        await registerPushToken({ token, provider: 'expo', platform: Platform.OS, device_id: Constants.deviceName || undefined }, record.accessToken);
        // A late response after logout/rotation must be removed again; an auth refresh
        // for the same account keeps the shared record and its newer credentials.
        if (cancelled) {
          if (!session.current.accessToken || session.current.userId !== userId || registrations.current.get(key) !== record) {
            await remove(key, record);
          }
          return;
        }
        for (const [otherKey, other] of registrations.current) {
          if (otherKey !== key && other.userId === userId) void remove(otherKey, other);
        }
        failures = 0;
        setPushNotificationStatus({ phase: 'registered', message: 'This device is registered for door, coding, and research alerts.' });
      } catch (error) {
        if (cancelled) return;
        const buildError = /firebase|project configuration|default.*app|fcm/i.test(error instanceof Error ? error.message : '');
        setPushNotificationStatus({ phase: 'error', message: buildError
          ? 'This Android build cannot register for push notifications. Install the latest Android app and retry.'
          : 'Could not register for notifications. Check your connection and retry.' });
        if (failures < RETRY_DELAYS.length && AppState.currentState === 'active') {
          retryTimer = setTimeout(() => void sync(), RETRY_DELAYS[failures++]);
        }
      } finally {
        running = false;
        if (rotatedWhileRunning && !cancelled) {
          rotatedWhileRunning = false;
          void sync();
        }
      }
    }
    registerPushNotificationRetry(() => { failures = 0; void sync(true); });
    const activeSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') { failures = 0; void sync(); }
      else clearTimeout(retryTimer);
    });
    const tokenSubscription = Notifications.addPushTokenListener(token => {
      nativeToken = token;
      if (running) rotatedWhileRunning = true;
      else void sync();
    });
    void sync(true);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      registerPushNotificationRetry(null);
      activeSubscription.remove();
      tokenSubscription.remove();
    };
  }, [accessToken, userId]);

  return null;
}
