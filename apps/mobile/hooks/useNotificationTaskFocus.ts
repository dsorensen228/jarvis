import { useEffect, useRef, useState } from 'react';

/** Fetch by ID so an older task can open even when it is outside the current list page. */
export function useNotificationTaskFocus<T>(taskId: string | null | undefined, fetchTask: (id: string) => Promise<T>, openTask: (task: T) => void, onConsumed?: () => void) {
  const handlers = useRef({ openTask, onConsumed });
  handlers.current = { openTask, onConsumed };
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!taskId) return;
    let active = true;
    setError(null);
    void fetchTask(taskId).then(task => {
      if (!active) return;
      handlers.current.openTask(task);
      handlers.current.onConsumed?.();
    }).catch(() => {
      if (!active) return;
      setError('Could not open the notified task. Refresh the task list and try again.');
      handlers.current.onConsumed?.();
    });
    return () => { active = false; };
  }, [taskId, fetchTask]);
  return error;
}
