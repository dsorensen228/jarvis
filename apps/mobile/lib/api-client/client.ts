import type {
  Conversation,
  Message,
  MessageAttachmentRef,
  MeSettingsUpdate,
  GmailAlert,
  LightControlBody,
  LightControlResult,
  Todo,
  TodoCreate,
  TodoUpdate,
  ShoppingList,
  ShoppingListCreate,
  ShoppingListUpdate,
  Timer,
  TimerCreate,
  TimerAction,
  User,
  RemoteKey,
  Room,
  RoomLights,
  SmartDevice,
  SmartDeviceUpdate,
  SmartHomeCommandBody,
  SmartHomeCommandResult,
  SmartHomeStatus,
  JarvisDevice,
  JarvisDeviceType,
  UserDirectoryEntry,
  JarvisProject,
  JarvisProjectCreate,
  JarvisProjectNode,
  ChatPostResponse,
  RegisterPushTokenRequest,
  DeletePushTokenRequest,
  JarvisCatalogModel,
  JarvisCatalogModelCreate,
  JarvisModelEcosystem,
  CameraStreamSession,
  CodeTask,
  CodeTaskCreate,
} from './types';

import { getApiBaseUrl, ngrokSkipBrowserWarningHeaders } from '../runtimePublicEnv';

export { getApiBaseUrl };
const DEFAULT_FETCH_TIMEOUT_MS = 30000;
const API_PREFIX = '/v1';
/** POST /chat can run long (LangGraph); avoid AbortError on slow turns. */
export const CHAT_POST_TIMEOUT_MS = 600_000;

function sameApiOrigin(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(getApiBaseUrl()).origin;
  } catch {
    return false;
  }
}

let tokenProvider: (() => string | null) | null = null;
let onAuthFailure: ((message: string) => void) | null = null;
let tokenRefresher: (() => Promise<string | null>) | null = null;

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let nextInit: RequestInit | undefined = init;
    if (sameApiOrigin(url)) {
      const extra = ngrokSkipBrowserWarningHeaders();
      if (Object.keys(extra).length > 0) {
        const h = new Headers(init?.headers ?? undefined);
        for (const [k, v] of Object.entries(extra)) {
          h.set(k, v);
        }
        nextInit = { ...init, headers: h };
      }
    }
    return await fetch(url, { ...nextInit, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Set the function that provides the current auth token.
 * Call this from the app (e.g. AuthContext) so API requests include Authorization: Bearer.
 */
export function setTokenProvider(provider: (() => string | null) | null): void {
  tokenProvider = provider;
}

/**
 * Set callback for 401/403 responses. Called before the error is thrown.
 * Use to sign out and redirect to login with the error message.
 */
export function setOnAuthFailure(callback: ((message: string) => void) | null): void {
  onAuthFailure = callback;
}

/**
 * Register a function that refreshes the session and returns a new access token.
 * Used to retry API requests once after 401 before invoking onAuthFailure.
 */
export function setTokenRefresher(refresher: (() => Promise<string | null>) | null): void {
  tokenRefresher = refresher;
}

/** Get the current token from the provider (for WebSocket auth). */
export function getToken(): string | null {
  return tokenProvider?.() ?? null;
}

async function fetchApi<T>(
  path: string,
  options?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<T> {
  const buildHeaders = (authToken: string | null): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string>),
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    return headers;
  };

  let token = tokenProvider?.() ?? null;
  let res = await fetchWithTimeout(
    `${getApiBaseUrl()}${API_PREFIX}${path}`,
    {
      ...options,
      headers: buildHeaders(token),
    },
    timeoutMs
  );

  if ((res.status === 401 || res.status === 403) && tokenRefresher) {
    const newToken = await tokenRefresher();
    if (newToken) {
      res = await fetchWithTimeout(
        `${getApiBaseUrl()}${API_PREFIX}${path}`,
        {
          ...options,
          headers: buildHeaders(newToken),
        },
        timeoutMs
      );
    }
  }

  if (!res.ok) {
    const text = await res.text();
    const isAuthError = res.status === 401 || res.status === 403;
    let message = text || res.statusText;
    if (isAuthError && text) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.detail === 'string') message = parsed.detail;
      } catch {
        // use raw text
      }
    }
    if (isAuthError && onAuthFailure) {
      onAuthFailure(message);
    }
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function normalizeUser(user: User & Record<string, unknown>): User {
  const settings =
    user.settings && typeof user.settings === 'object'
      ? (user.settings as Record<string, unknown>)
      : {};
  return {
    ...user,
    ...settings,
    email: String(user.email || user.username || ''),
  };
}

function normalizeConversation(row: Record<string, any>): Conversation {
  return {
    ...row,
    user_id: String(row.user_id || row.owner_id || ''),
    active_project_id: row.project_id == null ? null : String(row.project_id),
    messages: Array.isArray(row.messages)
      ? row.messages.map((message: Record<string, any>) => ({
          ...message,
          additional_info: message.metadata?.additional_info,
          source_agent: message.metadata?.source_agent,
          attachments: message.metadata?.attachments,
          sources: message.metadata?.sources,
        }))
      : undefined,
  } as Conversation;
}

function normalizeProject(row: Record<string, any>): JarvisProject {
  return {
    ...row,
    description_md: String(row.description || ''),
    status_md: String(row.status || ''),
  } as JarvisProject;
}

function addressFromBaseUrl(baseUrl: unknown): { address: string; callbackPort: number | null } {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw) return { address: '', callbackPort: null };
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return {
      address: parsed.hostname,
      callbackPort: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
    };
  } catch {
    return { address: raw, callbackPort: null };
  }
}

function callbackBaseUrl(address: string, port?: number | null): string | null {
  const clean = address.trim();
  if (!clean) return null;
  if (clean.includes('://')) return clean.replace(/\/$/, '');
  return `http://${clean}${port ? `:${port}` : ''}`;
}

function normalizeDevice(row: Record<string, any>): JarvisDevice {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const callback = addressFromBaseUrl(row.base_url);
  return {
    id: String(row.id),
    device_name: String(row.name || 'Jarvis device'),
    address: callback.address,
    callback_port: callback.callbackPort,
    user_id: String(row.user_id || ''),
    most_recent_conversation: metadata.most_recent_conversation ?? null,
    room: row.room ? String(row.room) : null,
    device_type: row.kind === 'camera' ? 'camera' : 'voice_interface',
    acting_user_id: metadata.acting_user_id ?? null,
    doorbell_alerts_enabled: Boolean(metadata.doorbell_alerts_enabled),
    describe_scene_prompt: metadata.describe_scene_prompt ?? null,
    is_main_describe_camera: Boolean(metadata.is_main_describe_camera),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
  };
}

export async function updateMeSettings(settings: MeSettingsUpdate): Promise<{ status: string }> {
  await fetchApi('/users/me', {
    method: 'PATCH',
    body: JSON.stringify({ settings }),
  });
  return { status: 'ok' };
}

export async function getMe(tokenOverride?: string | null): Promise<User> {
  if (tokenOverride !== undefined && tokenOverride !== null) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenOverride}`,
    };
    const res = await fetchWithTimeout(`${getApiBaseUrl()}${API_PREFIX}/users/me`, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }
    const user = normalizeUser(await res.json());
    const integrations = (await fetchWithTimeout(
      `${getApiBaseUrl()}${API_PREFIX}/integrations`,
      { headers }
    ).then((response) => (response.ok ? response.json() : {}))) as Record<
      string,
      { connected?: boolean }
    >;
    return {
      ...user,
      gmail_enabled: Boolean(integrations.gmail?.connected),
      smart_home_connected: Boolean(integrations.home_assistant?.connected),
    };
  }
  const [raw, integrations] = await Promise.all([
    fetchApi<User & Record<string, unknown>>('/users/me'),
    fetchApi<Record<string, { connected?: boolean }>>('/integrations').catch(
      () => ({} as Record<string, { connected?: boolean }>))
    ,
  ]);
  return {
    ...normalizeUser(raw),
    gmail_enabled: Boolean(integrations.gmail?.connected),
    smart_home_connected: Boolean(integrations.home_assistant?.connected),
  };
}

export async function getJarvisModels(ecosystem?: string): Promise<JarvisCatalogModel[]> {
  if (ecosystem && ecosystem !== 'Qwen') return [];
  return [
    {
      id: 'qwen3-30b-a3b-instruct-2507',
      user_id: 'local',
      ecosystem: 'Qwen' as JarvisModelEcosystem,
      model_id: 'qwen3-30b-a3b-instruct-2507',
      display_name: 'Qwen3 30B A3B Instruct 2507',
      description: 'The single local Jarvis model running on the Jetson.',
      focused_on: 'Local agent reasoning and tool use',
      good_at: ['tool use', 'reasoning', 'privacy'],
      bad_at: [],
      intended_for: ['Jarvis'],
      latency_tier: 'low',
      reasoning_tier: 'standard',
      default_reasoning_effort: null,
      supports_vision: false,
      supports_tools: true,
      max_output_tokens_hint: null,
      cost_tier: 'low',
      input_cost_usd_per_mtok: 0,
      output_cost_usd_per_mtok: 0,
      cost_notes: 'Runs locally',
      enabled: true,
      sort_order: 0,
      created_at: null,
      updated_at: null,
    },
  ];
}

export async function createJarvisModel(body: JarvisCatalogModelCreate): Promise<JarvisCatalogModel> {
  void body;
  throw new Error('Jarvis uses one locally configured model. The mobile app cannot add models.');
}

export async function updateJarvisModel(
  id: string,
  body: Partial<JarvisCatalogModelCreate>
): Promise<JarvisCatalogModel> {
  void id;
  void body;
  throw new Error('The local Jarvis model is configured on the Jetson.');
}

export async function deleteJarvisModel(id: string): Promise<{ status: string }> {
  void id;
  throw new Error('The local Jarvis model cannot be deleted from the mobile app.');
}

export async function getGmailConnect(): Promise<{ auth_url: string }> {
  const response = await fetchApi<{ authorization_url: string }>('/integrations/gmail/connect', {
    method: 'POST',
  });
  return { auth_url: response.authorization_url };
}

export async function getGmailDigest(): Promise<{ summary: string }> {
  const messages = await fetchApi<Array<Record<string, unknown>>>(
    '/integrations/gmail/messages?q=newer_than%3A1d&limit=20'
  );
  const summary = messages
    .map((message) => {
      const subject = String(message.subject || '(No subject)');
      const from = String(message.from || 'Unknown sender');
      const snippet = String(message.snippet || '');
      return `• ${subject} — ${from}${snippet ? `\n  ${snippet}` : ''}`;
    })
    .join('\n\n');
  return { summary };
}

export async function getGmailAlerts(dismissed?: boolean): Promise<GmailAlert[]> {
  if (dismissed) return [];
  const messages = await fetchApi<Array<Record<string, unknown>>>(
    '/integrations/gmail/alerts'
  );
  return messages.map((message) => ({
    id: String(message.id || ''),
    conversation_id: '',
    message_id: String(message.id || ''),
    subject: String(message.subject || ''),
    snippet: String(message.snippet || ''),
    reason: String(message.from || 'Unread'),
    created_at: String(message.date || new Date().toISOString()),
    dismissed: false,
  }));
}

export async function dismissGmailAlert(id: string): Promise<void> {
  await fetchApi(`/integrations/gmail/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function searchGmailEmails(query: string): Promise<{ results: string }> {
  const rows = await fetchApi<Array<Record<string, unknown>>>(
    `/integrations/gmail/messages?q=${encodeURIComponent(query)}&limit=20`
  );
  return { results: JSON.stringify(rows) };
}

export async function getSmartHomeStatus(): Promise<SmartHomeStatus> {
  return fetchApi('/smart-home');
}

/** Import or refresh every device Home Assistant provides. */
export async function syncSmartHome(): Promise<SmartDevice[]> {
  return fetchApi('/smart-home/sync', { method: 'POST' });
}

export async function getSmartDevices(): Promise<SmartDevice[]> {
  return fetchApi('/smart-devices');
}

export async function getSmartDeviceState(id: string): Promise<SmartDevice> {
  return fetchApi(`/smart-devices/${encodeURIComponent(id)}/state`);
}

export async function updateSmartDevice(
  id: string,
  body: SmartDeviceUpdate
): Promise<SmartDevice> {
  return fetchApi(`/smart-devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteSmartDevice(id: string): Promise<void> {
  await fetchApi(`/smart-devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function commandSmartDevice(
  id: string,
  body: SmartHomeCommandBody
): Promise<SmartHomeCommandResult> {
  return fetchApi(`/smart-devices/${encodeURIComponent(id)}/commands`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Power one component of a device, or the device itself when no component is named. */
export async function setSmartDevicePower(
  id: string,
  on: boolean,
  component?: string
): Promise<SmartHomeCommandResult> {
  return commandSmartDevice(id, {
    action: on ? 'turn_on' : 'turn_off',
    ...(component ? { component } : {}),
  });
}

export async function pressRemoteKey(id: string, key: RemoteKey): Promise<SmartHomeCommandResult> {
  return commandSmartDevice(id, { action: 'key', parameters: { key } });
}

export async function launchApp(
  id: string,
  app: { name?: string; id?: string }
): Promise<SmartHomeCommandResult> {
  return commandSmartDevice(id, {
    action: 'launch_app',
    parameters: app.id ? { app_id: app.id } : { app: app.name || '' },
  });
}

export async function controlSmartLights(body: LightControlBody): Promise<LightControlResult> {
  return fetchApi('/smart-devices/control', {
    method: 'POST',
    body: JSON.stringify({ selector: '', parameters: {}, ...body }),
  });
}

export async function getRooms(): Promise<Room[]> {
  return fetchApi('/rooms');
}

export async function createRoom(name: string): Promise<Room> {
  return fetchApi('/rooms', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
}

export async function renameRoom(name: string, newName: string): Promise<Room> {
  return fetchApi(`/rooms/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: newName.trim() }),
  });
}

export async function deleteRoom(name: string): Promise<void> {
  await fetchApi(`/rooms/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function getRoomLights(name: string): Promise<RoomLights> {
  return fetchApi(`/rooms/${encodeURIComponent(name)}/lights`);
}

/** The display a room's media requests belong to, resolved once on the server. */
export async function getRoomDisplay(name: string): Promise<SmartDevice | null> {
  return fetchApi(`/rooms/${encodeURIComponent(name)}/display`);
}

export async function getJarvisDevices(): Promise<JarvisDevice[]> {
  const rows = await fetchApi<Array<Record<string, any>>>('/devices');
  return rows.map(normalizeDevice);
}

export async function getUsersDirectory(): Promise<UserDirectoryEntry[]> {
  const rows = await fetchApi<Array<Record<string, any>>>('/users');
  return rows.map((row) => ({
    user_id: String(row.id),
    email: String(row.username || ''),
    display_name: String(row.name || row.username || ''),
  }));
}

export async function createJarvisDevice(body: {
  device_name: string;
  address: string;
  callback_port?: number | null;
  most_recent_conversation?: string | null;
  room?: string | null;
  device_type?: JarvisDeviceType;
  acting_user_id?: string | null;
  doorbell_alerts_enabled?: boolean;
  callback_secret?: string | null;
  describe_scene_prompt?: string | null;
  is_main_describe_camera?: boolean;
}): Promise<JarvisDevice> {
  const metadata = {
    most_recent_conversation: body.most_recent_conversation ?? null,
    acting_user_id: body.acting_user_id ?? null,
    doorbell_alerts_enabled: Boolean(body.doorbell_alerts_enabled),
    describe_scene_prompt: body.describe_scene_prompt ?? null,
    is_main_describe_camera: Boolean(body.is_main_describe_camera),
  };
  const created = await fetchApi<Record<string, any>>('/devices', {
    method: 'POST',
    body: JSON.stringify({
      name: body.device_name,
      kind: body.device_type === 'camera' ? 'camera' : 'voice',
      room: body.room || '',
      base_url: callbackBaseUrl(body.address, body.callback_port),
      metadata,
    }),
  });
  if (body.callback_secret?.trim()) {
    await fetchApi(`/devices/${created.id}/registration`, {
      method: 'PUT',
      body: JSON.stringify({ callback_token: body.callback_secret.trim() }),
    });
  }
  return normalizeDevice(created);
}

export async function updateJarvisDevice(
  id: string,
  body: {
    device_name?: string;
    address?: string;
    callback_port?: number | null;
    most_recent_conversation?: string | null;
    room?: string | null;
    device_type?: JarvisDeviceType;
    acting_user_id?: string | null;
    doorbell_alerts_enabled?: boolean;
      callback_secret?: string | null;
    describe_scene_prompt?: string | null;
    is_main_describe_camera?: boolean;
  }
): Promise<JarvisDevice> {
  const existing = (await fetchApi<Array<Record<string, any>>>('/devices')).find(
    (row) => String(row.id) === id
  );
  const oldMetadata = existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
  const metadata = {
    ...oldMetadata,
    ...(body.most_recent_conversation !== undefined
      ? { most_recent_conversation: body.most_recent_conversation }
      : {}),
    ...(body.acting_user_id !== undefined ? { acting_user_id: body.acting_user_id } : {}),
    ...(body.doorbell_alerts_enabled !== undefined
      ? { doorbell_alerts_enabled: body.doorbell_alerts_enabled }
      : {}),
    ...(body.describe_scene_prompt !== undefined
      ? { describe_scene_prompt: body.describe_scene_prompt }
      : {}),
    ...(body.is_main_describe_camera !== undefined
      ? { is_main_describe_camera: body.is_main_describe_camera }
      : {}),
  };
  const address = body.address ?? (existing ? addressFromBaseUrl(existing.base_url).address : '');
  const port =
    body.callback_port !== undefined
      ? body.callback_port
      : existing
        ? addressFromBaseUrl(existing.base_url).callbackPort
        : null;
  const updated = await fetchApi<Record<string, any>>(`/devices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      ...(body.device_name !== undefined ? { name: body.device_name } : {}),
      ...(body.room !== undefined ? { room: body.room || '' } : {}),
      ...(body.device_type !== undefined
        ? { kind: body.device_type === 'camera' ? 'camera' : 'voice' }
        : {}),
      ...(body.address !== undefined || body.callback_port !== undefined
        ? { base_url: callbackBaseUrl(address, port) }
        : {}),
      metadata,
    }),
  });
  if (body.callback_secret?.trim()) {
    await fetchApi(`/devices/${id}/registration`, {
      method: 'PUT',
      body: JSON.stringify({ callback_token: body.callback_secret.trim() }),
    });
  }
  return normalizeDevice(updated);
}

export async function createCameraStreamSession(deviceId: string): Promise<CameraStreamSession> {
  return fetchApi(`/devices/${deviceId}/camera/stream-session`, {
    method: 'POST',
  });
}

export function buildCameraStreamPageUrl(deviceId: string, cameraToken: string): string {
  const enc = encodeURIComponent(cameraToken);
  return `${getApiBaseUrl()}${API_PREFIX}/devices/${deviceId}/camera/stream?camera_token=${enc}`;
}

/**
 * Authenticated JPEG snapshot as a data URI for native Image rendering.
 * Android System WebView frequently fails to paint multipart MJPEG in an <img>,
 * so the mobile app polls snapshots instead of embedding the stream page.
 */
export async function fetchCameraSnapshotDataUri(deviceId: string): Promise<string> {
  const buildHeaders = (authToken: string | null): Record<string, string> => {
    const headers: Record<string, string> = {
      Accept: 'image/jpeg',
      ...ngrokSkipBrowserWarningHeaders(),
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return headers;
  };

  let token = tokenProvider?.() ?? null;
  let res = await fetchWithTimeout(
    `${getApiBaseUrl()}${API_PREFIX}/devices/${encodeURIComponent(deviceId)}/camera/snapshot`,
    { headers: buildHeaders(token) },
    15_000
  );
  if ((res.status === 401 || res.status === 403) && tokenRefresher) {
    const refreshed = await tokenRefresher();
    if (refreshed) {
      token = refreshed;
      res = await fetchWithTimeout(
        `${getApiBaseUrl()}${API_PREFIX}/devices/${encodeURIComponent(deviceId)}/camera/snapshot`,
        { headers: buildHeaders(token) },
        15_000
      );
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  return `data:${contentType};base64,${globalThis.btoa(binary)}`;
}

export async function deleteJarvisDevice(id: string): Promise<{ status: string }> {
  await fetchApi(`/devices/${id}`, { method: 'DELETE' });
  return { status: 'ok' };
}


export async function uploadAvatar(file: Blob): Promise<{ avatar_url: string }> {
  const formData = new FormData();
  formData.append('file', file);

  const doUpload = (authToken: string | null) => {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    return fetchWithTimeout(`${getApiBaseUrl()}${API_PREFIX}/users/me/avatar`, {
      method: 'POST',
      headers,
      body: formData,
    });
  };

  let token = tokenProvider?.() ?? null;
  let res = await doUpload(token);

  if ((res.status === 401 || res.status === 403) && tokenRefresher) {
    const newToken = await tokenRefresher();
    if (newToken) {
      res = await doUpload(newToken);
    }
  }

  if (!res.ok) {
    const text = await res.text();
    const isAuthError = res.status === 401 || res.status === 403;
    let message = text || res.statusText;
    if (isAuthError && text) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.detail === 'string') message = parsed.detail;
      } catch {
        // use raw text
      }
    }
    if (isAuthError && onAuthFailure) {
      onAuthFailure(message);
    }
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export async function getTodos(category?: string): Promise<Todo[]> {
  const rows = await fetchApi<Todo[]>('/todos');
  return category ? rows.filter((todo) => todo.category === category) : rows;
}

export async function createTodo(body: TodoCreate): Promise<Todo> {
  return fetchApi('/todos', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateTodo(id: string, body: TodoUpdate): Promise<Todo> {
  return fetchApi(`/todos/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteTodo(id: string): Promise<void> {
  return fetchApi(`/todos/${id}`, { method: 'DELETE' });
}

export async function getCodeTasks(status?: string, limit = 50): Promise<CodeTask[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);
  return fetchApi<CodeTask[]>(`/code-tasks?${params.toString()}`);
}

export async function getCodeTask(id: string): Promise<CodeTask> {
  return fetchApi<CodeTask>(`/code-tasks/${encodeURIComponent(id)}`);
}

export async function createCodeTask(body: CodeTaskCreate): Promise<CodeTask> {
  return fetchApi<CodeTask>('/code-tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function cancelCodeTask(id: string): Promise<CodeTask> {
  return fetchApi<CodeTask>(`/code-tasks/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

export async function getShoppingLists(): Promise<ShoppingList[]> {
  return fetchApi('/shopping-lists');
}

export async function getShoppingList(id: string): Promise<ShoppingList> {
  const row = (await getShoppingLists()).find((list) => list.id === id);
  if (!row) throw new Error('Shopping list not found');
  return row;
}

export async function createShoppingList(body: ShoppingListCreate): Promise<ShoppingList> {
  return fetchApi('/shopping-lists', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateShoppingList(
  id: string,
  body: ShoppingListUpdate
): Promise<ShoppingList> {
  return fetchApi(`/shopping-lists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteShoppingList(id: string): Promise<void> {
  return fetchApi(`/shopping-lists/${id}`, { method: 'DELETE' });
}

export async function getTimers(): Promise<Timer[]> {
  return fetchApi('/timers');
}

export async function getTimer(id: string): Promise<Timer> {
  const row = (await getTimers()).find((timer) => timer.id === id);
  if (!row) throw new Error('Timer not found');
  return row;
}

export async function createTimer(body: TimerCreate): Promise<Timer> {
  return fetchApi('/timers', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateTimer(id: string, action: TimerAction): Promise<Timer> {
  return fetchApi(`/timers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  });
}

export async function deleteTimer(id: string): Promise<void> {
  return fetchApi(`/timers/${id}`, { method: 'DELETE' });
}

export async function getConversations(q?: string): Promise<Conversation[]> {
  const rows = await fetchApi<Array<Record<string, any>>>('/conversations');
  const normalized = rows.map(normalizeConversation);
  const query = q?.trim().toLocaleLowerCase();
  return query
    ? normalized.filter((conversation) =>
        [conversation.title, conversation.summary, ...(conversation.keywords || [])]
          .filter(Boolean)
          .some((part) => String(part).toLocaleLowerCase().includes(query))
      )
    : normalized;
}

export async function createConversation(): Promise<Conversation> {
  return normalizeConversation(
    await fetchApi<Record<string, any>>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'New conversation' }),
    })
  );
}

export async function getConversation(id: string): Promise<Conversation> {
  return normalizeConversation(await fetchApi<Record<string, any>>(`/conversations/${id}`));
}

export async function patchConversation(
  id: string,
  body: { active_project_id?: string | null }
): Promise<Conversation> {
  return normalizeConversation(await fetchApi<Record<string, any>>(`/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ project_id: body.active_project_id }),
  }));
}

export async function listJarvisProjects(): Promise<JarvisProject[]> {
  return (await fetchApi<Array<Record<string, any>>>('/projects')).map(normalizeProject);
}

export async function getJarvisProject(id: string): Promise<JarvisProject> {
  return normalizeProject(await fetchApi<Record<string, any>>(`/projects/${id}`));
}

export async function createJarvisProject(body: JarvisProjectCreate): Promise<JarvisProject> {
  return normalizeProject(await fetchApi<Record<string, any>>('/projects', {
    method: 'POST',
    body: JSON.stringify({ title: body.title, description: body.description_md || '' }),
  }));
}

export async function getProjectTree(projectId: string): Promise<JarvisProjectNode[]> {
  return fetchApi(`/projects/${projectId}/tree`);
}

export async function createProjectFolder(
  projectId: string,
  body: { name: string; parent_id?: string | null }
): Promise<JarvisProjectNode> {
  return fetchApi(`/projects/${projectId}/folders`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function renameProjectNode(
  projectId: string,
  nodeId: string,
  body: { name: string }
): Promise<JarvisProjectNode> {
  return fetchApi(`/projects/${projectId}/nodes/${nodeId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteProjectNode(projectId: string, nodeId: string): Promise<void> {
  await fetchApi(`/projects/${projectId}/nodes/${nodeId}`, { method: 'DELETE' });
}

export interface ProjectUploadResponse {
  ok: boolean;
  uploaded: number;
  results: unknown[];
  errors: string[];
}

export async function uploadProjectFiles(
  projectId: string,
  files: { blob: Blob; filename: string }[],
  parentId?: string | null
): Promise<ProjectUploadResponse> {
  const token = tokenProvider?.() ?? null;
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const results: unknown[] = [];
  const errors: string[] = [];
  for (const item of files) {
    const formData = new FormData();
    formData.append('file', item.blob, item.filename);
    formData.append('project_id', projectId);
    if (parentId) formData.append('parent_id', parentId);
    const res = await fetchWithTimeout(`${getApiBaseUrl()}${API_PREFIX}/assets/files`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!res.ok) {
      errors.push(`${item.filename}: ${await res.text()}`);
    } else {
      results.push(await res.json());
    }
  }
  return { ok: errors.length === 0, uploaded: results.length, results, errors };
}

export async function uploadJarvisAsset(
  file: Blob,
  fileName: string,
  conversationId: string,
  mimeType: string,
  projectId?: string | null
): Promise<Record<string, unknown>> {
  const formData = new FormData();
  formData.append('file', file, fileName);
  formData.append('conversation_id', conversationId);
  if (projectId) formData.append('project_id', projectId);
  const token = tokenProvider?.() ?? null;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchWithTimeout(`${getApiBaseUrl()}${API_PREFIX}/assets/files`, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export async function postMessage(
  conversationId: string | undefined,
  message: string,
  attachments?: MessageAttachmentRef[]
): Promise<ChatPostResponse> {
  const body: {
    conversation_id?: string;
    message: string;
    attachments?: string[];
  } = { message };
  if (conversationId && conversationId.trim()) {
    body.conversation_id = conversationId.trim();
  }
  if (attachments && attachments.length > 0) {
    body.attachments = attachments.map((attachment) => attachment.asset_id);
  }
  const result = await fetchApi<Record<string, any>>(
    '/chat',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    CHAT_POST_TIMEOUT_MS
  );
  return {
    conversation_id: result.conversation_id,
    response: String(result.response || ''),
    message: result.message,
    assistant_message: result.message,
  };
}

/** Synthesize one assistant reply with the local Kokoro service. */
export async function fetchMessageTtsWav(text: string): Promise<ArrayBuffer> {
  const token = tokenProvider?.() ?? null;
  const url = `${getApiBaseUrl()}${API_PREFIX}/speech/synthesize`;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  headers['Content-Type'] = 'application/json';
  const extra = ngrokSkipBrowserWarningHeaders();
  for (const [k, v] of Object.entries(extra)) {
    headers[k] = v;
  }
  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers, body: JSON.stringify({ text }) },
    CHAT_POST_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.arrayBuffer();
}

export async function registerPushToken(
  body: RegisterPushTokenRequest,
  tokenOverride?: string | null
): Promise<{ status: string }> {
  if (tokenOverride !== undefined && tokenOverride !== null) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenOverride}`,
    };
    const res = await fetchWithTimeout(`${getApiBaseUrl()}${API_PREFIX}/users/me/push-tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }
    return res.json();
  }
  return fetchApi('/users/me/push-tokens', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function unregisterPushToken(
  body: DeletePushTokenRequest,
  tokenOverride?: string | null
): Promise<{ status: string; deactivated?: number }> {
  if (tokenOverride !== undefined && tokenOverride !== null) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenOverride}`,
    };
    const res = await fetchWithTimeout(`${getApiBaseUrl()}${API_PREFIX}/users/me/push-tokens`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }
    return res.json();
  }
  return fetchApi('/users/me/push-tokens', {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}
