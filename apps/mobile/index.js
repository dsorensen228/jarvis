// Register headless notification controls before the router mounts a React tree.
import { registerAndroidTimerNotificationEvents } from './lib/androidTimerNotifee';
registerAndroidTimerNotificationEvents();
require('expo-router/entry');
