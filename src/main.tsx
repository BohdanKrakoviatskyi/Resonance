import { StrictMode } from 'react';

import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { initFx } from './lib/motion';
import { initPlayer } from './state/player';
import { initializeShortcutRuntime } from './state/shortcut-runtime';
import { initTheme } from './state/theme';

// Refraction via SVG backdrop filters is reliable in Chromium/Firefox only.
const ua = navigator.userAgent;
document.documentElement.dataset.distort = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua) ? 'off' : 'on';

initPlayer();
initializeShortcutRuntime();
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
  <StrictMode>
    <App />
  </StrictMode>,
);
