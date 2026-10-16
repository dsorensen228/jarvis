import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchScreens, screenCommand, type RemoteKey, type ScreenAction, type ScreenRow } from '../api';
import './tv-remote.css';

const BASIC_KEYS: RemoteKey[] = ['home', 'back', 'up', 'down', 'left', 'right', 'select', 'rewind', 'fast_forward', 'replay', 'info', 'play', 'enter', 'backspace', 'search'];
type Panel = 'remote' | 'sources' | 'keyboard' | 'more';
type Command = { id: string; epoch: number; action: ScreenAction; parameters: Record<string, unknown>; done?: () => void };

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    up: <path d="m6 15 6-6 6 6" />, down: <path d="m6 9 6 6 6-6" />,
    left: <path d="m15 6-6 6 6 6" />, right: <path d="m9 6 6 6-6 6" />,
    power: <path d="M12 3v9M7 5a8 8 0 1 0 10 0" />,
    home: <path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9" />,
    back: <path d="m10 5-7 7 7 7M3 12h12a6 6 0 0 1 6 6" />,
    info: <><circle cx="12" cy="12" r="8" /><path d="M12 7v.1M12 11v6" /></>,
    replay: <><path d="M4 11a8 8 0 1 1 2 7M4 4v7h7" /><path d="M12 8v5l3 2" /></>,
    rewind: <path d="m11 5-9 7 9 7V5Zm11 0-9 7 9 7V5Z" />,
    fast_forward: <path d="m2 5 9 7-9 7V5Zm11 0 9 7-9 7V5Z" />,
    play: <path d="m7 4 13 8-13 8V4Z" />,
    pause: <path d="M8 4v16M16 4v16" />,
    play_pause: <><path d="m3 5 9 7-9 7V5Z" /><path d="M16 5v14M21 5v14" /></>,
    volume_up: <><path d="m11 5-5 4H2v6h4l5 4V5ZM15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16" /></>,
    volume_down: <path d="m11 5-5 4H2v6h4l5 4V5ZM15 8a6 6 0 0 1 0 8" />,
    mute: <path d="m11 5-5 4H2v6h4l5 4V5ZM16 9l6 6M22 9l-6 6" />,
    apps: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    keyboard: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 12h.1M10 12h.1M14 12h.1M18 12h.1M7 16h10" /></>,
    more: <><circle cx="4" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="20" cy="12" r="1" /></>,
    refresh: <path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5" />,
    check: <path d="m5 12 4 4 10-10" />,
  };
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.more}</svg>;
}

export function TvRemotePage() {
  const [screens, setScreens] = useState<ScreenRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [panel, setPanel] = useState<Panel>('remote');
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(0);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState('');
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const selectedRef = useRef('');
  const epoch = useRef(0);
  const queue = useRef<Command[]>([]);
  const draining = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setRefreshing(true);
    try {
      const rows = await fetchScreens(controller.signal);
      if (!mounted.current || request.current !== controller) return;
      setScreens(rows);
      if (!rows.some(row => row.id === selectedRef.current)) {
        const next = rows.find(row => row.is_room_default)?.id ?? rows[0]?.id ?? '';
        epoch.current += 1;
        queue.current = [];
        selectedRef.current = next;
        setSelectedId(next);
        setPending(0);
        setPanel('remote');
        setText('');
        setChannel('');
        setError('');
        setNotice('');
      }
      setReadError('');
    } catch (cause) {
      if (!mounted.current || request.current !== controller) return;
      queue.current = [];
      setReadError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'TV state request timed out.');
    } finally {
      clearTimeout(timeout);
      if (mounted.current && request.current === controller) {
        setLoaded(true);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const interval = setInterval(() => { if (!document.hidden && !draining.current) void load(); }, 10_000);
    return () => {
      mounted.current = false;
      epoch.current += 1;
      queue.current = [];
      request.current?.abort();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      clearInterval(interval);
    };
  }, [load]);

  const selected = screens.find(row => row.id === selectedId);
  const has = (capability: string) => Boolean(selected?.capabilities.includes(capability));
  const supports = (key: RemoteKey) => has('remote_keys') && (selected?.supported_keys ?? BASIC_KEYS).includes(key);
  const unavailable = !selected?.available || Boolean(readError);
  const blocked = unavailable || pending >= 8;

  // One ordered stream of commands, bound to the selected TV at the time of the tap.
  // Navigation remains touchable while a request is in flight; never retry a toggle.
  const drain = async () => {
    if (draining.current) return;
    draining.current = true;
    while (mounted.current && queue.current.length) {
      const command = queue.current.shift()!;
      if (command.epoch !== epoch.current) continue;
      try {
        await screenCommand(command.id, command.action, command.parameters);
        if (mounted.current && command.epoch === epoch.current) command.done?.();
      } catch (cause) {
        if (mounted.current && command.epoch === epoch.current) {
          queue.current = [];
          setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : 'No response from TV. Check the TV before trying again.');
        }
      }
      if (mounted.current) setPending(queue.current.length);
    }
    draining.current = false;
    if (mounted.current) {
      setPending(0);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void load(), 700);
    }
  };

  const send = (action: ScreenAction, parameters: Record<string, unknown> = {}, done?: () => void) => {
    if (!selectedId || blocked) return;
    setError('');
    setNotice('');
    queue.current.push({ id: selectedId, epoch: epoch.current, action, parameters, done });
    setPending(queue.current.length + (draining.current ? 1 : 0));
    void drain();
  };
  const key = (value: RemoteKey) => send('key', { key: value });
  const chooseTv = (id: string) => {
    epoch.current += 1;
    queue.current = [];
    setPending(0);
    selectedRef.current = id;
    setSelectedId(id);
    setPanel('remote');
    setText(''); setChannel(''); setError(''); setNotice('');
  };
  const openPanel = (next: Panel) => { setPanel(next); setError(''); setNotice(''); };
  const button = (label: string, icon: string, onClick: () => void, options: { disabled?: boolean; className?: string; caption?: boolean; pressed?: boolean } = {}) => (
    <button type="button" className={`tv-button ${options.className ?? ''}`} aria-label={label} aria-pressed={options.pressed} disabled={options.disabled ?? blocked} onClick={onClick}>
      <Icon name={icon} />{options.caption && <span>{label}</span>}
    </button>
  );
  const remoteButton = (label: string, value: RemoteKey, caption = false) => supports(value) ? button(label, value, () => key(value), { caption }) : null;
  const sourceList = selected?.apps ?? [];
  const playbackLabel = selected?.playback_state === 'playing' ? 'Playing' : selected?.playback_state === 'paused' ? 'Paused' : '';
  const status = readError ? 'State unavailable' : !selected?.available ? 'Unavailable' : selected.power === false ? 'Off' : [selected.app, playbackLabel].filter(Boolean).join(' · ') || (selected.power ? 'On' : 'Power unknown');
  const playLabel = playbackLabel === 'Playing' ? 'Pause' : playbackLabel === 'Paused' ? 'Play' : 'Play / pause';
  const more = has('find_remote') || has('channel_tune') || supports('search') || supports('channel_up') || supports('enter') || supports('backspace');

  const editText = (insert: string | null) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    const before = insert === null && start === end ? [...text.slice(0, start)].slice(0, -1).join('') : text.slice(0, start);
    const value = before + (insert ?? '') + text.slice(end);
    setText(value.slice(0, 256));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(before.length + (insert?.length ?? 0), before.length + (insert?.length ?? 0));
    });
  };
  const submitText = (action: 'text' | 'search') => {
    if (!text.trim() || pending) return;
    const submitted = text;
    send(action, action === 'text' ? { text } : { query: text }, () => { setText(current => current === submitted ? '' : current); setNotice(action === 'text' ? 'Text sent' : 'Search sent'); });
  };

  if (!screens.length) return <section className="page tv-page tv-empty">
    <p>{!loaded ? 'Loading TVs…' : readError ? 'Could not load TVs' : 'No TVs in Home Assistant'}</p>
    {readError && <p role="alert" className="tv-error-detail">{readError}</p>}
    {loaded && <button className="tv-button" disabled={refreshing} onClick={() => void load()}>{refreshing ? 'Refreshing…' : 'Retry'}</button>}
  </section>;

  return <section className="page tv-page">
    <header className="tv-header">
      <div className="tv-heading">
        <select aria-label="Screen" value={selectedId} onChange={event => chooseTv(event.target.value)}>
          {screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}{screen.available ? '' : ' (unavailable)'}</option>)}
        </select>
        <div className="tv-current" title={[status, selected?.media_title].filter(Boolean).join(' · ')}>
          <span className={`tv-state-dot${selected?.available && !readError ? ' tv-state-dot--online' : ''}`} />
          <span>{status}{selected?.power !== false && selected?.media_title ? ` · ${selected.media_title}` : ''}</span>
          <span className="tv-pending" role="status">{pending ? 'Sending…' : notice}</span>
        </div>
      </div>
      {button('Refresh TVs', 'refresh', () => void load(), { disabled: refreshing, className: refreshing ? 'tv-refreshing' : '' })}
      {has('power') && button('Power', 'power', () => send(selected?.power === true ? 'turn_off' : 'turn_on'), { disabled: unavailable || pending > 0, className: selected?.power ? 'tv-power--on' : '' })}
    </header>

    {(error || readError) && <div className="tv-error" role="alert"><span>{error || readError}</span><button className="tv-button" onClick={() => { setError(''); void load(); }}>Retry</button></div>}

    {panel === 'remote' ? <div className={`tv-controls${has('remote_keys') ? '' : ' tv-controls--media-only'}`}>
      <div className="tv-shortcuts">
        {remoteButton('Home', 'home', true)}
        {remoteButton('Back', 'back', true)}
        {remoteButton('Options', 'info', true)}
        {remoteButton('Replay', 'replay', true)}
      </div>
      <div className="tv-navigation">
        {has('remote_keys') && <div className="tv-dpad" role="group" aria-label="Directional pad">
          {(['up', 'left', 'select', 'right', 'down'] as RemoteKey[]).map(value => <button key={value} className={`tv-dpad-key tv-dpad-${value}`} aria-label={value === 'select' ? 'OK' : value[0].toUpperCase() + value.slice(1)} disabled={blocked || !supports(value)} onClick={() => key(value)}>{value === 'select' ? 'OK' : <Icon name={value} />}</button>)}
        </div>}
        <div className="tv-transport" role="group" aria-label="Playback">
          {remoteButton('Rewind', 'rewind')}
          {(has('playback') || supports('play')) && button(playLabel, playbackLabel === 'Playing' ? 'pause' : playbackLabel === 'Paused' ? 'play' : 'play_pause', () => supports('play') ? key('play') : send('play_pause'), { disabled: unavailable || pending > 0, className: 'tv-play' })}
          {remoteButton('Fast forward', 'fast_forward')}
        </div>
      </div>
      <div className="tv-utilities">
        {(has('volume') || has('mute')) && <div className="tv-volume" role="group" aria-label="TV volume">
          {has('volume') && button('Volume down', 'volume_down', () => send('volume_down'))}
          {has('mute') && button(selected?.muted ? 'Unmute' : 'Mute', 'mute', () => send('mute_toggle'), { disabled: unavailable || pending > 0, pressed: selected?.muted ?? undefined })}
          {has('volume') && button('Volume up', 'volume_up', () => send('volume_up'))}
          {selected?.volume_percent != null && <span className="tv-volume-value">{selected.volume_percent}%</span>}
        </div>}
        {has('app_launch') && button('Apps & inputs', 'apps', () => openPanel('sources'), { disabled: false, caption: true, className: 'tv-utility' })}
        {has('text_input') && button('Keyboard', 'keyboard', () => openPanel('keyboard'), { disabled: false, caption: true, className: 'tv-utility' })}
        {more && button('More', 'more', () => openPanel('more'), { disabled: false, caption: true, className: 'tv-utility' })}
      </div>
    </div> : <div className={`tv-panel tv-panel--${panel}`}>
      <div className="tv-panel-heading">
        {button('Back to remote', 'left', () => openPanel('remote'), { disabled: false })}
        <h1>{panel === 'sources' ? 'Apps & inputs' : panel === 'keyboard' ? 'Keyboard' : 'More'}</h1>
        {panel === 'keyboard' && has('search') && <button className="tv-button" disabled={blocked || Boolean(pending) || !text.trim()} onClick={() => submitText('search')}>Search TV</button>}
      </div>
      {panel === 'sources' && <div className="tv-sources" aria-label="Apps and inputs">
        {sourceList.length ? sourceList.map(source => <button key={source} className={`tv-source${source === selected?.app ? ' tv-source--active' : ''}`} aria-label={`Open ${source}`} aria-pressed={source === selected?.app} disabled={unavailable || Boolean(pending)} onClick={() => send('select_source', { source }, () => { setPanel('remote'); setNotice(`Opened ${source}`); })}><span>{source}</span>{source === selected?.app && <Icon name="check" />}</button>) : <p className="tv-help">No apps or inputs reported. Refresh to try again.</p>}
      </div>}
      {panel === 'keyboard' && <>
        <form className="tv-text-form" onSubmit={event => { event.preventDefault(); submitText('text'); }}>
          <input ref={inputRef} aria-label="Text to send to TV" placeholder="Text to send to TV" value={text} maxLength={256} inputMode="none" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} onChange={event => setText(event.target.value)} />
          <button className="tv-button tv-primary" disabled={blocked || Boolean(pending) || !text.trim()}>Send text</button>
        </form>
        <div className="tv-keyboard" role="group" aria-label="On-screen keyboard">
          {(symbols ? ['1234567890', '@#$%&*-+=/', '.,!?\'":;()'] : ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']).map((row, index) => <div className="tv-key-row" key={index}>{[...row].map(char => <button key={char} className="tv-button" onPointerDown={event => event.preventDefault()} onClick={() => editText(shift ? char.toUpperCase() : char)}>{shift ? char.toUpperCase() : char}</button>)}</div>)}
          <div className="tv-key-row">
            <button className="tv-button" aria-label="Shift" aria-pressed={shift} onPointerDown={event => event.preventDefault()} onClick={() => setShift(!shift)}>Aa</button>
            <button className="tv-button" aria-label={symbols ? 'Letters' : 'Numbers and symbols'} aria-pressed={symbols} onPointerDown={event => event.preventDefault()} onClick={() => setSymbols(!symbols)}>{symbols ? 'ABC' : '123'}</button>
            <button className="tv-button tv-space" onPointerDown={event => event.preventDefault()} onClick={() => editText(' ')}>Space</button>
            <button className="tv-button" aria-label="Backspace" onPointerDown={event => event.preventDefault()} onClick={() => editText(null)}>⌫</button>
          </div>
        </div>
      </>}
      {panel === 'more' && <div className="tv-more-grid">
        {has('find_remote') && <button className="tv-button" disabled={blocked || Boolean(pending)} onClick={() => send('find_remote', {}, () => setNotice('Remote finder started'))}>Find remote</button>}
        {supports('search') && <button className="tv-button" disabled={blocked} onClick={() => key('search')}>Open TV search</button>}
        {supports('enter') && <button className="tv-button" disabled={blocked} onClick={() => key('enter')}>Enter on TV</button>}
        {supports('backspace') && <button className="tv-button" disabled={blocked} onClick={() => key('backspace')}>Backspace on TV</button>}
        {supports('channel_down') && <button className="tv-button" disabled={blocked} onClick={() => key('channel_down')}>Channel −</button>}
        {supports('channel_up') && <button className="tv-button" disabled={blocked} onClick={() => key('channel_up')}>Channel +</button>}
        {has('channel_tune') && <form className="tv-channel" onSubmit={event => { event.preventDefault(); if (channel.trim()) send('channel', { channel: channel.trim() }); }}>
          <input aria-label="TV channel" placeholder="Channel, e.g. 5.1" value={channel} inputMode="decimal" maxLength={12} onChange={event => setChannel(event.target.value)} />
          <button className="tv-button" disabled={blocked || Boolean(pending) || !channel.trim()}>Tune channel</button>
          <div className="tv-channel-keys">{['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(char => <button type="button" className="tv-button" key={char} onClick={() => setChannel(value => char === '⌫' ? value.slice(0, -1) : (value + char).slice(0,12))}>{char}</button>)}</div>
        </form>}
      </div>}
    </div>}
  </section>;
}
