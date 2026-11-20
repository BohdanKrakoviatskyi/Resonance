import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

function htmlIconNames() {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const param = /icon_names=([^&"]+)/.exec(html);
  assert.ok(param, 'index.html must subset the icon font with icon_names');
  return param[1].split(',');
}

function sourceIconNames() {
  const source = readFileSync(new URL('src/components/Icon.tsx', root), 'utf8');
  const body = /export const ICONS = \[([\s\S]*?)\] as const;/.exec(source);
  assert.ok(body, 'Icon.tsx must export the ICONS list');
  return [...body[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the icon font subset requested by index.html matches the ICONS list', () => {
  const requested = htmlIconNames();
  const declared = sourceIconNames();
  assert.deepEqual(
    requested.filter((name) => !declared.includes(name)),
    [],
    'index.html requests glyphs that Icon.tsx never renders',
  );
  assert.deepEqual(
    declared.filter((name) => !requested.includes(name)),
    [],
    'Icon.tsx renders glyphs the icon font subset does not include',
  );
});
