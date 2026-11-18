import assert from 'node:assert/strict';
import test from 'node:test';
import { guessLanguage, pcmToBytes, threadsFor, toEnhancedLrc } from './transcript-lrc.ts';
import { parseEnhancedWords } from './lyric-words.ts';

test('writes enhanced LRC that our parser reads back', () => {
  const lrc = toEnhancedLrc([
    { startMs: 1230, words: [{ startMs: 1230, durMs: 400, text: 'Hello ' }, { startMs: 1630, durMs: 500, text: 'world' }] },
    { startMs: 65000, words: [{ startMs: 65000, durMs: 300, text: 'Bye' }] },
  ]);
  assert.equal(lrc, '[00:01.23]<00:01.23>Hello <00:01.63>world\n[01:05.00]<01:05.00>Bye');
  const body = lrc.split('\n')[0].replace(/\[[^\]]*\]/g, '');
  const r = parseEnhancedWords(body);
  assert.equal(r.text, 'Hello world');
  assert.deepEqual(r.words.map((w) => w.t), [1.23, 1.63]);
});

test('guesses the language from the script', () => {
  assert.equal(guessLanguage('Скриптонит — Положение'), 'ru');
  assert.equal(guessLanguage('Океан Ельзи — Обійми'), 'uk');
  assert.equal(guessLanguage('Daft Punk - One More Time'), 'auto');
  assert.equal(guessLanguage('123'), 'auto');
});

test('load levels keep CPU headroom', () => {
  assert.equal(threadsFor('low', 24), 2);
  assert.equal(threadsFor('medium', 24), 6);
  assert.equal(threadsFor('high', 24), 12);
  assert.equal(threadsFor('medium', 4), 2);
  assert.equal(threadsFor('low', 1), 1);
});

test('PCM is encoded little-endian', () => {
  const b = pcmToBytes(new Float32Array([1, -0.5]));
  const v = new DataView(b.buffer);
  assert.equal(v.getFloat32(0, true), 1);
  assert.equal(v.getFloat32(4, true), -0.5);
});
