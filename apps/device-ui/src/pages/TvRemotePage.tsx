import { useCallback, useEffect, useState } from 'react';
import {
  fetchScreens,
  launchScreenApp,
  pressScreenKey,
  sendScreenAction,
  type RemoteKey,
  type ScreenRow,
} from '../api';
import { OnScreenKeyboard } from '../ui/OnScreenKeyboard';

const ICON_STROKE = '#e8e8ed';
const ICON_SIZE = 22;

function IconChevron({ dir }: { dir: 'n' | 's' | 'e' | 'w' }) {
  const d =
    dir === 'n'
      ? 'M6 15l6-6 6 6'
      : dir === 's'
        ? 'M6 9l6 6 6-6'
        : dir === 'w'
          ? 'M15 6l-6 6 6 6'
          : 'M9 6l6 6-6 6';
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d={d} stroke={ICON_STROKE} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPower() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2v10M8.5 5.5a7 7 0 109 9 7 7 0 00-9-9z"
        stroke={ICON_STROKE}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconVolUp() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"
        stroke={ICON_STROKE}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconVolDown() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M11 5L6 9H2v6h4l5 4V5zM15.54 15.54a5 5 0 000-7.07"
        stroke={ICON_STROKE}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMute() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M11 5L6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6"
        stroke={ICON_STROKE}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBack() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15 18l-6-6 6-6"
        stroke={ICON_STROKE}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconHome() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9zM9 22V12h6v10"
        stroke={ICON_STROKE}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconRev() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M11 18V6l-8 6 8 6zM21 18V6l-8 6 8 6z"
        fill={ICON_STROKE}
        stroke="none"
      />
    </svg>
  );
}

function IconFwd() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M13 6v12l8-6-8-6zM3 6v12l8-6-8-6z"
        fill={ICON_STROKE}
        stroke="none"
      />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 5v14l11-7L8 5z" fill={ICON_STROKE} />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 5h3v14H7V5zm7 0h3v14h-3V5z" fill={ICON_STROKE} />
    </svg>
  );
}

/** The API decides which screen a room means, so every surface agrees. */
function pickScreenId(rows: ScreenRow[], prev: string): string {
  if (!rows.length) return '';
  if (prev && rows.some((row) => row.id === prev)) return prev;
  return rows.find((row) => row.is_room_default)?.id ?? rows[0].id;
}

export function TvRemotePage() {
  const [screens, setScreens] = useState<ScreenRow[]>([]);
  const [sel, setSel] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [launch, setLaunch] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const rows = await fetchScreens();
      setScreens(rows);
      setSel((prev) => pickScreenId(rows, prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Load failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = async () => {
    setBusy(true);
    try {
      await load();
    } finally {
      setBusy(false);
    }
  };

  const run = async (label: string, work: () => Promise<void>) => {
    if (!sel) return;
    setBusy(true);
    setErr(null);
    try {
      await work();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  const sendKey = (key: RemoteKey) => run(key, () => pressScreenKey(sel, key));

  const sendAction = (
    action: 'play' | 'pause' | 'mute' | 'unmute' | 'volume_up' | 'volume_down'
  ) => run(action, () => sendScreenAction(sel, action));

  const sendMuteToggle = () => {
    const selected = screens.find((row) => row.id === sel);
    const rokuStyleRemote = selected?.capabilities.includes('remote_keys');
    if (rokuStyleRemote) {
      return run('mute', async () => {
        await pressScreenKey(sel, 'volume_mute');
        await load();
      });
    }
    const action = selected?.muted ? 'unmute' : 'mute';
    return run(action, async () => {
      await sendScreenAction(sel, action);
      await load();
    });
  };

  const sendPower = () => {
    const selected = screens.find((row) => row.id === sel);
    return run('power', async () => {
      await sendScreenAction(sel, selected?.power === true ? 'turn_off' : 'turn_on');
      await load();
    });
  };

  const onLaunch = () => {
    const app = launch.trim();
    if (!app) return;
    return run('launch', async () => {
      await launchScreenApp(sel, app);
      setLaunch('');
      setKeyboardOpen(false);
    });
  };

  if (!screens.length) {
    return (
      <div className="page tv-remote-page">
        <div className="tv-remote-empty">
          <p className="tv-remote-muted">No screens yet. Add one in Home Assistant.</p>
          <button type="button" className="tv-remote-btn tv-remote-btn-wide" disabled={busy} onClick={() => void onRefresh()}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          {err ? <p className="tv-remote-err">{err}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`page tv-remote-page${keyboardOpen ? ' tv-remote-page--osk-open' : ''}`}>
      <header className="tv-remote-header">
        <div className="tv-remote-header-row">
          <label className="tv-remote-muted" htmlFor="tv-sel">
            Screen
          </label>
          <select
            id="tv-sel"
            className="tv-remote-select"
            value={sel}
            onChange={(e) => setSel(e.target.value)}
          >
            {screens.map((screen) => (
              <option key={screen.id} value={screen.id}>
                {screen.available ? screen.name : `${screen.name} (unavailable)`}
              </option>
            ))}
          </select>
          <button type="button" className="tv-remote-btn tv-remote-btn-small" disabled={busy} onClick={() => void onRefresh()}>
            Refresh
          </button>
        </div>
        {err ? <p className="tv-remote-err">{err}</p> : null}
      </header>

      <div className="tv-remote-body">
        <aside className="tv-remote-side">
          <button
            type="button"
            className="tv-remote-btn tv-remote-btn--icon"
            disabled={busy}
            aria-label="Power"
            onClick={() => void sendPower()}
          >
            <IconPower />
          </button>
          <button
            type="button"
            className="tv-remote-btn tv-remote-btn--icon"
            disabled={busy}
            aria-label="Home"
            onClick={() => void sendKey('home')}
          >
            <IconHome />
          </button>
        </aside>
        <main className="tv-remote-center">
          <div className="tv-remote-dpad-ring" role="group" aria-label="Directional pad">
            <span className="tv-remote-dpad-cell tv-remote-dpad-cell--empty" />
            <button
              type="button"
              className="tv-remote-dpad-arrow tv-remote-dpad-arrow--n"
              disabled={busy}
              aria-label="Up"
              onClick={() => void sendKey('up')}
            >
              <IconChevron dir="n" />
            </button>
            <span className="tv-remote-dpad-cell tv-remote-dpad-cell--empty" />
            <button
              type="button"
              className="tv-remote-dpad-arrow tv-remote-dpad-arrow--w"
              disabled={busy}
              aria-label="Left"
              onClick={() => void sendKey('left')}
            >
              <IconChevron dir="w" />
            </button>
            <button
              type="button"
              className="tv-remote-dpad-ok"
              disabled={busy}
              aria-label="OK"
              onClick={() => void sendKey('select')}
            >
              OK
            </button>
            <button
              type="button"
              className="tv-remote-dpad-arrow tv-remote-dpad-arrow--e"
              disabled={busy}
              aria-label="Right"
              onClick={() => void sendKey('right')}
            >
              <IconChevron dir="e" />
            </button>
            <span className="tv-remote-dpad-cell tv-remote-dpad-cell--empty" />
            <button
              type="button"
              className="tv-remote-dpad-arrow tv-remote-dpad-arrow--s"
              disabled={busy}
              aria-label="Down"
              onClick={() => void sendKey('down')}
            >
              <IconChevron dir="s" />
            </button>
            <span className="tv-remote-dpad-cell tv-remote-dpad-cell--empty" />
          </div>
          <div className="tv-remote-nav2 tv-remote-nav2--compact">
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn--icon"
              disabled={busy}
              aria-label="Back"
              onClick={() => void sendKey('back')}
            >
              <IconBack />
            </button>
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn--icon"
              disabled={busy}
              aria-label="Pause"
              onClick={() => void sendAction('pause')}
            >
              <IconPause />
            </button>
          </div>
          <div className="tv-remote-nav2" role="group" aria-label="Transport">
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn--icon"
              disabled={busy}
              aria-label="Rewind"
              onClick={() => void sendKey('rewind')}
            >
              <IconRev />
            </button>
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn--icon"
              disabled={busy}
              aria-label="Play"
              onClick={() => void sendAction('play')}
            >
              <IconPlay />
            </button>
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn--icon"
              disabled={busy}
              aria-label="Fast forward"
              onClick={() => void sendKey('fast_forward')}
            >
              <IconFwd />
            </button>
          </div>
          <div className="tv-remote-vol-row" role="group" aria-label="Volume">
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn--icon"
              disabled={busy}
              aria-label="Volume up"
              onClick={() => void sendAction('volume_up')}
            >
              <IconVolUp />
            </button>
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn--icon"
              disabled={busy}
              aria-label="Volume down"
              onClick={() => void sendAction('volume_down')}
            >
              <IconVolDown />
            </button>
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn--icon"
              disabled={busy}
              aria-label={screens.find((row) => row.id === sel)?.muted ? 'Unmute' : 'Mute'}
              onClick={() => void sendMuteToggle()}
            >
              <IconMute />
            </button>
          </div>
        </main>
        <aside className="tv-remote-side tv-remote-side-right">
          <div className="tv-remote-launch">
            <input
              type="text"
              inputMode="none"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="tv-remote-input"
              placeholder="App name (e.g. Netflix)"
              value={launch}
              onChange={(e) => setLaunch(e.target.value)}
              onFocus={(e) => {
                setKeyboardOpen(true);
                e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }}
              onBlur={() => setKeyboardOpen(false)}
              aria-label="App name to launch"
            />
            <button
              type="button"
              className="tv-remote-btn tv-remote-btn-wide"
              disabled={busy || !launch.trim()}
              onClick={() => void onLaunch()}
            >
              Go
            </button>
          </div>
        </aside>
      </div>
      <OnScreenKeyboard
        open={keyboardOpen}
        onChar={(c) => setLaunch((q) => q + c)}
        onBackspace={() => setLaunch((q) => [...q].slice(0, -1).join(''))}
      />
    </div>
  );
}
