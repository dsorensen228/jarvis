import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelCodeTask,
  createCodeTask,
  fetchCodeTask,
  fetchCodeTasks,
  fetchConfig,
  startCodeTaskRecording,
  stopCodeTaskRecording,
  type CodeTask,
} from '../api';

const ACTIVE = new Set(['pending', 'queued', 'running', 'cancel_requested']);

const AGENT_MODELS = [
  { id: 'gpt-5.6-sol-medium', label: 'GPT-5.6 Sol' },
  { id: 'claude-opus-5-thinking-high', label: 'Opus 5' },
  { id: 'claude-fable-5-thinking-high', label: 'Fable 5' },
] as const;

function modelLabel(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  return AGENT_MODELS.find((model) => model.id === modelId)?.label ?? modelId;
}

function taskOutput(task: CodeTask): string {
  if (task.agent_output != null) {
    if (typeof task.agent_output === 'string') return task.agent_output;
    if (typeof task.agent_output === 'object') {
      const result = (task.agent_output as { result?: unknown }).result;
      if (typeof result === 'string') return result;
    }
    return JSON.stringify(task.agent_output, null, 2);
  }
  return task.error || task.stdout || task.stderr || 'No output yet.';
}

function shortDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function CodeTasksPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [tasks, setTasks] = useState<CodeTask[]>([]);
  const [selected, setSelected] = useState<CodeTask | null>(null);
  const selectedRef = useRef<CodeTask | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const load = useCallback(async () => {
    try {
      const rows = await fetchCodeTasks();
      setTasks(rows);
      setError(null);
      const current = selectedRef.current;
      if (current) {
        const refreshed = rows.find((task) => task.id === current.id);
        if (refreshed) setSelected(refreshed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load coding tasks');
    }
  }, []);

  useEffect(() => {
    void fetchConfig().then((config) => setEnabled(config.coding_tasks_enabled === true));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [enabled, load]);

  const grouped = useMemo(
    () => [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [tasks]
  );

  const recordButton = async () => {
    setError(null);
    if (!recording) {
      setDraft(null);
      try {
        await startCodeTaskRecording();
        setRecording(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start recording');
      }
      return;
    }
    setTranscribing(true);
    try {
      const result = await stopCodeTaskRecording();
      setRecording(false);
      setDraft(result.transcript);
    } catch (err) {
      setRecording(false);
      setError(err instanceof Error ? err.message : 'Could not transcribe the prompt');
    } finally {
      setTranscribing(false);
    }
  };

  const confirmDraft = async () => {
    if (!draft) return;
    setError(null);
    setSubmitting(true);
    try {
      const task = await createCodeTask(draft, model);
      setDraft(null);
      setModel(null);
      setNewOpen(false);
      setSelected(task);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create task');
    } finally {
      setSubmitting(false);
    }
  };

  const closeNew = () => {
    setNewOpen(false);
    setDraft(null);
    setModel(null);
    setError(null);
  };

  const openDetail = async (task: CodeTask) => {
    setSelected(task);
    try {
      setSelected(await fetchCodeTask(task.id));
    } catch {
      // The list record is still useful if a refresh races with service availability.
    }
  };

  if (enabled === false) {
    return <div className="page code-tasks code-tasks--unavailable">Coding tasks are not enabled on this device.</div>;
  }

  return (
    <div className="page code-tasks">
      <header className="code-tasks-header">
        <div>
          <h1>Code Factory</h1>
          <p>Manual tasks only</p>
        </div>
        <button type="button" className="code-new-btn" onClick={() => { setModel(null); setNewOpen(true); }}>
          + New task
        </button>
      </header>
      {error && !newOpen ? <p className="code-error">{error}</p> : null}
      <div className="code-task-list">
        {grouped.length === 0 ? <p className="muted">No coding tasks yet.</p> : null}
        {grouped.map((task) => (
          <button key={task.id} type="button" className="code-task-card" onClick={() => void openDetail(task)}>
            <span className={`code-status code-status--${task.status}`}>{task.status.replace('_', ' ')}</span>
            <span className="code-task-prompt">{task.prompt}</span>
            <time>{shortDate(task.created_at)}</time>
          </button>
        ))}
      </div>

      {newOpen ? (
        <div className="code-modal-backdrop" role="presentation">
          <section className="code-modal" role="dialog" aria-modal="true" aria-label="New coding task">
            {draft === null ? (
              <>
                <h2>Record a coding prompt</h2>
                <p>You confirm the transcript before the task is created. The agent decides which repositories to change.</p>
                <button
                  type="button"
                  className={`code-record-btn${recording ? ' recording' : ''}`}
                  disabled={transcribing}
                  onClick={() => void recordButton()}
                >
                  <span className="code-record-dot" aria-hidden />
                  {transcribing ? 'Transcribing…' : recording ? 'Push to stop' : 'Push to record prompt'}
                </button>
                {error ? <p className="code-error">{error}</p> : null}
                {!recording && !transcribing ? (
                  <button type="button" className="code-modal-close" onClick={closeNew}>
                    Cancel
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <h2>Is this right?</h2>
                <p>Re-record if the transcription is wrong.</p>
                <p className="code-transcript">{draft}</p>
                <p className="code-model-hint">Model override · Auto when none is selected</p>
                <div className="code-model-row" role="radiogroup" aria-label="Agent model override">
                  {AGENT_MODELS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={model === option.id}
                      className={`code-model-chip${model === option.id ? ' selected' : ''}`}
                      disabled={submitting}
                      onClick={() => setModel((current) => current === option.id ? null : option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {error ? <p className="code-error">{error}</p> : null}
                <div className="code-detail-actions">
                  <button
                    type="button"
                    className="code-modal-close"
                    disabled={submitting}
                    onClick={() => void recordButton()}
                  >
                    Re-record
                  </button>
                  <button
                    type="button"
                    className="code-confirm-task"
                    disabled={submitting}
                    onClick={() => void confirmDraft()}
                  >
                    {submitting ? 'Creating…' : 'Create task'}
                  </button>
                </div>
                <button type="button" className="code-modal-close" disabled={submitting} onClick={closeNew}>
                  Cancel
                </button>
              </>
            )}
          </section>
        </div>
      ) : null}

      {selected ? (
        <div className="code-modal-backdrop" role="presentation">
          <section className="code-modal code-detail" role="dialog" aria-modal="true" aria-label="Coding task details">
            <div className="code-detail-title">
              <span className={`code-status code-status--${selected.status}`}>{selected.status.replace('_', ' ')}</span>
              {modelLabel(selected.model) ? (
                <span className="code-model-tag">{modelLabel(selected.model)}</span>
              ) : null}
            </div>
            <p className="code-detail-prompt">{selected.prompt}</p>
            <pre>{taskOutput(selected)}</pre>
            {selected.changed_paths?.length ? <p className="code-paths">Changed: {selected.changed_paths.join(', ')}</p> : null}
            <div className="code-detail-actions">
              {ACTIVE.has(selected.status) && selected.status !== 'cancel_requested' ? (
                <button type="button" className="code-cancel-task" onClick={() => void (async () => { setSelected(await cancelCodeTask(selected.id)); await load(); })()}>
                  Cancel task
                </button>
              ) : null}
              <button type="button" className="code-modal-close" onClick={() => setSelected(null)}>Close</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
