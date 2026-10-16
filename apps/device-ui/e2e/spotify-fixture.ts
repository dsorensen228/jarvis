import { type Page, type Route } from '@playwright/test';

// These tests never connect to Spotify or a household device. The fake SDK behaves
// asynchronously so React StrictMode teardown and late callbacks get exercised.
export const item = (name = 'Night Drive', kind = 'track') => ({
  uri: `spotify:${kind}:${name.replace(/[^a-zA-Z0-9]/g, '')}`,
  name,
  subtitle: 'The Midnight',
  kind,
  image: '/test-cover.svg',
});

export async function setupSpotify(page: Page, options: { ready?: boolean; empty?: boolean; delayed?: boolean; scriptFailure?: boolean } = {}) {
  const requests: { path: string; method: string; body: any }[] = [];
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/test-cover.svg', (route) => route.fulfill({ contentType: 'image/svg+xml', body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#311f46"/><circle cx="200" cy="170" r="110" fill="#be5bf0"/><path d="M0 300L190 190L400 320V400H0Z" fill="#16253c"/></svg>' }));
  await page.routeWebSocket('**/api/events', (socket) => {
    socket.send(JSON.stringify({ type: 'voice.state', data: { active: false, phase: 'idle', connected: true } }));
  });
  let connected = options.ready !== false;
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    requests.push({ path, method: request.method(), body });
    if (path === '/api/config') return route.fulfill({ json: { device_id: 'test-kiosk', spotify_player_name: 'Office', spotify_client_id: 'test-client', spotify_ready: connected, spotify_missing: connected ? [] : ['spotify_refresh_token'], music_tab_enabled: true, voice_ui: true, coding_tasks_enabled: false } });
    if (path === '/api/spotify/player-access-token') return route.fulfill({ json: { access_token: 'test-token', expires_in: 3600 } });
    if (path === '/api/spotify/disconnect') { connected = false; return route.fulfill({ json: { ok: true } }); }
    if (path === '/api/spotify/search') {
      const q = new URL(request.url()).searchParams.get('q') || 'Night Drive';
      const types = new URL(request.url()).searchParams.get('types') || 'track';
      return route.fulfill({ json: { items: [item(q, types.split(',')[0])] } });
    }
    if (path === '/api/spotify/player/queue' && request.method() === 'GET') return route.fulfill({ json: { active: true, currently_playing: item(), items: [item('Next Song'), item('Last Song')] } });
    if (path.startsWith('/api/spotify/player/')) return route.fulfill({ json: { ok: true } });
    if (path === '/api/system/volume') return route.fulfill({ json: { percent: 55, muted: true } });
    if (path === '/api/banter') return route.fulfill({ json: { paired: false, available: false, busy: false, status: 'unpaired', source_device_id: null } });
    if (path === '/api/lights/room-state') return route.fulfill({ json: { room_bound: false, is_on: null, count: 0 } });
    return route.fulfill({ json: { items: [], timers: [], alarms: [] } });
  });
  await page.addInitScript(({ empty, delayed, scriptFailure }) => {
    const w = window as any;
    w.__sdkCalls = [];
    w.__players = [];
    w.__delayReady = delayed;
    w.__state = empty ? null : {
      paused: false, position: 45_000, duration: 240_000, shuffle: false, repeat_mode: 0, disallows: {},
      track_window: {
        current_track: { uri: 'spotify:track:NightDrive', name: 'Night Drive', duration_ms: 240_000, artists: [{ name: 'The Midnight' }], album: { name: 'After Hours', images: [{ url: '/test-cover.svg' }] } },
        next_tracks: [], previous_tracks: [],
      },
    };
    class Player {
      listeners = new Map<string, Set<(value: any) => void>>();
      disconnected = false;
      constructor(public options: any) { w.__players.push(this); }
      addListener(name: string, callback: (value: any) => void) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name)!.add(callback);
        return true;
      }
      removeListener(name: string, callback?: (value: any) => void) { if (callback) this.listeners.get(name)?.delete(callback); else this.listeners.delete(name); return true; }
      emit(name: string, value: any) { this.listeners.get(name)?.forEach(cb => cb(value)); }
      connect() {
        this.disconnected = false;
        this.options.getOAuthToken((token: string) => {
          if (!token || w.__delayReady) return;
          setTimeout(() => { if (!this.disconnected) { this.emit('ready', { device_id: 'office-sdk-id' }); this.emit('player_state_changed', w.__state); } }, 10);
        });
        return Promise.resolve(true);
      }
      disconnect() { this.disconnected = true; w.__sdkCalls.push('disconnect'); }
      getCurrentState() { return Promise.resolve(w.__state); }
      setVolume() { return Promise.resolve(); }
      activateElement() { w.__sdkCalls.push('activate'); return Promise.resolve(); }
      togglePlay() { w.__sdkCalls.push('toggle'); if (w.__state) w.__state = { ...w.__state, paused: !w.__state.paused }; this.emit('player_state_changed', w.__state); return Promise.resolve(); }
      nextTrack() { w.__sdkCalls.push('next'); return Promise.resolve(); }
      previousTrack() { w.__sdkCalls.push('prev'); return Promise.resolve(); }
      seek(position: number) { w.__sdkCalls.push(['seek', position]); w.__state = { ...w.__state, position }; this.emit('player_state_changed', w.__state); return Promise.resolve(); }
    }
    w.__SpotifyPlayer = Player;
    if (!scriptFailure) w.Spotify = { Player };
    w.__emitSpotify = (name: string, state: any) => {
      if (name === 'player_state_changed') w.__state = state;
      w.__players.filter((p: Player) => !p.disconnected).forEach((p: Player) => p.emit(name, state));
    };
  }, { empty: options.empty, delayed: options.delayed, scriptFailure: options.scriptFailure });
  return requests;
}
