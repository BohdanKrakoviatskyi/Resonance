import { StrictMode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import Splash from './components/Splash';
import { initFx } from './lib/motion';
import { initPlayer } from './state/player';
import { initializeShortcutRuntime } from './state/shortcut-runtime';
import { initTheme } from './state/theme';

function detectSplashWindow(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has('splash') || window.location.hash === '#splash' || window.location.pathname.endsWith('/splash.html')) {
    return true;
  }
  try {
    return getCurrentWindow().label === 'splash';
  } catch {
    return false;
  }
}

const isSplash = detectSplashWindow();
if (isSplash) {
  document.documentElement.dataset.splash = 'true';
}

// Refraction via SVG backdrop filters is reliable in Chromium/Firefox only.
const ua = navigator.userAgent;
document.documentElement.dataset.distort = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua) ? 'off' : 'on';

if (!isSplash) {
  initPlayer();
  initializeShortcutRuntime();
}
initTheme();
initFx();

// Жёсткий запрет выделения/перетаскивания мышью (страховка к CSS выше,
// в т.ч. для случаев, когда движок игнорирует user-select).
const preventSelectOrDrag = (e: Event) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
};
document.addEventListener('selectstart', preventSelectOrDrag);
document.addEventListener('dragstart', preventSelectOrDrag);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isSplash ? <Splash /> : <App />}</StrictMode>,
);
