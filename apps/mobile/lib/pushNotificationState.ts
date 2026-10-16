import { useSyncExternalStore } from 'react';

export type PushNotificationStatus = {
  phase: 'signed_out' | 'registering' | 'registered' | 'denied' | 'error';
  message: string;
};
let status: PushNotificationStatus = { phase: 'signed_out', message: 'Sign in to enable notifications.' };
const listeners = new Set<() => void>();
let retry: (() => void) | null = null;
export function setPushNotificationStatus(next: PushNotificationStatus) {
  status = next;
  listeners.forEach(listener => listener());
}
export const getPushNotificationStatus = () => status;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function usePushNotificationStatus() {
  return useSyncExternalStore(subscribe, getPushNotificationStatus, getPushNotificationStatus);
}
export function registerPushNotificationRetry(callback: (() => void) | null) { retry = callback; }
export function retryPushNotifications() { retry?.(); }
