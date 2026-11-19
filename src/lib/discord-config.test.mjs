import assert from 'node:assert/strict';
import test from 'node:test';
import { DISCORD_APPLICATION_ID } from './discord-config.ts';

test('uses the built-in Discord application ID', () => {
  assert.equal(DISCORD_APPLICATION_ID, '1572906696307646464');
  assert.match(DISCORD_APPLICATION_ID, /^\d{17,20}$/);
});
