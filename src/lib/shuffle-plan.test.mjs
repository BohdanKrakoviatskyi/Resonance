import assert from 'node:assert/strict';
import test from 'node:test';
import {
  avoidRecentHead,
  buildCycle,
  dedupePool,
  primaryArtist,
  sfc32,
  seedState,
  spreadGroups,
  trackIdentity,
  weightedPermutation,
} from './shuffle-plan.ts';
import { stepQueueIndex } from './player-queue.ts';

const uniform = () => 1;

function makePool(n, artists = 20) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(`track-${i}`);
  return { ids, artistOf: (id) => `artist-${Number(id.split('-')[1]) % artists}` };
}

function adjacentSameGroup(order, groupOf) {
  let count = 0;
  for (let i = 1; i < order.length; i++) if (groupOf(order[i]) === groupOf(order[i - 1])) count++;
  return count;
}

test('sfc32 is deterministic per seed and stays in range', () => {
  const a = sfc32(seedState('resonance'));
  const b = sfc32(seedState('resonance'));
  const c = sfc32(seedState('resonance-2'));
  const first = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], first);
  assert.notDeepEqual([c(), c(), c()], first);
  for (const value of first) assert.ok(value >= 0 && value < 1);
});

test('weighted permutation covers every id exactly once', () => {
  const { ids } = makePool(50);
  const order = weightedPermutation(ids, uniform, sfc32(seedState(7)));
  assert.equal(order.length, ids.length);
  assert.deepEqual([...order].sort(), [...ids].sort());
});

test('weighted first pick matches the Plackett-Luce probabilities', () => {
  const weights = (id) => (id === 'a' ? 4 : id === 'b' ? 2 : 1);
  const counts = { a: 0, b: 0, c: 0 };
  const runs = 12000;
  for (let i = 0; i < runs; i++) {
    const rnd = sfc32(seedState(`trial-${i}`));
    const order = weightedPermutation(['a', 'b', 'c'], weights, rnd);
    counts[order[0]]++;
  }
  assert.ok(Math.abs(counts.a / runs - 4 / 7) < 0.02, `a=${counts.a / runs}`);
  assert.ok(Math.abs(counts.b / runs - 2 / 7) < 0.02, `b=${counts.b / runs}`);
  assert.ok(Math.abs(counts.c / runs - 1 / 7) < 0.02, `c=${counts.c / runs}`);
});

test('a cycle plays every pool track once and never repeats one', () => {
  const { ids, artistOf } = makePool(200);
  for (let cycle = 0; cycle < 20; cycle++) {
    const order = buildCycle({ pool: ids, seed: 42, cycle, recent: [], groupOf: artistOf });
    assert.equal(order.length, ids.length);
    assert.equal(new Set(order).size, ids.length);
  }
});

test('the same seed and cycle reproduce the same order, the next cycle differs', () => {
  const { ids, artistOf } = makePool(80);
  const one = buildCycle({ pool: ids, seed: 1234, cycle: 3, recent: [], groupOf: artistOf });
  const two = buildCycle({ pool: ids, seed: 1234, cycle: 3, recent: [], groupOf: artistOf });
  const next = buildCycle({ pool: ids, seed: 1234, cycle: 4, recent: [], groupOf: artistOf });
  assert.deepEqual(one, two);
  assert.notDeepEqual(one, next);
});

test('a fresh cycle does not start with a track from the recent window', () => {
  const { ids, artistOf } = makePool(200);
  const recent = ids.slice(0, 8);
  for (let cycle = 0; cycle < 50; cycle++) {
    const order = buildCycle({ pool: ids, seed: 99, cycle, recent, groupOf: artistOf });
    assert.equal(recent.includes(order[0]), false, `cycle ${cycle} started with ${order[0]}`);
  }
});

test('the boundary guard survives a pool smaller than the recent window', () => {
  const both = avoidRecentHead(['a', 'b'], ['a', 'b']);
  assert.notEqual(both[0], 'b');
  assert.deepEqual([...both].sort(), ['a', 'b']);
  assert.deepEqual(avoidRecentHead(['a', 'b'], ['b']), ['a', 'b']);
  assert.deepEqual(avoidRecentHead(['a'], ['a']), ['a']);
});

test('the artist spread beats uniform shuffling on adjacent same-artist pairs', () => {
  const { ids, artistOf } = makePool(200, 20);
  let naiveTotal = 0;
  let spreadTotal = 0;
  const runs = 20;
  for (let i = 0; i < runs; i++) {
    const rnd = sfc32(seedState(`spread-${i}`));
    naiveTotal += adjacentSameGroup(weightedPermutation(ids, uniform, rnd), artistOf);
    const spreadRnd = sfc32(seedState(`spread-${i}`));
    const spread = spreadGroups(weightedPermutation(ids, uniform, spreadRnd), artistOf, spreadRnd);
    spreadTotal += adjacentSameGroup(spread, artistOf);
  }
  assert.ok(naiveTotal / runs > 6, `naive=${naiveTotal / runs}`);
  assert.ok(spreadTotal / runs < 2, `spread=${spreadTotal / runs}`);
});

test('a cycle prefers tracks that were not played recently', () => {
  const { ids, artistOf } = makePool(40);
  const recent = ids.slice(0, 10);
  const order = buildCycle({ pool: ids, seed: 5, cycle: 0, recent, groupOf: artistOf, candidates: 5 });
  const early = order.slice(0, 5);
  assert.equal(early.some((id) => recent.includes(id)), false);
});

test('the same recording from different providers collapses to one identity', () => {
  const yt = trackIdentity({ title: 'Midnight City', artist: 'M83', duration: 244 });
  const sc = trackIdentity({ title: 'Midnight City (Remastered)', artist: 'M83 feat. Someone', duration: 244 });
  const other = trackIdentity({ title: 'Midnight City', artist: 'M83', duration: 301 });
  assert.equal(yt, sc);
  assert.notEqual(yt, other);
});

test('release noise is stripped but version meaning is kept', () => {
  const base = trackIdentity({ title: 'Midnight City', artist: 'M83', duration: 244 });
  assert.equal(trackIdentity({ title: 'Midnight City (Remastered 2011)', artist: 'M83', duration: 245 }), base);
  assert.equal(trackIdentity({ title: 'Midnight City [Official Video]', artist: 'M83', duration: 244 }), base);
  assert.notEqual(trackIdentity({ title: 'Midnight City (Part 1)', artist: 'M83', duration: 244 }), trackIdentity({ title: 'Midnight City (Part 2)', artist: 'M83', duration: 244 }));
  assert.notEqual(trackIdentity({ title: 'Midnight City (Live)', artist: 'M83', duration: 244 }), trackIdentity({ title: 'Midnight City (Studio)', artist: 'M83', duration: 244 }));
});

test('providers that disagree by a few seconds still match', () => {
  const yt = trackIdentity({ title: 'Midnight City', artist: 'M83', duration: 244 });
  const sc = trackIdentity({ title: 'Midnight City', artist: 'M83', duration: 247 });
  const longer = trackIdentity({ title: 'Midnight City', artist: 'M83', duration: 301 });
  assert.equal(yt, sc);
  assert.notEqual(yt, longer);
});

test('the boundary head never repeats the track that just played', () => {
  const order = avoidRecentHead(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.notEqual(order[0], 'c');
  assert.deepEqual([...order].sort(), ['a', 'b', 'c']);
});

test('distinct tracks are not merged by identity', () => {
  const a = trackIdentity({ title: 'Song - Part 1', artist: 'Band', duration: 200 });
  const b = trackIdentity({ title: 'Song - Part 2', artist: 'Band', duration: 200 });
  assert.notEqual(a, b);
});

test('the pool drops duplicate recordings but keeps the first occurrence', () => {
  const keys = new Map([
    ['yt:1', 'midnight'],
    ['sc:9', 'midnight'],
    ['yt:2', 'other'],
  ]);
  assert.deepEqual(dedupePool(['yt:1', 'sc:9', 'yt:2'], (id) => keys.get(id)), ['yt:1', 'yt:2']);
});

test('primary artist groups featured collaborations under the lead artist', () => {
  assert.equal(primaryArtist('Erika feat. Someone'), primaryArtist('Erika'));
  assert.equal(primaryArtist('A & B'), primaryArtist('A'));
  assert.notEqual(primaryArtist('Erika'), primaryArtist('Mira Vale'));
});

test('empty, single and two-track pools do not crash', () => {
  const groupOf = (id) => id;
  assert.deepEqual(buildCycle({ pool: [], seed: 1, cycle: 0, recent: [], groupOf }), []);
  assert.deepEqual(buildCycle({ pool: ['only'], seed: 1, cycle: 0, recent: ['only'], groupOf }), ['only']);
  const two = buildCycle({ pool: ['a', 'b'], seed: 1, cycle: 0, recent: ['a'], groupOf });
  assert.deepEqual([...two].sort(), ['a', 'b']);
  assert.notEqual(two[0], 'a');
});

test('a shuffled playlist plays every track once per cycle with no boundary repeat', () => {
  const { ids, artistOf } = makePool(60, 12);
  let queue = [...ids];
  let index = 0;
  const seed = 777;
  let cycle = 0;
  const played = [];
  let recent = [];
  const size = ids.length;
  for (let step = 0; step < size * 5; step++) {
    played.push(queue[index]);
    if (queue.length - 1 - index === 0) {
      const tail = queue.slice(Math.max(0, index + 1 - 8), index + 1);
      recent = [...new Set([...recent, ...tail])].slice(-8);
      cycle += 1;
      queue = [...queue, ...buildCycle({ pool: ids, seed, cycle, recent, groupOf: artistOf })];
    }
    const target = stepQueueIndex({
      queue,
      index,
      dir: 1,
      auto: true,
      repeat: 'all',
      shuffle: true,
      isDisliked: () => false,
      canExtendShuffle: false,
    });
    assert.equal(typeof target, 'number');
    index = target;
  }
  for (let c = 0; c < 5; c++) {
    const pass = played.slice(c * size, (c + 1) * size);
    assert.equal(new Set(pass).size, size, `cycle ${c} repeated a track`);
    if (c > 0) assert.notEqual(pass[0], played[c * size - 1], `cycle ${c} started with the last played track`);
  }
  for (let c = 1; c < 5; c++) {
    assert.deepEqual(played.slice(c * size, (c + 1) * size).sort(), [...ids].sort());
  }
});
