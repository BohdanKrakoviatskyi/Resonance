import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { initFx } from './lib/motion';
import { initPlayer } from './state/player';
import { initTheme } from './state/theme';

const ua = navigator.userAgent;
document.documentElement.dataset.distort = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua) ? 'off' : 'on';

const preventSelectOrDrag = (e: Event) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
};
document.addEventListener('selectstart', preventSelectOrDrag);
document.addEventListener('dragstart', preventSelectOrDrag);

initPlayer();
initTheme();
initFx();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
