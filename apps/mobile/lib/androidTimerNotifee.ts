import notifee, {
  AlarmType, AndroidImportance, AndroidNotificationSetting, AuthorizationStatus, EventType, TriggerType,
  type EventDetail,
} from '@notifee/react-native';
import { Platform } from 'react-native';
import { formatTimerClock } from './timerFormat';
import { matchesTimerNotification, type TimerState, type TimerAction } from './timerState';
import { timerStore } from './timerStore';

const CHANNEL_TIMER = 'jarvis_timer';
const CHANNEL_ALARM = 'jarvis_timer_alarm';
export const ANDROID_NOTIF_ID_ONGOING = 'JARVIS_TIMER_ONGOING';
export const ANDROID_NOTIF_ID_END = 'JARVIS_TIMER_END_TRIGGER';
let channelsReady: Promise<void> | null = null;
let eventsRegistered = false;
let syncQueue: Promise<void> = Promise.resolve();
let syncVersion = 0;
function ensureChannels() {
  return channelsReady ??= (async () => {
    await notifee.createChannel({ id: CHANNEL_TIMER, name: 'Timer', importance: AndroidImportance.DEFAULT });
    await notifee.createChannel({ id: CHANNEL_ALARM, name: 'Timer alarm', importance: AndroidImportance.HIGH, sound: 'default', vibration: true });
  })().catch(error => { channelsReady = null; throw error; });
}
async function syncNotifications(state: TimerState) {
  const { status, endAtMs, pausedRemainingMs } = state;
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
  // Retire the previous deadline even if permissions were revoked before a pause/revision.
  await notifee.cancelNotification(ANDROID_NOTIF_ID_END);
  await notifee.cancelTriggerNotification(ANDROID_NOTIF_ID_END);
  await ensureChannels();
  const settings = await notifee.getNotificationSettings();
  if (settings.authorizationStatus !== AuthorizationStatus.AUTHORIZED) {
    // Permission prompts can remain pending when Android has permanently denied them.
    // Startup owns the prompt; scheduling must stay available for cancellation.
    await notifee.cancelNotification(ANDROID_NOTIF_ID_ONGOING);
    throw new Error('Notifications are disabled');
  }
  if (status === 'running' && settings.android.alarm === AndroidNotificationSetting.DISABLED) {
    await notifee.cancelNotification(ANDROID_NOTIF_ID_ONGOING);
    throw new Error('Exact alarms are disabled');
  }
  const data = { timerId: state.id, revision: String(state.revision) };
  const title = state.label || 'Timer';
  if (status === 'running' && endAtMs != null) {
    if (endAtMs <= Date.now()) return;
    await notifee.displayNotification({
      id: ANDROID_NOTIF_ID_ONGOING, title, body: 'Time remaining', data,
      android: {
        channelId: CHANNEL_TIMER, importance: AndroidImportance.LOW, ongoing: true, autoCancel: false,
        onlyAlertOnce: true, showChronometer: true, chronometerDirection: 'down', timestamp: endAtMs,
        pressAction: { id: 'default' },
        actions: [{ title: 'Pause', pressAction: { id: 'pause' } }, { title: '+1 min', pressAction: { id: 'add-minute' } }, { title: 'Cancel', pressAction: { id: 'cancel' } }],
      },
    });
    // Re-check after native work; a very short timer can expire while permissions are shown.
    if (endAtMs <= Date.now()) return;
    await notifee.createTriggerNotification({
      id: ANDROID_NOTIF_ID_END, title: `${title} finished`, body: 'Tap Dismiss to clear the timer.', data,
      android: { channelId: CHANNEL_ALARM, importance: AndroidImportance.HIGH, sound: 'default',
        pressAction: { id: 'open', launchActivity: 'default' },
        actions: [{ title: 'Dismiss', pressAction: { id: 'dismiss' } }], autoCancel: false },
    }, { type: TriggerType.TIMESTAMP, timestamp: endAtMs, alarmManager: { type: AlarmType.SET_EXACT_AND_ALLOW_WHILE_IDLE } });
  } else if (status === 'paused') {
    await notifee.displayNotification({
      id: ANDROID_NOTIF_ID_ONGOING, title: `${title} paused`, body: formatTimerClock(pausedRemainingMs ?? 0), data,
      android: { channelId: CHANNEL_TIMER, importance: AndroidImportance.LOW, ongoing: true, autoCancel: false,
        onlyAlertOnce: true, pressAction: { id: 'default' },
        actions: [{ title: 'Resume', pressAction: { id: 'resume' } }, { title: 'Cancel', pressAction: { id: 'cancel' } }] },
    });
  }
}
/** Native scheduling is serialized so a slow start cannot recreate a cancelled alarm. */
export function syncAndroidTimerNotifications(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  const version = ++syncVersion;
  const next = syncQueue.catch(() => {}).then(() => version === syncVersion ? syncNotifications(timerStore.getSnapshot().state) : undefined);
  syncQueue = next;
  return next;
}
export async function openAndroidTimerNotificationSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const settings = await notifee.getNotificationSettings();
  if (settings.authorizationStatus === AuthorizationStatus.AUTHORIZED && settings.android.alarm === AndroidNotificationSetting.DISABLED) {
    return notifee.openAlarmPermissionSettings();
  }
  return notifee.openNotificationSettings();
}
export async function handleAndroidTimerEvent(type: EventType, detail: EventDetail): Promise<void> {
  if (Platform.OS !== 'android') return;
  const notification = detail.notification;
  if (notification?.id !== ANDROID_NOTIF_ID_END && notification?.id !== ANDROID_NOTIF_ID_ONGOING) return;
  const isEnd = notification.id === ANDROID_NOTIF_ID_END;
  let action: TimerAction['type'] | undefined;
  if (type === EventType.DELIVERED && isEnd) action = 'finish';
  if (type === EventType.DISMISSED) action = 'stop';
  if (type === EventType.PRESS && isEnd) action = 'stop';
  if (type === EventType.ACTION_PRESS) {
    const id = detail.pressAction?.id;
    if (id === 'pause' || id === 'resume' || id === 'add-minute') action = id;
    if (id === 'cancel' || id === 'dismiss') action = 'stop';
  }
  if (!action) return;
  // Works without a mounted React tree: hydrate, validate generation, persist, then sync native state.
  await timerStore.dispatch({ type: action as 'pause' | 'resume' | 'add-minute' | 'finish' | 'stop', now: Date.now() }, current => matchesTimerNotification(current, notification.data));
  await syncAndroidTimerNotifications();
}
/** Register at the application entry point, before Expo Router mounts React. */
export function registerAndroidTimerNotificationEvents(): void {
  if (Platform.OS !== 'android' || eventsRegistered) return;
  eventsRegistered = true;
  notifee.onForegroundEvent(({ type, detail }) => { void handleAndroidTimerEvent(type, detail).catch(() => {}); });
  notifee.onBackgroundEvent(({ type, detail }) => handleAndroidTimerEvent(type, detail));
}
