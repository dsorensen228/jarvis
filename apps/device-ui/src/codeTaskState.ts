import type { CodeTask, CodeTaskOutput, CodeTaskView } from './api';

export const ACTIVE_TASK_STATUSES = new Set(['pending', 'queued', 'running', 'cancel_requested']);
export const TASK_FILTERS: { id: CodeTaskView; label: string }[] = [
  { id: 'all', label: 'All tasks' }, { id: 'active', label: 'Active' }, { id: 'history', label: 'History' },
];
export function matchesTaskView(task: CodeTask, view: CodeTaskView): boolean {
  return view === 'all' || (view === 'active' ? ACTIVE_TASK_STATUSES.has(task.status) : !ACTIVE_TASK_STATUSES.has(task.status));
}
export function isTaskAtLeastAsNew(task: CodeTask, old: CodeTask): boolean {
  const difference = Date.parse(task.updated_at) - Date.parse(old.updated_at);
  return difference > 0 || (difference === 0 && (task.output_seq ?? 0) >= (old.output_seq ?? 0));
}
/** Refresh newer rows without discarding already loaded history or regressing live state. */
export function mergeTasks(previous: CodeTask[], incoming: CodeTask[], view: CodeTaskView, authoritative = false): CodeTask[] {
  const incomingIds = new Set(incoming.map((task) => task.id));
  const rows = new Map(previous.filter((task) => !authoritative || incomingIds.has(task.id)).map((task) => [task.id, task]));
  for (const task of incoming) {
    const old = rows.get(task.id);
    if (!old || isTaskAtLeastAsNew(task, old)) rows.set(task.id, task);
  }
  return [...rows.values()].filter((task) => matchesTaskView(task, view)).sort((a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || b.id.localeCompare(a.id));
}
export function mergeOutput(previous: CodeTaskOutput[], incoming: CodeTaskOutput[]): CodeTaskOutput[] {
  const rows = new Map(previous.map((item) => [item.seq, item]));
  for (const item of incoming) rows.set(item.seq, item);
  return [...rows.values()].sort((a, b) => a.seq - b.seq).slice(-500);
}
export function taskResult(task: CodeTask): string | null {
  if (task.agent_output != null) {
    if (typeof task.agent_output === 'string') return task.agent_output;
    if (typeof task.agent_output === 'object' && typeof (task.agent_output as { result?: unknown }).result === 'string') return (task.agent_output as { result: string }).result;
    return JSON.stringify(task.agent_output, null, 2);
  }
  return null;
}
export function taskStatusLabel(status: CodeTask['status']): string {
  return ({ pending: 'Waiting', queued: 'Queued', running: 'Running', cancel_requested: 'Stopping', cancelled: 'Cancelled', success: 'Completed', failed: 'Failed' })[status];
}
export function taskTiming(task: CodeTask): string {
  if (!task.started_at) return task.status === 'cancelled' ? 'Cancelled before starting' : 'Waiting to start';
  const seconds = Math.max(0, Math.floor((new Date(task.completed_at ?? Date.now()).getTime() - new Date(task.started_at).getTime()) / 1000));
  const duration = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return task.completed_at ? `Ran for ${duration}` : `Running for ${duration}`;
}
