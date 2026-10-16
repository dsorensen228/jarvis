import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  cancelCodeTask, createCodeTask, followUpCodeTask, fetchConfig, startCodeTaskRecording,
  stopCodeTaskRecording, cancelResearchTask, createResearchTask, fetchResearchReport,
  startResearchTaskRecording, stopResearchTaskRecording, type CodeTask, type CodeTaskModel,
  type FactoryMode, type ResearchVerbosity,
} from '../api';
import { ResearchReportViewer } from '../ResearchReportViewer';
import { useTimerAlarm } from '../timer/TimerAlarmContext';
import { useVoiceTurn } from '../VoiceTurnContext';
import { useCodeTaskFeed } from '../useCodeTaskFeed';
import { ACTIVE_TASK_STATUSES as ACTIVE, TASK_FILTERS, taskResult, taskStatusLabel, taskTiming } from '../codeTaskState';
import '../factory.css';

const AGENT_MODELS = [
  { id: 'gpt-5.6-terra', label: 'Terra' }, { id: 'gpt-6-sol', label: 'Sol' }, { id: 'gpt-6-astra', label: 'Astra' },
] as const;
const REPORT_DEPTHS = [
  { id: 'concise', label: 'Concise' }, { id: 'standard', label: 'Standard' }, { id: 'in_depth', label: 'In depth' },
] as const;
const modelLabel = (id?: string | null) => AGENT_MODELS.find((model) => model.id === id)?.label ?? id;
const shortDate = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function TaskModal({ children, title, onClose, locked = false }: { children: ReactNode; title: string; onClose: () => void; locked?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const lockedRef = useRef(locked); lockedRef.current = locked;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !lockedRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], summary, [tabindex="0"]') ?? [])];
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="code-modal-backdrop" role="presentation"><section ref={ref} className="code-modal code-detail" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>{children}</section></div>;
}

export function CodeTasksPage({ suspended = false }: { suspended?: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [foreground, setForeground] = useState(document.visibilityState !== 'hidden');
  const [configError, setConfigError] = useState<string | null>(null);
  const loadConfig = () => { setConfigError(null); void fetchConfig().then((config) => setEnabled(config.coding_tasks_enabled === true)).catch(() => setConfigError('Could not connect to this device.')); };
  useEffect(loadConfig, []);
  useEffect(() => {
    const change = () => setForeground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  const [mode, setMode] = useState<FactoryMode>('code');
  if (enabled === false) return <div className="page code-tasks code-tasks--unavailable">Code Factory is not enabled on this device.</div>;
  return <>{(['code', 'research'] as const).map((panelMode) => <FactoryTaskPanel key={panelMode} mode={panelMode} active={mode === panelMode} suspended={suspended} enabled={enabled === true && foreground} onModeChange={setMode} configError={configError} reloadConfig={loadConfig} />)}</>;
}

function FactoryTaskPanel({ mode, active, suspended, enabled, onModeChange, configError, reloadConfig }: {
  mode: FactoryMode; active: boolean; suspended: boolean; enabled: boolean; onModeChange: (mode: FactoryMode) => void;
  configError: string | null; reloadConfig: () => void;
}) {
  const research = mode === 'research';
  const feed = useCodeTaskFeed(enabled && active && !suspended, !research, mode);
  const selected = feed.selected;
  const [newOpen, setNewOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingPending, setRecordingPending] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [model, setModel] = useState<CodeTaskModel>('gpt-6-sol');
  const [verbosity, setVerbosity] = useState<ResearchVerbosity>('standard');
  const [report, setReport] = useState<{ html: string; title: string } | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const reportRequest = useRef<AbortController | null>(null);
  const { ringing } = useTimerAlarm();
  const { voiceTurn } = useVoiceTurn();
  const canShowModal = active && !suspended && ringing.kind === 'none' && !voiceTurn;
  useEffect(() => {
    if (ringing.kind !== 'none' || voiceTurn || suspended) {
      reportRequest.current?.abort(); setReport(null); setReportLoading(false);
    }
  }, [ringing.kind, voiceTurn, suspended]);
  const [followUpParent, setFollowUpParent] = useState<CodeTask | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followOutput, setFollowOutput] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  const actionBusy = useRef(false);
  const loadingMore = useRef(feed.loadMore); loadingMore.current = feed.loadMore;

  useEffect(() => {
    if (!active || !feed.hasMore || feed.error || !sentinelRef.current || !listRef.current) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadingMore.current(); }, { root: listRef.current, rootMargin: '250px' });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [active, feed.hasMore, feed.tasks.length, feed.error]);
  useEffect(() => { setFollowOutput(true); setError(null); }, [selected?.id]);
  useEffect(() => {
    setReport(null); setReportLoading(false);
    return () => { reportRequest.current?.abort(); };
  }, [selected?.id, active]);
  useEffect(() => {
    if (followOutput && activityRef.current) activityRef.current.scrollTop = activityRef.current.scrollHeight;
  }, [feed.output, followOutput]);

  const recordButton = async () => {
    if (actionBusy.current) return;
    actionBusy.current = true; setError(null);
    if (!recording) {
      setRecordingPending(true);
      try { await (research ? startResearchTaskRecording() : startCodeTaskRecording()); setRecording(true); setDraft(null); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start recording'); }
      finally { setRecordingPending(false); actionBusy.current = false; }
      return;
    }
    setTranscribing(true);
    try { const result = await (research ? stopResearchTaskRecording() : stopCodeTaskRecording()); setDraft(result.transcript); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not transcribe the prompt'); }
    finally { setRecording(false); setTranscribing(false); actionBusy.current = false; }
  };
  const confirmDraft = async () => {
    if (!draft?.trim() || actionBusy.current) return;
    actionBusy.current = true; setError(null); setSubmitting(true);
    try {
      const task = research ? await createResearchTask(draft.trim(), model, verbosity) : followUpParent ? await followUpCodeTask(followUpParent.id, draft.trim()) : await createCodeTask(draft.trim(), model);
      setDraft(null); setFollowUpParent(null); setNewOpen(false); feed.updateTask(task); feed.open(task); void feed.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create task'); }
    finally { actionBusy.current = false; setSubmitting(false); }
  };
  const cancel = async () => {
    if (!selected || actionBusy.current) return;
    actionBusy.current = true; setError(null); setCancelling(true);
    try { feed.updateTask(await (research ? cancelResearchTask(selected.id) : cancelCodeTask(selected.id))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel task'); }
    finally { actionBusy.current = false; setCancelling(false); }
  };
  const closeNew = () => { setNewOpen(false); if (followUpParent) { setDraft(null); setFollowUpParent(null); } setError(null); };
  const openNew = () => { setFollowUpParent(null); setError(null); setNewOpen(true); };
  const followUp = () => { setFollowUpParent(selected); setDraft(null); setError(null); feed.close(); setNewOpen(true); };
  const reuse = () => {
    if (!selected) return;
    setDraft(selected.prompt); setFollowUpParent(null);
    if (AGENT_MODELS.some((option) => option.id === selected.model)) setModel(selected.model as CodeTaskModel);
    if (selected.verbosity) setVerbosity(selected.verbosity);
    feed.close(); setNewOpen(true);
  };
  const readReport = async () => {
    if (!selected || reportLoading) return;
    const controller = new AbortController();
    reportRequest.current?.abort(); reportRequest.current = controller;
    setError(null); setReportLoading(true);
    try {
      const result = await fetchResearchReport(selected.id, controller.signal);
      if (controller.signal.aborted) return;
      if (result.task_id !== selected.id || !result.html?.trim()) throw new Error('This report is unavailable. Try again.');
      setReport({ html: result.html, title: selected.prompt });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load the report');
    } finally { if (!controller.signal.aborted) setReportLoading(false); }
  };
  const badge = (task: CodeTask) => <span className={`code-status code-status--${task.status}`}>{taskStatusLabel(task.status)}</span>;

  return <div className="page code-tasks factory-tasks" style={active ? undefined : { display: 'none' }}>
    <header className="code-tasks-header"><h1>Code Factory</h1><div className="factory-modes" role="group" aria-label="Task type">{(['code', 'research'] as const).map((option) => <button type="button" key={option} aria-pressed={mode === option} onClick={() => onModeChange(option)}>{option === 'code' ? 'Code' : 'Research'}</button>)}</div><button type="button" className="code-new-btn" onClick={openNew} disabled={!enabled}>+ New task</button></header>
    <div className="code-toolbar"><div className="code-filters" role="tablist" aria-label="Task history">{TASK_FILTERS.map((filter) => <button key={filter.id} type="button" role="tab" aria-selected={feed.view === filter.id} className={feed.view === filter.id ? 'selected' : ''} onClick={() => feed.setView(filter.id)}>{filter.label}</button>)}</div><button type="button" className="code-refresh" disabled={feed.refreshing} onClick={() => void feed.refresh()} aria-label="Refresh tasks">{feed.refreshing ? 'Refreshing…' : '↻ Refresh'}</button></div>
    {configError ? <p className="code-error" role="alert">{configError} <button type="button" className="code-link" onClick={reloadConfig}>Retry</button></p> : null}
    {feed.error ? <p className="code-error" role="alert">{feed.error} <button type="button" className="code-link" onClick={() => void feed.refresh()}>Retry connection</button></p> : null}
    <div ref={listRef} className="code-task-list" aria-label={research ? 'Research tasks' : 'Coding tasks'} aria-busy={feed.loading}>
      {feed.loading ? <p className="code-empty">Loading tasks…</p> : !feed.tasks.length ? <div className="code-empty"><h2>{feed.view === 'active' ? 'No active tasks' : feed.view === 'history' ? 'No finished tasks' : research ? 'No research tasks' : 'No coding tasks'}</h2><p>{feed.view === 'history' ? 'Completed, cancelled, and failed tasks appear here.' : 'Choose New task to record a request.'}</p></div> : null}
      {feed.tasks.map((task) => <button key={task.id} type="button" className="code-task-card" onClick={() => feed.open(task)}>{badge(task)}<span className="code-card-model">{modelLabel(task.model)}{task.parent_task_id ? ' · Follow-up' : ''}</span><span className="code-task-prompt">{task.prompt}</span><time>{shortDate(task.created_at)}</time>{task.output_seq ? <span className="code-card-updates">{task.output_seq} updates</span> : null}</button>)}
      <div ref={sentinelRef} className="code-list-footer">{feed.loadingMore ? 'Loading older tasks…' : feed.hasMore ? <button type="button" className="code-refresh" onClick={() => void feed.loadMore()}>Load older tasks</button> : null}</div>
    </div>

    {newOpen && canShowModal && <TaskModal title={followUpParent ? 'Queue a follow-up' : research ? 'New research task' : 'New coding task'} onClose={closeNew} locked={recording || recordingPending || transcribing || submitting}>
      <div className="factory-create-heading"><h2>{followUpParent ? 'Queue a follow-up' : draft === null ? research ? 'Record a research prompt' : 'Record a coding prompt' : 'Review your request'}</h2><button type="button" className="code-close-icon" aria-label="Close new task" disabled={recording || recordingPending || transcribing || submitting} onClick={closeNew}>×</button></div>
      <div className="factory-create-body">
      <p className="factory-instructions">{followUpParent ? 'Creates a separate task with the original request and its latest saved outcome.' : research ? 'Describe the question and what the report should cover. Review the transcript before sending.' : 'Describe the change and how you’ll know it works. Review the transcript before sending.'}</p>
      {followUpParent && <p className="code-follow-up-context">Following: {followUpParent.prompt}</p>}
      {draft === null ? <button type="button" className={`code-record-btn${recording ? ' recording' : ''}`} disabled={transcribing || recordingPending} onClick={() => void recordButton()}><span className="code-record-dot" aria-hidden />{transcribing ? 'Transcribing…' : recordingPending ? 'Starting microphone…' : recording ? 'Push to stop' : 'Push to record'}</button> : <>
        <p className="code-transcript">{draft || 'No speech detected. Try recording again.'}</p>
        {!followUpParent && <div className="factory-options"><div><p className="code-model-hint">Agent model</p><div className="code-model-row" role="radiogroup" aria-label="Agent model">{AGENT_MODELS.map((option) => <button key={option.id} type="button" role="radio" aria-checked={model === option.id} className={`code-model-chip${model === option.id ? ' selected' : ''}`} disabled={submitting} onClick={() => setModel(option.id)}>{option.label}</button>)}</div></div>
        {research && <div><p className="code-model-hint">Report detail</p><div className="code-model-row" role="radiogroup" aria-label="Report detail">{REPORT_DEPTHS.map((option) => <button key={option.id} type="button" role="radio" aria-checked={verbosity === option.id} className={`code-model-chip${verbosity === option.id ? ' selected' : ''}`} disabled={submitting} onClick={() => setVerbosity(option.id)}>{option.label}</button>)}</div></div>}</div>}
      </>}
      {error && <p className="code-error" role="alert">{error}</p>}
      </div>
      {draft !== null && <div className="code-detail-actions"><button type="button" className="code-modal-close" disabled={submitting || recordingPending} onClick={() => void recordButton()}>Re-record</button><button type="button" className="code-confirm-task" disabled={submitting || recordingPending || !draft.trim()} onClick={() => void confirmDraft()}>{submitting ? 'Creating…' : followUpParent ? 'Queue follow-up' : 'Create task'}</button></div>}
    </TaskModal>}

    {selected && !report && canShowModal && <TaskModal title={research ? 'Research task details' : 'Coding task details'} onClose={feed.close}>
      <div className="code-detail-title">{badge(selected)}{modelLabel(selected.model) && <span className="code-model-tag">{modelLabel(selected.model)}</span>}<button type="button" className="code-close-icon" onClick={feed.close} aria-label="Close task details">×</button></div>
      <div className="code-detail-body">
        <p className="code-detail-prompt">{selected.prompt}</p><p className="code-meta">{shortDate(selected.created_at)} · {taskTiming(selected)}</p>
        {research && selected.verbosity && <p className="code-meta">{REPORT_DEPTHS.find(option => option.id === selected.verbosity)?.label} report</p>}
        {selected.parent_task_id && <p className="code-meta">Follow-up task · {selected.parent_task_id.slice(0, 8)}</p>}
        {selected.error && <p className="code-error">{selected.error}</p>}
        {taskResult(selected) && <section className="code-result"><h3>Result</h3><p>{taskResult(selected)}</p></section>}
        <div className="code-activity-heading"><h3>Activity</h3><span className={`code-connection code-connection--${feed.connection}`} role="status">{({ connecting: 'Connecting…', live: 'Live updates', reconnecting: 'Reconnecting…', complete: 'Up to date' })[feed.connection]}</span></div>
        {(feed.truncated || feed.output.length >= 500) && <p className="code-meta">Showing recent activity. Full available logs are below.</p>}
        <div className="code-activity" ref={activityRef} onScroll={(event) => { const el = event.currentTarget; setFollowOutput(el.scrollHeight - el.scrollTop - el.clientHeight < 60); }}>
          {feed.output.length ? feed.output.map((item) => <article key={item.seq} className={`code-activity-item code-activity-item--${item.kind}`}><div>{item.kind === 'assistant' ? 'Agent' : item.kind}<time>{new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{item.text}</p></article>) : <p className="code-meta">{ACTIVE.has(selected.status) ? 'Waiting for the first update. You can close this view; the task will keep working.' : 'No recorded activity for this task.'}</p>}
        </div>
        {!followOutput && <button type="button" className="code-jump" onClick={() => { setFollowOutput(true); }}>↓ Jump to latest</button>}
        {(selected.stdout || selected.stderr) && <details className="code-raw-logs"><summary>Raw logs</summary><pre>{[selected.stdout, selected.stderr].filter(Boolean).join('\n\n')}</pre></details>}
        {!!selected.changed_paths?.length && <details className="code-raw-logs"><summary>Changed files · {selected.changed_paths.length}</summary><ul className="code-paths">{selected.changed_paths.map((path) => <li key={path}>{path}</li>)}</ul></details>}
        {error && <p className="code-error" role="alert">{error}</p>}
      </div>
      <div className="code-detail-actions"><button type="button" className="code-modal-close" disabled={cancelling || reportLoading} onClick={reuse}>Reuse prompt</button>{research ? selected.report_available && <button type="button" className="code-confirm-task" disabled={reportLoading} onClick={() => void readReport()}>{reportLoading ? 'Loading report…' : 'Read report'}</button> : <button type="button" className="code-confirm-task" disabled={cancelling} onClick={followUp}>Follow up</button>}</div>
      {ACTIVE.has(selected.status) && selected.status !== 'cancel_requested' && <button type="button" className="code-cancel-task" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? 'Requesting cancellation…' : 'Cancel task'}</button>}
    </TaskModal>}
    {report && canShowModal && <ResearchReportViewer html={report.html} title={report.title} onClose={() => setReport(null)} />}
  </div>;
}
