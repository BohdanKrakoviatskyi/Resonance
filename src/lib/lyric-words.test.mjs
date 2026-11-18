import assert from 'node:assert/strict';
import test from 'node:test';
import { fromWordLines, parseEnhancedWords, wordProgress } from './lyric-words.ts';

test('converts backend word lines to seconds', () => {
  const [l] = fromWordLines([{ startMs: 30430, words: [{ startMs: 30430, durMs: 510, text: 'One ' }, { startMs: 30940, durMs: 480, text: 'more' }] }]);
  assert.equal(l.t, 30.43);
  assert.equal(l.text, 'One more');
  assert.deepEqual(l.words.map((w) => w.d), [0.51, 0.48]);
});

test('parses enhanced LRC word tags', () => {
  const r = parseEnhancedWords('<00:12.00>Never <00:12.40>gonna <00:13.00>give', 14);
  assert.equal(r.text, 'Never gonna give');
  assert.deepEqual(r.words.map((w) => [w.t, +w.d.toFixed(2), w.text]), [
    [12, 0.4, 'Never '],
    [12.4, 0.6, 'gonna '],
    [13, 1, 'give'],
  ]);
  assert.deepEqual(parseEnhancedWords('plain line'), { text: 'plain line' });
});

test('word progress clamps before and after each word', () => {
  const words = [{ t: 1, d: 1, text: 'a ' }, { t: 2, d: 2, text: 'b' }];
  assert.deepEqual(wordProgress(words, 0.5, []), [0, 0]);
  assert.deepEqual(wordProgress(words, 1.5, []), [0.5, 0]);
  assert.deepEqual(wordProgress(words, 3, []), [1, 0.5]);
});
