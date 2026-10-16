import { useCallback, useEffect, useRef, useState } from 'react';
import './light-menu.css';

type Light = { id: string; name: string; room: string; available: boolean; power: boolean | null };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("Couldn't reach the lights. Try again.");
  return response.json() as Promise<T>;
}

export function LightMenu({ initialRoom, onClose }: { initialRoom: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => { dialog.current?.close(); onClose(); };
  const [lights, setLights] = useState<Light[]>([]);
  const [room, setRoom] = useState(initialRoom);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    const rows = await request<Light[]>('/api/lights');
    if (alive.current) setLights(rows);
  }, []);
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    void reload().catch(e => { if (alive.current) setError(e.message); }).finally(() => { if (alive.current) setLoading(false); });
    const timer = window.setInterval(() => {
      if (!lock.current) void reload().catch(() => { if (alive.current) setError("Couldn't refresh light status. Try again."); });
    }, 15000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [reload]);
  const control = async (scope: 'room' | 'device', selector: string, on: boolean) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await request<{ failed: number }>('/api/lights/control', { scope, selector, action: on ? 'turn_on' : 'turn_off' });
      if (alive.current && result.failed) setError(`${result.failed} light${result.failed === 1 ? '' : 's'} didn't respond. Check their status before trying again.`);
      await reload();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Couldn't change lights."); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const rooms = [...new Set([initialRoom, ...lights.map(light => light.room)])].sort((a, b) => a.localeCompare(b));
  const visible = lights.filter(light => light.room === room).sort((a, b) => a.name.localeCompare(b.name));
  const onCount = visible.filter(light => light.power === true).length;
  return <dialog ref={dialog} className="light-menu" aria-labelledby="light-menu-title" onCancel={close}
    onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } }}>
    <header><h1 id="light-menu-title">Lights</h1><button autoFocus onClick={close}>Done</button></header>
    <nav aria-label="Light rooms">{rooms.map(name => <button key={name} aria-pressed={name === room} onClick={() => { setRoom(name); setError(''); }}>{name || 'Unassigned'}</button>)}</nav>
    <section className="light-menu-summary" aria-label="Room lights">
      <div><h2>{room || 'Unassigned'}</h2><span>{loading ? 'Loading…' : `${onCount} of ${visible.length} on`}{busy ? ' · Updating…' : ''}</span></div>
      <button disabled={loading || busy || !room || !visible.some(l => l.available)} onClick={() => void control('room', room, true)}>All on</button>
      <button disabled={loading || busy || !room || !visible.some(l => l.available)} onClick={() => void control('room', room, false)}>All off</button>
    </section>
    {error && <div className="light-menu-error" role="alert"><span>{error}</span><button disabled={busy} onClick={() => { setError(''); void reload().catch(e => setError(e.message)); }}>Refresh</button></div>}
    <div className="light-menu-list" aria-busy={loading || busy}>
      {!loading && !visible.length && <p>No lights in this room.</p>}
      {visible.map(light => <button key={light.id} role="switch" aria-checked={light.power === true} aria-label={light.name}
        disabled={busy || !light.available} onClick={() => void control('device', light.id, light.power !== true)}>
        <span className="light-menu-name">{light.name}<small>{!light.available ? 'Unavailable' : light.power === null ? 'Status unknown · Tap to turn on' : light.power ? 'On' : 'Off'}</small></span>
        <span className={`light-menu-switch${light.power ? ' is-on' : ''}`} aria-hidden="true"><span /></span>
      </button>)}
    </div>
  </dialog>;
}
