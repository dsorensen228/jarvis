export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  category: string;
  created_at: string;
  updated_at: string;
}

export type CodeTaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'success'
  | 'failed';

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
}

export interface CodeTaskCreate {
  prompt: string;
  model?: string | null;
}

export interface TodoCreate {
  title: string;
  category?: string;
}

export interface TodoUpdate {
  title?: string;
  completed?: boolean;
  category?: string;
}

export interface ShoppingListItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface ShoppingList {
  id: string;
  name: string;
  items: ShoppingListItem[];
  created_at: string;
  updated_at: string;
  owner_id: string;
  is_shared_with_me: boolean;
}

export interface ShoppingListCreate {
  name: string;
}

export interface ShoppingListUpdate {
  name?: string;
  add_items?: string[];
  remove_item_ids?: string[];
  toggle_item_ids?: string[];
  share_with_user_id?: string;
}

export interface Timer {
  id: string;
  label: string;
  duration_seconds: number;
  status: 'idle' | 'running' | 'paused' | 'completed';
  started_at: string | null;
  remaining_seconds: number | null;
  created_at: string;
}

export interface TimerCreate {
  label?: string;
  duration_seconds: number;
}

export type TimerAction = 'start' | 'pause' | 'reset';

export interface Conversation {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
  messages?: Message[];
  active_project_id?: string | null;
  memory_turn_counter?: number;
  title?: string | null;
  summary?: string | null;
  keywords?: string[];
  keywords_text?: string | null;
  digest_updated_at?: string | null;
}

export interface MessageAttachmentRef {
  asset_id: string;
  mime_type: string;
}

/** URLs gathered from search tools (e.g. Tavily / web_search) for assistant transparency */
export interface MessageSourceRef {
  url: string;
  title?: string;
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  additional_info?: string;
  source_agent?: string;
  attachments?: MessageAttachmentRef[];
  sources?: MessageSourceRef[];
}

export interface JarvisProject {
  id: string;
  title: string;
  description_md?: string;
  status_md?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

export interface JarvisProjectCreate {
  title: string;
  description_md?: string;
  status_md?: string;
  summary?: string;
}

export interface JarvisProjectNode {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: 'folder' | 'asset';
  name: string;
  sort_key?: number;
  asset_id?: string | null;
}

export interface ChatPostResponse {
  /** Present when the server created a new conversation (lazy create). */
  conversation_id?: string;
  response: string;
  message?: Message;
  user_message?: Message;
  assistant_message?: Message;
}

export interface MessageTtsRequest {
  message_id: string;
  agent?: string;
}

export interface MessageTtsResponse {
  audio_url: string;
  expires_at: string | null;
  cache_hit: boolean;
  message_id: string;
  agent: string;
}

export interface User {
  id: string;
  username?: string;
  email: string;
  name: string;
  avatar_path?: string | null;
  avatar_url?: string | null;
  theme?: string | null;
  gmail_enabled?: boolean;
  /** Whether the server can reach Home Assistant right now. */
  smart_home_connected?: boolean;
  jarvis_personality?: number;
  /** Effective values (DB overrides merged with server defaults). */
  jarvis_orchestrator_model?: string;
  jarvis_voice_model?: string;
  jarvis_web_recursion_limit?: number;
  /** 0–100: higher = more cost-aware when choosing among models that can answer well. */
  jarvis_cost_sensitivity?: number;
}

export interface MeSettingsUpdate {
  theme?: string;
  jarvis_personality?: number;
  jarvis_orchestrator_model?: string;
  jarvis_voice_model?: string;
  jarvis_web_recursion_limit?: number | null;
  jarvis_cost_sensitivity?: number | null;
}

export type JarvisModelEcosystem = 'Qwen';

export interface JarvisCatalogModel {
  id: string;
  user_id: string;
  ecosystem: JarvisModelEcosystem;
  model_id: string;
  display_name: string;
  description: string;
  focused_on: string;
  good_at: string[];
  bad_at: string[];
  intended_for: string[];
  latency_tier: 'low' | 'medium' | 'high';
  reasoning_tier: 'none' | 'standard' | 'high';
  default_reasoning_effort: string | null;
  supports_vision: boolean;
  supports_tools: boolean;
  max_output_tokens_hint: number | null;
  cost_tier: 'low' | 'medium' | 'high';
  input_cost_usd_per_mtok: number | null;
  output_cost_usd_per_mtok: number | null;
  cost_notes: string;
  enabled: boolean;
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface JarvisCatalogModelCreate {
  ecosystem: JarvisModelEcosystem;
  model_id: string;
  display_name?: string;
  description?: string;
  focused_on?: string;
  good_at?: string[];
  bad_at?: string[];
  intended_for?: string[];
  latency_tier?: 'low' | 'medium' | 'high';
  reasoning_tier?: 'none' | 'standard' | 'high';
  default_reasoning_effort?: string | null;
  supports_vision?: boolean;
  supports_tools?: boolean;
  max_output_tokens_hint?: number | null;
  cost_tier?: 'low' | 'medium' | 'high';
  input_cost_usd_per_mtok?: number | null;
  output_cost_usd_per_mtok?: number | null;
  cost_notes?: string;
  enabled?: boolean;
  sort_order?: number;
}

export interface GmailAlert {
  id: string;
  conversation_id: string;
  message_id: string;
  subject: string;
  snippet: string;
  reason: string;
  created_at: string | null;
  dismissed: boolean;
}

/**
 * What a device can actually do. Home Assistant reports this per entity, so the
 * app shows a control only when the device really supports it.
 */
export type SmartHomeCapability =
  | 'power'
  | 'brightness'
  | 'color'
  | 'color_temperature'
  | 'volume'
  | 'mute'
  | 'playback'
  | 'app_launch'
  | 'remote_keys';

export type SmartHomeDomain = 'light' | 'switch' | 'media_player' | 'remote';

/** A neutral remote key. The server rejects anything outside this set. */
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

/**
 * One addressable part of a device: `main`, or `socket_1`/`socket_2` on a plug
 * with individually switchable outlets.
 */
export interface SmartDeviceComponent {
  key: string;
  entity_id: string;
  domain: SmartHomeDomain | '';
  /** The owner's label if they set one, otherwise the discovered name. */
  name: string;
  default_name: string;
  capabilities: SmartHomeCapability[];
  available: boolean;
  /** `null` means unknown, never off. */
  power: boolean | null;
  brightness_percent?: number;
  color?: [number, number, number];
  kelvin?: number;
  min_kelvin?: number;
  max_kelvin?: number;
  muted?: boolean;
  app?: string;
  apps?: string[];
  playback_state?: string;
}

export interface SmartDevice {
  id: string;
  platform: string;
  /** The Home Assistant integration behind it, for display only. */
  integration: string;
  external_id: string;
  /** The owner's name for the device. */
  name: string;
  /** The name discovery found, shown when it differs from the owner's. */
  source_name: string;
  room: string;
  model: string;
  manufacturer: string;
  /** Whether this device takes part in room and whole-house light control. */
  is_light: boolean;
  capabilities: SmartHomeCapability[];
  components: SmartDeviceComponent[];
  available: boolean;
  power: boolean | null;
  primary_for_room?: boolean;
}

export interface SmartHomeStatus {
  platform: string;
  configured: boolean;
  connected: boolean;
  device_count: number;
  imported_count: number;
  orphaned_count: number;
  version: string;
  error: string;
}

export interface Room {
  id: string;
  name: string;
  device_count: number;
}

export interface RoomLights {
  room: string;
  count: number;
  /** `null` when no light in the room reported a state. */
  is_on: boolean | null;
  unknown: number;
}

export interface SmartDeviceUpdate {
  name?: string;
  room?: string | null;
  is_light?: boolean;
  /** Per-component labels, keyed by component key. */
  component_labels?: Record<string, string>;
  primary_for_room?: boolean;
}

export type JarvisDeviceType = 'voice_interface' | 'camera';

export interface JarvisDevice {
  id: string;
  device_name: string;
  /** mDNS/LAN hostname (e.g. voice-node.local); jarvis_api reaches the Pi at http://address:callback_port */
  address: string;
  /** CallbackServer TCP port on the Pi when set; omit uses API default (8089). */
  callback_port?: number | null;
  user_id: string;
  most_recent_conversation: string | null;
  room: string | null;
  device_type: JarvisDeviceType;
  acting_user_id: string | null;
  doorbell_alerts_enabled: boolean;
  /** Camera-only: extra instructions merged into describe_scene vision prompts. */
  describe_scene_prompt?: string | null;
  /** Camera-only: Jarvis uses this camera for describe_scene when the user does not name one. */
  is_main_describe_camera?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CameraStreamSession {
  stream_path: string;
  snapshot_path: string;
  camera_token: string;
  expires_in: number;
}

export interface UserDirectoryEntry {
  user_id: string;
  email: string;
  display_name: string;
}

export type SmartHomeAction =
  | 'turn_on'
  | 'turn_off'
  | 'toggle'
  | 'brightness'
  | 'color'
  | 'color_temperature'
  | 'volume_up'
  | 'volume_down'
  | 'mute'
  | 'unmute'
  | 'play'
  | 'pause'
  | 'play_pause'
  | 'launch_app'
  | 'key';

/** Parameters the server understands, spelled the way the API expects them. */
export interface SmartHomeParameters {
  /** 1-100 for `brightness`. */
  percent?: number;
  red?: number;
  green?: number;
  blue?: number;
  /** Kelvin for `color_temperature`; clamped to the device's own range. */
  kelvin?: number;
  /** An app name for `launch_app`; matched case-insensitively. */
  app?: string;
  /** An exact app or input id for `launch_app`, used in preference to `app`. */
  app_id?: string;
  key?: RemoteKey;
}

export interface SmartHomeCommandBody {
  action: SmartHomeAction;
  /** Which part of the device to act on. Defaults to `main`. */
  component?: string;
  parameters?: SmartHomeParameters;
}

export interface SmartHomeCommandResult {
  device_id: string;
  device: string;
  component: string;
  entity_id: string;
  action: SmartHomeAction;
  accepted: boolean;
  power?: boolean;
  brightness_percent?: number;
  color?: [number, number, number];
  kelvin?: number;
  muted?: boolean;
  app?: string;
  key?: string;
}

export interface LightControlBody {
  scope: 'device' | 'room' | 'all';
  selector?: string;
  action: SmartHomeAction;
  parameters?: SmartHomeParameters;
}

export interface LightControlResult {
  scope: string;
  selector: string;
  action: string;
  succeeded: number;
  failed: number;
  devices: string[];
  errors: string[];
}

export interface RegisterPushTokenRequest {
  token: string;
  provider?: 'expo';
  platform?: string;
  device_id?: string;
}

export interface DeletePushTokenRequest {
  token?: string;
  provider?: 'expo';
  device_id?: string;
}
