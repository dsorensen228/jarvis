import { useCallback, useEffect, useRef, useState } from 'react';
import { getResearchTask, getResearchTasks, getResearchTaskOutput, type CodeTaskOutput, type CodeTaskView, type ResearchTask } from '../lib/api-client';
import { ACTIVE_TASK_STATUSES, isTaskAtLeastAsNew, mergeOutput, mergeTasks } from '../lib/codeTaskState';
import { CodeTaskPageRequests } from '../lib/codeTaskPageRequests';

export function useResearchTasks(enabled: boolean) {
  const [view, setView] = useState<CodeTaskView>('all');
  const [tasks, setTasks] = useState<ResearchTask[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResearchTask | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
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
  const viewRef = useRef(view);
  viewRef.current = view;
  const reconcileOffset = useRef(0);

  const updateTask = useCallback((task: ResearchTask) => {
    setTasks((old) => mergeTasks(old, [task], viewRef.current) as ResearchTask[]);
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
      const page = await getResearchTasks(view, more ? cursorRef.current : null);
      if (generation !== epoch.current) return;
      setTasks((old) => mergeTasks(old, page.items, view, !more && page.next_cursor === null) as ResearchTask[]);
      if (more || pages.current < 2 || page.next_cursor === null) {
        cursorRef.current = page.next_cursor;
        setCursor(page.next_cursor);
      }
      pages.current = more ? pages.current + 1 : page.next_cursor === null ? 1 : Math.max(1, pages.current);
      setError(null);
      if (!more && page.next_cursor) {
        const incoming = new Set(page.items.map((task) => task.id));
        const candidates = tasksRef.current.filter((task) => ACTIVE_TASK_STATUSES.has(task.status) && !incoming.has(task.id));
        if (candidates.length) {
          const start = reconcileOffset.current % candidates.length;
          const batch = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 5);
          reconcileOffset.current = start + batch.length;
          const results = await Promise.allSettled(batch.map((task) => getResearchTask(task.id)));
          if (generation === epoch.current) {
            const records = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
            setTasks((old) => mergeTasks(old, records, view) as ResearchTask[]);
          }
        }
      }
      succeeded = true;
    } catch (cause) {
      if (generation === epoch.current) setError(cause instanceof Error ? cause.message : 'Could not load research tasks');
    } finally {
      if (generation === epoch.current) {
        const pendingMore = requests.current.finish(request, succeeded, cursorRef.current != null);
        setLoading(false); setRefreshing(false); setLoadingMore(false);
        if (pendingMore && enabledRef.current && cursorRef.current) void loadRef.current(true);
      }
    }
  }, [view]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    epoch.current += 1; pages.current = 0; requests.current.reset(); cursorRef.current = null;
    setTasks([]); setCursor(null); setLoading(true); setError(null); setLoadingMore(false);
    if (enabledRef.current) void loadRef.current();
    return () => { epoch.current += 1; requests.current.reset(); };
  }, [view]);
  useEffect(() => {
    if (!enabled) { requests.current.reset(); setRefreshing(false); setLoadingMore(false); return; }
    void loadRef.current();
    const timer = setInterval(() => void loadRef.current(), 4000);
    return () => { clearInterval(timer); epoch.current += 1; requests.current.reset(); };
  }, [enabled]);

  useEffect(() => {
    if (!selected || !enabled) return;
    const id = selected.id;
    let stopped = false;
    let after = 0;
    let timer: ReturnType<typeof setTimeout>;
    const refreshDetail = async () => {
      try {
        const page = await getResearchTaskOutput(id, after);
        if (stopped || page.task.id !== id) return;
        after = Math.max(after, page.next_after);
        updateTask(page.task); setDetailError(null);
        setOutput((old) => mergeOutput(old, page.items));
        setTruncated((old) => old || page.truncated);
        const terminal = !ACTIVE_TASK_STATUSES.has(page.task.status) && !page.has_more;
        setConnection(terminal ? 'complete' : 'live');
        if (!terminal) timer = setTimeout(() => void refreshDetail(), page.has_more ? 20 : 1500);
      } catch (cause) {
        if (stopped) return;
        setDetailError(cause instanceof Error ? cause.message : 'Could not refresh this task');
        setConnection('reconnecting');
        timer = setTimeout(() => void refreshDetail(), 4000);
      }
    };
    void refreshDetail();
    return () => { stopped = true; clearTimeout(timer); };
  }, [selected?.id, enabled, updateTask]);

  return { view, setView, tasks, loading, refreshing, loadingMore, error, hasMore: cursor != null,
    refresh: () => load(false), loadMore: () => load(true), selected, detailError, output, truncated, connection,
    open: (task: ResearchTask) => { setDetailError(null); setOutput([]); setTruncated(false); setConnection('connecting'); setSelected(task); },
    close: () => setSelected(null), updateTask };
}
