export interface UiConfig {
  device_id: string;
  api_http_base: string;
  spotify_client_id: string | null;
  spotify_player_name: string;
  /** Web Playback SDK gain 0–1; fixed from device config. */
  spotify_web_playback_volume?: number;
  voice_ui?: boolean;
  spotify_can_connect?: boolean;
  spotify_connected?: boolean;
  /** True when client id and the device-owned refresh token are both present. */
  spotify_ready?: boolean;
  spotify_missing?: string[];
  /** The room this device sits in; the API resolves its lights and screen. */
  room_name?: string | null;
  coding_tasks_enabled?: boolean;
  /** When false/absent, the Music bottom-nav tab is hidden. */
  music_tab_enabled?: boolean;
}

export type CodeTaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'success'
  | 'failed';

export type FactoryMode = 'code' | 'research';
export type ResearchVerbosity = 'concise' | 'standard' | 'in_depth';

export interface CodeTask {
  id: string;
  prompt: string;
  model?: string | null;
  repository?: string;
  status: CodeTaskStatus;
  workflow_id: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  exit_code?: number | null;
  agent_output?: unknown;
  stdout?: string | null;
  stderr?: string | null;
  error?: string | null;
  changed_paths?: string[];
  self_update_scheduled?: boolean;
  parent_task_id?: string | null;
  output_seq?: number;
  task_type?: FactoryMode;
  verbosity?: ResearchVerbosity;
  report_available?: boolean;
}
export type CodeTaskView = 'all' | 'active' | 'history';
export interface CodeTaskPage { items: CodeTask[]; next_cursor: string | null; }
export interface CodeTaskOutput {
  seq: number;
  kind: 'assistant' | 'command' | 'tool' | 'error' | 'status';
  text: string;
  created_at: string;
}
export interface CodeTaskOutputPage {
  items: CodeTaskOutput[];
  next_after: number;
  has_more: boolean;
  truncated: boolean;
  task: CodeTask;
}


export interface CameraRow {
  id: string;
  device_name: string;
  device_type: string;
}

const JSON_HDR = { Accept: 'application/json' };

export async function fetchConfig(): Promise<UiConfig> {
  const r = await fetch('/api/config', { headers: JSON_HDR });
  if (!r.ok) throw new Error(`config ${r.status}`);
  return r.json() as Promise<UiConfig>;
}

export interface SystemVolumeState {
  percent: number;
  muted: boolean;
}

export interface RoomLightsState {
  room_bound: boolean;
  is_on: boolean | null;
  count: number;
}

export async function fetchSystemVolume(): Promise<SystemVolumeState> {
  const r = await fetch('/api/system/volume', { headers: JSON_HDR });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `volume ${r.status}`);
  }
  return r.json() as Promise<SystemVolumeState>;
}

export async function postSystemVolume(body: {
  percent?: number;
  muted?: boolean;
  delta_percent?: number;
}): Promise<SystemVolumeState> {
  const r = await fetch('/api/system/volume', {
    method: 'POST',
    headers: { ...JSON_HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `volume ${r.status}`);
  }
  return r.json() as Promise<SystemVolumeState>;
}

export async function postVoiceTap(): Promise<void> {
  const r = await fetch('/api/voice/tap', {
    method: 'POST',
    headers: JSON_HDR,
  });
  if (!r.ok) throw new Error(`voice tap ${r.status}`);
}

export interface VoiceInteractionsMuteState {
  ok: boolean;
  active: boolean;
  phase: string;
  connected: boolean;
  interactions_muted: boolean;
}

export async function postInteractionsMute(muted: boolean): Promise<VoiceInteractionsMuteState> {
  const r = await fetch('/api/voice/interactions-mute', {
    method: 'POST',
    headers: { ...JSON_HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `interactions mute ${r.status}`);
  }
  return r.json() as Promise<VoiceInteractionsMuteState>;
}

export interface BanterState {
  paired: boolean;
  available: boolean;
  busy: boolean;
  status: 'unpaired' | 'offline' | 'not_idle' | 'ready' | 'queued' | 'running' | 'completed' | 'failed';
  source_device_id: string | null;
}

async function banterResponse(response: Response): Promise<BanterState> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(payload.detail || "Couldn't reach Sherman");
  }
  return response.json() as Promise<BanterState>;
}

export async function fetchBanterState(): Promise<BanterState> {
  return banterResponse(await fetch('/api/banter', { headers: JSON_HDR }));
}

export async function postBanterTrigger(): Promise<BanterState> {
  return banterResponse(
    await fetch('/api/banter/trigger', { method: 'POST', headers: JSON_HDR })
  );
}

export async function fetchRoomLightsState(): Promise<RoomLightsState> {
  const r = await fetch('/api/lights/room-state', { headers: JSON_HDR });
  if (!r.ok) throw new Error(`room-state ${r.status}`);
  return r.json() as Promise<RoomLightsState>;
}

export async function postRoomLightsToggle(): Promise<{ status: string; action: string }> {
  const r = await fetch('/api/lights/room-toggle', { method: 'POST', headers: JSON_HDR });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail || `room-toggle ${r.status}`);
  }
  return r.json() as Promise<{ status: string; action: string }>;
}

async function codeTaskResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      detail?: string;
      error?: string;
    };
    throw new Error(payload.detail || payload.error || `Task request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function fetchCodeTasks(view: CodeTaskView = 'all', cursor?: string | null, limit = 30): Promise<CodeTaskPage> {
  const params = new URLSearchParams({ limit: String(limit), view });
  if (cursor) params.set('cursor', cursor);
  return codeTaskResponse(await fetch(`/api/code-tasks?${params}`, { headers: JSON_HDR }));
}

export async function fetchCodeTaskOutput(id: string, after = 0): Promise<CodeTaskOutputPage> {
  return codeTaskResponse(await fetch(`/api/code-tasks/${encodeURIComponent(id)}/output?after=${after}&limit=100`, { headers: JSON_HDR }));
}

export async function followUpCodeTask(id: string, prompt: string): Promise<CodeTask> {
  return codeTaskResponse(await fetch(`/api/code-tasks/${encodeURIComponent(id)}/follow-up`, {
    method: 'POST', headers: { ...JSON_HDR, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
  }));
}

export async function streamCodeTaskOutput(id: string, after: number, signal: AbortSignal, onPage: (page: CodeTaskOutputPage) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const events = new EventSource(`/api/code-tasks/${encodeURIComponent(id)}/events?after=${after}`);
    const close = () => { events.close(); signal.removeEventListener('abort', close); resolve(); };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) { close(); return; }
    events.addEventListener('output', (event) => {
      try { onPage(JSON.parse((event as MessageEvent).data) as CodeTaskOutputPage); }
      catch { events.close(); reject(new Error('Could not read live output')); }
    });
    events.onerror = () => { events.close(); signal.removeEventListener('abort', close); reject(new Error('Live connection unavailable')); };
  });
}

export async function fetchCodeTask(taskId: string): Promise<CodeTask> {
  return codeTaskResponse<CodeTask>(
    await fetch(`/api/code-tasks/${encodeURIComponent(taskId)}`, { headers: JSON_HDR })
  );
}

export async function cancelCodeTask(taskId: string): Promise<CodeTask> {
  return codeTaskResponse<CodeTask>(
    await fetch(`/api/code-tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      headers: JSON_HDR,
    })
  );
}

export async function startCodeTaskRecording(): Promise<void> {
  await codeTaskResponse<{ recording: boolean }>(
    await fetch('/api/code-tasks/recording/start', { method: 'POST', headers: JSON_HDR })
  );
}

/** Transcribes the recording; the task is created only after the transcript is confirmed. */
export async function stopCodeTaskRecording(): Promise<{ transcript: string }> {
  return codeTaskResponse<{ transcript: string }>(
    await fetch('/api/code-tasks/recording/stop', {
      method: 'POST',
      headers: JSON_HDR,
    })
  );
}

export type CodeTaskModel = 'gpt-5.6-terra' | 'gpt-6-sol' | 'gpt-6-astra';

export async function createCodeTask(prompt: string, model: CodeTaskModel): Promise<CodeTask> {
  return codeTaskResponse<CodeTask>(
    await fetch('/api/code-tasks', {
      method: 'POST',
      headers: { ...JSON_HDR, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model }),
    })
  );
}

export async function fetchResearchTasks(view: CodeTaskView = 'all', cursor?: string | null, limit = 30): Promise<CodeTaskPage> {
  const params = new URLSearchParams({ limit: String(limit), view });
  if (cursor) params.set('cursor', cursor);
  return codeTaskResponse(await fetch(`/api/research-tasks?${params}`, { headers: JSON_HDR }));
}

export async function fetchResearchTask(id: string): Promise<CodeTask> {
  return codeTaskResponse(await fetch(`/api/research-tasks/${encodeURIComponent(id)}`, { headers: JSON_HDR }));
}

export async function fetchResearchTaskOutput(id: string, after = 0): Promise<CodeTaskOutputPage> {
  return codeTaskResponse(await fetch(`/api/research-tasks/${encodeURIComponent(id)}/output?after=${after}&limit=100`, { headers: JSON_HDR }));
}

export async function createResearchTask(prompt: string, model: CodeTaskModel, verbosity: ResearchVerbosity): Promise<CodeTask> {
  return codeTaskResponse(await fetch('/api/research-tasks', {
    method: 'POST', headers: { ...JSON_HDR, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, model, verbosity }),
  }));
}

export async function cancelResearchTask(id: string): Promise<CodeTask> {
  return codeTaskResponse(await fetch(`/api/research-tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: JSON_HDR }));
}

export async function startResearchTaskRecording(): Promise<void> {
  await codeTaskResponse(await fetch('/api/research-tasks/recording/start', { method: 'POST', headers: JSON_HDR }));
}

export async function stopResearchTaskRecording(): Promise<{ transcript: string }> {
  return codeTaskResponse(await fetch('/api/research-tasks/recording/stop', { method: 'POST', headers: JSON_HDR }));
}

export async function fetchResearchReport(id: string, signal?: AbortSignal): Promise<{ task_id: string; html: string }> {
  return codeTaskResponse(await fetch(`/api/research-tasks/${encodeURIComponent(id)}/report`, { headers: JSON_HDR, cache: 'no-store', signal }));
}

/** PKCE code exchange on the Jarvis device; persists refresh token server-side. */
export async function postSpotifyOAuthExchange(body: {
  code: string;
  redirect_uri: string;
  code_verifier: string;
}): Promise<{ access_token: string; expires_in: number }> {
  const r = await fetch('/api/spotify/oauth/exchange', {
    method: 'POST',
    headers: { ...JSON_HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = `oauth exchange ${r.status}`;
    try {
      const j = (await r.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<{ access_token: string; expires_in: number }>;
}

/** Access token for Web Playback SDK; server refreshes against Spotify as needed. */
export async function fetchSpotifyPlayerAccessToken(refresh = false): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const r = await fetch(`/api/spotify/player-access-token${refresh ? '?refresh=true' : ''}`, {
    headers: JSON_HDR,
  });
  if (!r.ok) {
    let detail = `player token ${r.status}`;
    try {
      const j = (await r.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<{ access_token: string; expires_in: number }>;
}

/** Remove file-based refresh token on the device (sign out). */
export async function postSpotifyDisconnect(): Promise<void> {
  const r = await fetch('/api/spotify/disconnect', {
    method: 'POST',
    headers: JSON_HDR,
  });
  if (!r.ok) {
    let detail = `disconnect ${r.status}`;
    try {
      const j = (await r.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
}

export interface SpotifySearchItem {
  uri: string;
  name: string;
  subtitle: string;
  image: string | null;
  kind: string;
}

export async function fetchSpotifySearch(
  q: string,
  opts?: { types?: string; limit?: number; signal?: AbortSignal }
): Promise<SpotifySearchItem[]> {
  const params = new URLSearchParams();
  params.set('q', q);
  if (opts?.types) params.set('types', opts.types);
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  const r = await fetch(`/api/spotify/search?${params.toString()}`, {
    headers: JSON_HDR,
    signal: opts?.signal,
  });
  if (!r.ok) {
    let detail = `search ${r.status}`;
    try {
      const j = (await r.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const j = (await r.json()) as { items?: SpotifySearchItem[] };
  return Array.isArray(j.items) ? j.items : [];
}

export async function postSpotifyPlay(body: {
  spotify_uri?: string;
  track_uris?: string[];
  device_name?: string;
  device_id?: string;
}): Promise<void> {
  const r = await fetch('/api/spotify/player/play', {
    method: 'POST',
    headers: { ...JSON_HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = `play ${r.status}`;
    try {
      const j = (await r.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
}

export type SpotifyRepeatMode = 'off' | 'context' | 'track';

export interface SpotifyQueue {
  items: SpotifySearchItem[];
  currently_playing: SpotifySearchItem | null;
  active: boolean;
}

export async function fetchSpotifyQueue(
  deviceId: string,
  signal?: AbortSignal
): Promise<SpotifyQueue> {
  const params = new URLSearchParams({ device_id: deviceId });
  const response = await fetch(`/api/spotify/player/queue?${params}`, {
    headers: JSON_HDR,
    signal,
  });
  return spotifyResponse<SpotifyQueue>(response);
}

export async function postSpotifyQueue(uri: string, deviceId: string): Promise<void> {
  const response = await fetch('/api/spotify/player/queue', {
    method: 'POST',
    headers: { ...JSON_HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri, device_id: deviceId }),
  });
  await spotifyResponse(response);
}

export async function postSpotifyOptions(body: {
  device_id: string;
  shuffle?: boolean;
  repeat?: SpotifyRepeatMode;
}): Promise<void> {
  const response = await fetch('/api/spotify/player/options', {
    method: 'POST',
    headers: { ...JSON_HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await spotifyResponse(response);
}

async function spotifyResponse<T = { ok: boolean }>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `Spotify request failed (${response.status}). Please try again.`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch { /* Keep the useful status when the server returns no JSON. */ }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchCameras(): Promise<CameraRow[]> {
  const r = await fetch('/api/cameras', { headers: JSON_HDR });
  if (!r.ok) throw new Error(`cameras ${r.status}`);
  return r.json() as Promise<CameraRow[]>;
}

export function cameraSnapshotUrl(deviceId: string, nonce: number): string {
  return `/api/cameras/${encodeURIComponent(deviceId)}/snapshot?t=${nonce}`;
}

/** A device with a screen, as the Pi reports it. */
export interface ScreenRow {
  id: string;
  name: string;
  room: string;
  model: string;
  available: boolean;
  /** `null` means unknown, never off. */
  power: boolean | null;
  /** Whatever the screen is currently showing, when it reports one. */
  app: string;
  /** Volume mute from the media player, when reported. */
  muted: boolean | null;
  apps: string[];
  app_id: string;
  media_title: string;
  media_channel: string;
  playback_state: string;
  volume_percent: number | null;
  supported_keys?: RemoteKey[];
  capabilities: string[];
  /** True for the screen this room's requests go to. */
  is_room_default: boolean;
}

/** A neutral remote key. The API rejects anything outside this set. */
export type RemoteKey =
  | 'home'
  | 'back'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'select'
  | 'rewind'
  | 'fast_forward'
  | 'replay'
  | 'info'
  | 'channel_up'
  | 'channel_down'
  | 'enter'
  | 'backspace'
  | 'search'
  | 'find_remote'
  | 'input_av1'
  | 'input_hdmi1'
  | 'input_hdmi2'
  | 'input_hdmi3'
  | 'input_hdmi4'
  | 'input_tuner'
  | 'play'
  | 'power'
  | 'volume_up'
  | 'volume_down'
  | 'volume_mute';

export type ScreenAction =
  | 'turn_on'
  | 'turn_off'
  | 'play'
  | 'pause'
  | 'play_pause'
  | 'mute'
  | 'unmute'
  | 'volume_up'
  | 'volume_down'
  | 'launch_app'
  | 'select_source'
  | 'text'
  | 'search'
  | 'channel'
  | 'find_remote'
  | 'mute_toggle'
  | 'key';

export async function fetchScreens(signal?: AbortSignal): Promise<ScreenRow[]> {
  const r = await fetch('/api/screens', { headers: JSON_HDR, signal });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail || `screens ${r.status}`);
  }
  return r.json() as Promise<ScreenRow[]>;
}

export async function screenCommand(
  deviceId: string,
  action: ScreenAction,
  parameters: Record<string, unknown> = {}
): Promise<void> {
  const r = await fetch(`/api/screens/${encodeURIComponent(deviceId)}/commands`, {
    method: 'POST',
    headers: { ...JSON_HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, parameters }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail || `${action} ${r.status}`);
  }
}

export function pressScreenKey(deviceId: string, key: RemoteKey): Promise<void> {
  return screenCommand(deviceId, 'key', { key });
}

export function sendScreenAction(
  deviceId: string,
  action: Exclude<ScreenAction, 'key' | 'launch_app'>
): Promise<void> {
  return screenCommand(deviceId, action);
}

export function launchScreenApp(deviceId: string, appName: string): Promise<void> {
  return screenCommand(deviceId, 'launch_app', { app: appName });
}
