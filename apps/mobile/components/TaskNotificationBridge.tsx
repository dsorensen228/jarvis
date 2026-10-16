import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';
import { navigateHomeToTask } from '@/lib/homeNavigationBridge';

export function TaskNotificationBridge() {
  const seen = useRef(new Set<string>());
  const handleResponse = useCallback((response: Notifications.NotificationResponse | null | undefined) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const { identifier, content } = response.notification.request;
    const data = content.data;
    const kind = data?.type === 'code_task' ? 'code' : data?.type === 'research_task' ? 'research' : null;
    if (!kind || typeof data.task_id !== 'string' || !data.task_id.trim() || seen.current.has(identifier)) return;
    seen.current.add(identifier);
    navigateHomeToTask(kind, data.task_id);
  }, []);
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => subscription.remove();
  }, [handleResponse]);
  const last = Notifications.useLastNotificationResponse();
  useEffect(() => { handleResponse(last); }, [last, handleResponse]);
  return null;
}
