import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [player, seek, integrations, overlays, ui] = await Promise.all([
  read('../state/player.ts'),
  read('../components/Seek.tsx'),
  read('../pages/Integrations.tsx'),
  read('../components/Overlays.tsx'),
  read('../state/ui.ts'),
]);

test('Listen Together guests see playback controls as disabled', () => {
  assert.match(player, /export function usePlaybackControlLocked\(/);
  assert.match(seek, /usePlaybackControlLocked/);
  assert.match(seek, /aria-disabled=\{!canControl\}/);
  assert.match(seek, /className=\{cx\('seek', big && 'seek-big', playing && 'is-playing', dragging && 'dragging', !canControl && 'disabled'\)\}/);
  assert.match(seek, /if \(!canControl\) return;/);
  assert.match(seek, /disabled=\{!has \|\| locked\}/);
  assert.match(seek, /disabled=\{locked\}/);
});

test('room creation and Join are side by side with the code entry in a modal', () => {
  assert.match(integrations, /className="flex flex-wrap items-center gap-2"[\s\S]*?\{t\('listenHost'\)\}[\s\S]*?openDialog\(\{ kind: 'listen-join' \}\)[\s\S]*?\{t\('listenJoin'\)\}/);
  assert.match(ui, /kind: 'listen-join'/);
  assert.match(integrations, /openDialog\(\{ kind: 'listen-join' \}\)/);
  assert.doesNotMatch(integrations, /<textarea[\s\S]*?1234-ABCD/);
  assert.match(overlays, /last\.kind === 'listen-join'[\s\S]*?<ListenJoinDialog/);
  assert.match(overlays, /joinSession\(normalized\)/);
  assert.match(overlays, /autoFocus/);
});
