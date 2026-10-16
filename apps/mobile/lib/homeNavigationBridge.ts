/** Opens a specific page from another surface or a notification. */

let goToChat: (() => void) | null = null;
let pendingCamera: { deviceId?: string } | null = null;
let goToCameras: ((deviceId?: string) => void) | null = null;

export function registerHomeGoToChat(fn: (() => void) | null) {
  goToChat = fn;
}

export function navigateHomeToChat() {
  goToChat?.();
}

export function registerHomeGoToCameras(fn: ((deviceId?: string) => void) | null) {
  goToCameras = fn;
  if (fn && pendingCamera) {
    const { deviceId } = pendingCamera;
    pendingCamera = null;
    fn(deviceId);
  }
}

export function navigateHomeToCameras(deviceId?: string) {
  if (goToCameras) goToCameras(deviceId);
  else pendingCamera = { deviceId };
}

let goToTv: ((deviceId: string) => void) | null = null;

export function registerHomeGoToTv(fn: ((deviceId: string) => void) | null) {
  goToTv = fn;
}

export function navigateHomeToTv(deviceId: string) {
  goToTv?.(deviceId);
}

export type NotificationTaskKind = 'code' | 'research';
let goToTask: ((kind: NotificationTaskKind, taskId: string) => void) | null = null;
let pendingTask: { kind: NotificationTaskKind; taskId: string } | null = null;

export function registerHomeGoToTask(fn: typeof goToTask) {
  goToTask = fn;
  if (fn && pendingTask) {
    const { kind, taskId } = pendingTask;
    pendingTask = null;
    fn(kind, taskId);
  }
}

export function navigateHomeToTask(kind: NotificationTaskKind, taskId: string) {
  if (goToTask) goToTask(kind, taskId);
  else pendingTask = { kind, taskId };
}
