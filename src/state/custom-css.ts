import { createStore, persist } from '../lib/util';

/** User stylesheet applied on top of the app's own CSS. */
export const customCss = createStore({ enabled: false, css: '' });
persist('resonance.custom_css.v1', customCss, (s) => s, 400);

export const CSS_SNIPPETS: { id: string; css: string }[] = [
  {
    id: 'bigLyrics',
    css: `/* Bigger fullscreen lyrics */\n.lyrics[data-v=imm] { --lfs: clamp(32px, 4vw, 64px); }\n`,
  },
  {
    id: 'squareCovers',
    css: `/* Square cover art */\n.np-cover, .imm-cover, .imm-carousel-stage, .imm-carousel-card { border-radius: 6px !important; }\n`,
  },
  {
    id: 'hideSource',
    css: `/* Hide the source badge next to artists */\n.provider-logo { display: none !important; }\n`,
  },
  {
    id: 'mono',
    css: `/* Monochrome UI */\nhtml { filter: grayscale(1); }\n`,
  },
];

const STYLE_ID = 'resonance-user-css';

function apply() {
  const { enabled, css } = customCss.get();
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!enabled || !css.trim()) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
  }
  // Always last in <head> so it wins over the app's own rules of equal specificity.
  document.head.appendChild(el);
  if (el.textContent !== css) el.textContent = css;
}

export function initCustomCss() {
  customCss.subscribe(apply);
  apply();
}

export function addSnippet(id: string) {
  const s = CSS_SNIPPETS.find((x) => x.id === id);
  if (!s) return;
  customCss.set((c) => ({ enabled: true, css: c.css.includes(s.css.trim()) ? c.css : `${c.css.trimEnd()}${c.css.trim() ? '\n\n' : ''}${s.css}` }));
}
