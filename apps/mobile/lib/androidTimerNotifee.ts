import notifee, {
  AlarmType,
  AndroidImportance,
  AuthorizationStatus,
  EventType,
  TriggerType,
} from '@notifee/react-native';
import { Platform } from 'react-native';

import { formatTimerClock } from '@/lib/timerFormat';

const CHANNEL_TIMER = 'jarvis_timer';
const CHANNEL_ALARM = 'jarvis_timer_alarm';

export const ANDROID_NOTIF_ID_ONGOING = 'JARVIS_TIMER_ONGOING';
export const ANDROID_NOTIF_ID_END = 'JARVIS_TIMER_END_TRIGGER';

export type AndroidTimerControlHandlers = {
  pauseTimer: () => void;
  resumeTimer: () => void;
  cancelTimer: () => void;
  dismissAlarm: () => void;
  enterAlarmFromBackground: () => void;
};

let controlHandlers: AndroidTimerControlHandlers | null = null;
let channelsReady: Promise<void> | null = null;
let eventsRegistered = false;

export function setAndroidTimerControlHandlers(handlers: AndroidTimerControlHandlers | null) {
  controlHandlers = handlers;
}

function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return Promise.resolve();
  }
  if (!channelsReady) {
    channelsReady = (async () => {
      await notifee.createChannel({
        id: CHANNEL_TIMER,
        name: 'Timer',
        importance: AndroidImportance.DEFAULT,
      });
      await notifee.createChannel({
        id: CHANNEL_ALARM,
        name: 'Timer alarm',
        importance: AndroidImportance.HIGH,
        sound: 'default',
        vibration: true,
      });
    })();
  }
  return channelsReady;
}

async function ensurePostNotificationsPermission(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const settings = await notifee.getNotificationSettings();
  if (settings.authorizationStatus === AuthorizationStatus.AUTHORIZED) {
    return;
  }
  await notifee.requestPermission();
}

export async function syncAndroidTimerNotifications(params: {
  status: 'idle' | 'running' | 'paused' | 'alarming';
  endAtMs: number | null;
  pausedRemainingMs: number | null;
}): Promise<void> {
  if (Platform.OS !== 'android') return;

  await ensureChannels();
  await ensurePostNotificationsPermission();

  const { status, endAtMs, pausedRemainingMs } = params;

  if (status === 'idle') {
    await notifee.cancelNotification(ANDROID_NOTIF_ID_ONGOING);
    await notifee.cancelNotification(ANDROID_NOTIF_ID_END);
    await notifee.cancelTriggerNotification(ANDROID_NOTIF_ID_END);
    return;
  }

  if (status === 'alarming') {
    await notifee.cancelNotification(ANDROID_NOTIF_ID_ONGOING);
    await notifee.cancelTriggerNotification(ANDROID_NOTIF_ID_END);
    return;
  }

  await notifee.cancelNotification(ANDROID_NOTIF_ID_END);
  await notifee.cancelTriggerNotification(ANDROID_NOTIF_ID_END);

  if (status === 'running' && endAtMs != null) {
    await notifee.displayNotification({
      id: ANDROID_NOTIF_ID_ONGOING,
      title: 'Timer',
      body: 'Time remaining',
      android: {
        channelId: CHANNEL_TIMER,
        importance: AndroidImportance.LOW,
        ongoing: true,
        autoCancel: false,
        onlyAlertOnce: true,
        showChronometer: true,
        chronometerDirection: 'down',
        timestamp: endAtMs,
        pressAction: { id: 'default' },
        actions: [
          { title: 'Pause', pressAction: { id: 'pause' } },
          { title: 'Cancel', pressAction: { id: 'cancel' } },
        ],
      },
    });

    await notifee.createTriggerNotification(
      {
        id: ANDROID_NOTIF_ID_END,
        title: 'Timer finished',
        body: 'Tap Dismiss to stop the alarm.',
        data: { jarvisTimer: 'end' },
        android: {
          channelId: CHANNEL_ALARM,
          importance: AndroidImportance.HIGH,
          sound: 'default',
          pressAction: { id: 'open' },
          actions: [{ title: 'Dismiss', pressAction: { id: 'dismiss' } }],
          autoCancel: false,
        },
      },
      {
        type: TriggerType.TIMESTAMP,
        timestamp: endAtMs,
        alarmManager: {
          type: AlarmType.SET_EXACT_AND_ALLOW_WHILE_IDLE,
        },
      }
    );
    return;
  }

  if (status === 'paused') {
    const remaining = pausedRemainingMs ?? 0;
    await notifee.displayNotification({
      id: ANDROID_NOTIF_ID_ONGOING,
      title: 'Timer paused',
      body: formatTimerClock(remaining),
      android: {
        channelId: CHANNEL_TIMER,
        importance: AndroidImportance.DEFAULT,
        ongoing: true,
        autoCancel: false,
        pressAction: { id: 'default' },
        actions: [
          { title: 'Resume', pressAction: { id: 'resume' } },
          { title: 'Cancel', pressAction: { id: 'cancel' } },
        ],
      },
    });
  }
}

function dispatchAction(actionId: string | undefined) {
  const h = controlHandlers;
  if (!h || !actionId) return;
  switch (actionId) {
    case 'pause':
      h.pauseTimer();
      break;
    case 'resume':
      h.resumeTimer();
      break;
    case 'cancel':
      h.cancelTimer();
      break;
    case 'dismiss':
      h.dismissAlarm();
      break;
    default:
      break;
  }
}

async function handleNotifeeEvent(type: EventType, detail: {
  notification?: { id?: string };
  pressAction?: { id?: string };
}): Promise<void> {
  if (Platform.OS !== 'android') return;

  const notificationId = detail.notification?.id;

  if (type === EventType.DELIVERED && notificationId === ANDROID_NOTIF_ID_END) {
    controlHandlers?.enterAlarmFromBackground();
    return;
  }

  if (type === EventType.DISMISSED) {
    if (notificationId === ANDROID_NOTIF_ID_END) {
      controlHandlers?.dismissAlarm();
      return;
    }
    if (notificationId === ANDROID_NOTIF_ID_ONGOING) {
      controlHandlers?.cancelTimer();
    }
    return;
  }

  if (type === EventType.ACTION_PRESS) {
    dispatchAction(detail.pressAction?.id);
    return;
  }

  if (type === EventType.PRESS && notificationId === ANDROID_NOTIF_ID_END) {
    controlHandlers?.dismissAlarm();
  }
}

/** Register once; safe to call from root layout. */
export function registerAndroidTimerNotificationEvents(): void {
  if (Platform.OS !== 'android' || eventsRegistered) {
    return;
  }
  eventsRegistered = true;

  notifee.onForegroundEvent(({ type, detail }) => {
    void handleNotifeeEvent(type, detail);
  });

  notifee.onBackgroundEvent(async ({ type, detail }) => {
    await handleNotifeeEvent(type, detail);
  });
}
