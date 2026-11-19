import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postcss from 'postcss';

const cssText = await readFile(new URL('../index.css', import.meta.url), 'utf8');
const css = postcss.parse(cssText);
const immersiveSource = await readFile(new URL('../components/Immersive.tsx', import.meta.url), 'utf8');
const translations = await readFile(new URL('./i18n.ts', import.meta.url), 'utf8');


function declarationsFor(selector) {
  const declarations = [];
  css.walkRules((rule) => {
    if (rule.selectors?.includes(selector)) {
      rule.walkDecls((declaration) => declarations.push([declaration.prop, declaration.value]));
    }
  });
  return declarations;
}

test('fullscreen lyrics have no visualizer button, rendering, styles, or translations', () => {
  assert.doesNotMatch(immersiveSource, /Visualizer|cycleViz|vizStore|visualizer|vizOff|vizBars|vizWave/);
  assert.doesNotMatch(cssText, /\.imm-viz\b/);
  assert.doesNotMatch(translations, /\b(?:visualizer|vizOff|vizBars|vizWave):/);
});

test('fullscreen lyrics keep the glass-controls backdrop static during the transition', () => {
  const immersive = [];
  const scrim = [];
  css.walkRules((rule) => {
    if (rule.selectors?.includes('.immersive')) {
      rule.walkDecls((declaration) => immersive.push([declaration.prop, declaration.value]));
    }
    if (rule.selectors?.includes('.imm-scrim')) {
      rule.walkDecls((declaration) => scrim.push([declaration.prop, declaration.value]));
    }
  });

  assert.equal(immersive.some(([prop, value]) => prop === 'transition' && /(?:^|,)\s*(?:opacity|transform)\b/.test(value)), false);
  assert.equal(immersive.some(([prop]) => prop === 'opacity' || prop === 'transform'), false);
  assert.equal(scrim.some(([prop, value]) => prop === 'transition' && /opacity/.test(value)), false);
});

test('fullscreen lyrics are immediately hidden and non-interactive while retained for exit cleanup', () => {
  const hidden = declarationsFor('.immersive[data-visible=false]');
  assert.equal(hidden.some(([prop, value]) => prop === 'visibility' && value === 'hidden'), true);
  assert.equal(hidden.some(([prop, value]) => prop === 'pointer-events' && value === 'none'), true);
});

test('fullscreen lyrics do not force glass panels to zero blur', () => {
  const zeroBlurOverrides = [];
  css.walkRules((rule) => {
    const appliesDuringLyrics = rule.selectors?.some((selector) =>
      /(?:^|\s)\.shell\[data-hidden=true\].*\.panel.*::before$/.test(selector) ||
      /^html\[data-immersive\].*\.panel.*::before$/.test(selector),
    );
    if (!appliesDuringLyrics) return;

    rule.walkDecls((declaration) => {
      if (declaration.prop.includes('backdrop-filter') && declaration.value.includes('blur(0px)')) {
        zeroBlurOverrides.push(`${rule.selector}: ${declaration.toString()}`);
      }
    });
  });

  assert.deepEqual(zeroBlurOverrides, []);
});
