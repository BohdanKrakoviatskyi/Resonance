import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postcss from 'postcss';

const css = postcss.parse(await readFile(new URL('../index.css', import.meta.url), 'utf8'));

function declarationsFor(selector) {
  const declarations = [];
  css.walkRules((rule) => {
    if (rule.selectors?.includes(selector)) {
      rule.walkDecls((declaration) => declarations.push([declaration.prop, declaration.value]));
    }
  });
  return declarations;
}

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
