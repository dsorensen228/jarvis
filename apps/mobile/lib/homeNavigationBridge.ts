/** Lets push / notification handlers switch the home shell to Chat or Cameras. */

let goToChat: (() => void) | null = null;
let goToCameras: ((deviceId?: string) => void) | null = null;

export function registerHomeGoToChat(fn: (() => void) | null) {
  goToChat = fn;
}

export function navigateHomeToChat() {
  goToChat?.();
}

export function registerHomeGoToCameras(fn: ((deviceId?: string) => void) | null) {
  goToCameras = fn;
}

export function navigateHomeToCameras(deviceId?: string) {
  goToCameras?.(deviceId);
}
