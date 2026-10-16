import { useCallback, useEffect, useRef, useState } from 'react';
import { getCodeTasks as fetchTasks, getCodeTaskOutput as fetchOutput, getCodeTask as fetchTask, streamCodeTaskOutput, type CodeTask, type CodeTaskOutput, type CodeTaskOutputPage, type CodeTaskView } from '../lib/api-client';
import { ACTIVE_TASK_STATUSES, isTaskAtLeastAsNew, mergeOutput, mergeTasks } from '../lib/codeTaskState';
import { CodeTaskPageRequests } from '../lib/codeTaskPageRequests';

export function useCodeTaskFeed(enabled: boolean, stream: boolean) {
  const [view, setView] = useState<CodeTaskView>('all');
  const [tasks, setTasks] = useState<CodeTask[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CodeTask | null>(null);
  const [output, setOutput] = useState<CodeTaskOutput[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'complete'>('connecting');
  const epoch = useRef(0);
  const pages = useRef(0);
  const requests = useRef(new CodeTaskPageRequests());
  const cursorRef = useRef<string | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const reconcileOffset = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  const updateTask = useCallback((task: CodeTask) => {
    setTasks((old) => mergeTasks(old, [task], viewRef.current));
    setSelected((old) => old?.id === task.id && isTaskAtLeastAsNew(task, old) ? task : old);
  }, []);

  const load = useCallback(async (more = false) => {
    if (!enabledRef.current || (more && !cursorRef.current)) return;
    const request = requests.current.begin(more);
    if (!request) return;
    let succeeded = false;
    const generation = epoch.current;
    if (more) setLoadingMore(true); else setRefreshing(true);
    try {
      const page = await fetchTasks(view, more ? cursorRef.current : null);
      if (generation !== epoch.current) return;
      setTasks((old) => mergeTasks(old, page.items, view, !more && page.next_cursor === null));
      if (more || pages.current < 2 || page.next_cursor === null) {
        cursorRef.current = page.next_cursor;
        setCursor(page.next_cursor);
      }
      // An authoritative short head replaced the entire feed. A later growing
      // feed must be allowed to adopt its new first-page cursor again.
      pages.current = more ? pages.current + 1 : page.next_cursor === null ? 1 : Math.max(1, pages.current);
      setError(null);
      // A job outside the newest page may have completed since it was loaded.
      // Reconcile a bounded rotating group so active filters cannot retain it forever.
      if (!more && page.next_cursor) {
        const incoming = new Set(page.items.map((task) => task.id));
        const candidates = tasksRef.current.filter((task) => ACTIVE_TASK_STATUSES.has(task.status) && !incoming.has(task.id));
        if (candidates.length) {
          const start = reconcileOffset.current % candidates.length;
          const batch = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 5);
          reconcileOffset.current = start + batch.length;
          const results = await Promise.allSettled(batch.map((task) => fetchTask(task.id)));
          if (generation === epoch.current) {
            const records = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
            setTasks((old) => mergeTasks(old, records, view));
          }
        }
      }
      succeeded = true;
    } catch (cause) {
      if (generation === epoch.current) setError(cause instanceof Error ? cause.message : 'Could not load tasks');
    } finally {
      if (generation === epoch.current) {
        const pendingMore = requests.current.finish(request, succeeded, cursorRef.current != null);
        setLoading(false); setRefreshing(false); setLoadingMore(false);
        // The cursor ref is updated before draining, including when React has not
        // rendered the refreshed first page yet. Repeated end events coalesce.
        if (pendingMore && enabledRef.current && cursorRef.current) void loadRef.current(true);
      }
    }
  }, [view]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    epoch.current += 1; pages.current = 0; requests.current.reset(); cursorRef.current = null;
    setTasks([]); setCursor(null); setLoading(true); setError(null); setLoadingMore(false);
    if (enabled) void loadRef.current();
    return () => { epoch.current += 1; requests.current.reset(); };
  }, [view]);

  useEffect(() => {
    if (!enabled) {
      requests.current.reset(); setRefreshing(false); setLoadingMore(false);
      return;
    }
    void loadRef.current();
    const timer = setInterval(() => void loadRef.current(), 10000);
    return () => { clearInterval(timer); epoch.current += 1; requests.current.reset(); };
  }, [enabled]);

  const open = useCallback((task: CodeTask) => {
    setOutput([]); setTruncated(false); setConnection('connecting'); setSelected(task);
  }, []);

  useEffect(() => {
    if (!selected || !enabled) return;
    const id = selected.id;
    let stopped = false;
    let after = 0;
    let terminal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const accept = (page: CodeTaskOutputPage) => {
      if (stopped || page.task.id !== id) return;
      after = Math.max(after, page.next_after);
      terminal = !ACTIVE_TASK_STATUSES.has(page.task.status) && !page.has_more;
      setOutput((old) => mergeOutput(old, page.items));
      setTruncated((old) => old || page.truncated);
      updateTask(page.task);
      setConnection(terminal ? 'complete' : 'live');
      if (terminal) controller.abort();
    };
    const poll = async () => {
      try {
        const page = await fetchOutput(id, after);
        accept(page);
        if (stopped || terminal) return;
        timer = setTimeout(() => void poll(), page.has_more ? 20 : 1500);
      } catch {
        if (stopped) return;
        setConnection('reconnecting');
        timer = setTimeout(() => void poll(), 4000);
      }
    };
    const start = async () => {
      try {
        // Drain saved output first, then subscribe after the last received sequence.
        let page: CodeTaskOutputPage;
        do { page = await fetchOutput(id, after); accept(page); } while (!stopped && page.has_more);
        if (stopped || terminal) return;
        if (stream) {
          await streamCodeTaskOutput(id, after, controller.signal, accept);
          if (stopped || terminal) return;
        }
      } catch { if (!stopped && !terminal) setConnection('reconnecting'); }
      if (!stopped && !terminal) void poll();
    };
    void start();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  // Switching the task or visibility restarts from persisted output; state updates do not reopen connections.
  }, [selected?.id, enabled, stream, updateTask]);

  return { view, setView, tasks, loading, refreshing, loadingMore, error, hasMore: cursor != null,
    refresh: () => load(false), loadMore: () => load(true), selected, open, close: () => setSelected(null),
    updateTask, output, truncated, connection };
}
