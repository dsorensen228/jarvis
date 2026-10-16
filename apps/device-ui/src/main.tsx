import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

let _kioskTextInputHooksInstalled = false;

/** Help Pi OS on-screen keyboards (squeekboard / compositor) with Chromium kiosk. */
function installKioskTextInputHooks() {
  if (typeof navigator === 'undefined' || _kioskTextInputHooksInstalled) return;
  _kioskTextInputHooksInstalled = true;
  const nav = navigator as Navigator & {
    virtualKeyboard?: { overlaysContent?: boolean; show?: () => void };
  };
  const vk = nav.virtualKeyboard;
  if (vk) {
    try {
      vk.overlaysContent = true;
    } catch {
      /* ignore */
    }
    document.addEventListener(
      'focusin',
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA' && !t.isContentEditable) return;
        if (t instanceof HTMLInputElement && t.readOnly) return;
        if (t instanceof HTMLInputElement) {
          const hidden =
            t.type === 'hidden' ||
            t.type === 'range' ||
            t.type === 'checkbox' ||
            t.type === 'radio' ||
            t.type === 'button' ||
            t.type === 'submit' ||
            t.type === 'reset' ||
            t.type === 'file' ||
            t.type === 'color';
          if (hidden) return;
        }
        try {
          vk.show?.();
        } catch {
          /* ignore */
        }
      },
      true
    );
  }
}

function KioskBootstrap() {
  useEffect(() => {
    installKioskTextInputHooks();
  }, []);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <KioskBootstrap />
      <App />
    </HashRouter>
  </StrictMode>
);
