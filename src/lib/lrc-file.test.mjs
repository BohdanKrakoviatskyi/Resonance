import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLrcFile } from './lrc-file.ts';

const fb = { title: 'Fallback', artist: 'Someone' };

test('reads metadata, offset and timed lines', () => {
  const rec = parseLrcFile('﻿[ar:Artist]\r\n[ti:Song]\r\n[offset:+500]\r\n[00:01.20]Hello\r\n[00:03.00]World', fb);
  assert.equal(rec.artistName, 'Artist');
  assert.equal(rec.trackName, 'Song');
  assert.equal(rec.offsetSec, -0.5);
  assert.equal(rec.syncedLyrics, '[00:01.20]Hello\n[00:03.00]World');
  assert.equal(rec.plainLyrics, undefined);
});

test('falls back to plain text and track metadata', () => {
  const rec = parseLrcFile('line one\nline two\n', fb);
  assert.equal(rec.trackName, 'Fallback');
  assert.equal(rec.artistName, 'Someone');
  assert.equal(rec.plainLyrics, 'line one\nline two');
  assert.equal(rec.syncedLyrics, undefined);
  assert.equal(rec.offsetSec, 0);
});

test('rejects files without lyrics', () => {
  assert.equal(parseLrcFile('[ar:x]\n\n', fb), null);
});
