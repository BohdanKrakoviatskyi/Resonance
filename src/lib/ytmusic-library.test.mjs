import test from 'node:test';
import assert from 'node:assert/strict';
import { mapYtMusicTrack, mapYtMusicTracks, parseYtMusicCollectionId, upscaleYtmArtwork, ytmusicPlaylistId } from './ytmusic-library.ts';

test('maps YouTube Music metadata to the existing direct-playback track model', () => {
  assert.deepEqual(mapYtMusicTrack({
    videoId: 'abc123', title: 'Song', artists: ['One', 'Two'], artist: 'One, Two',
    artworkUrl: 'https://img.test/cover.jpg', durationSeconds: 123, available: true,
  }), {
    id: 'yt:abc123', title: 'Song', artist: 'One, Two', cover: 'https://img.test/cover.jpg',
    thumb: 'https://img.test/cover.jpg', src: 'https://music.youtube.com/watch?v=abc123',
    duration: 123, fullDuration: 123, nativeId: 'abc123', playback: 'direct', source: 'youtube',
  });
});

test('drops invalid video IDs and deduplicates tracks while preserving order', () => {
  const tracks = mapYtMusicTracks([
    { videoId: 'a', title: 'First', artist: 'Artist' },
    { videoId: '', title: 'Missing' },
    { videoId: 'a', title: 'Duplicate' },
    { videoId: 'b', title: 'Second' },
  ]);
  assert.deepEqual(tracks.map((track) => track.id), ['yt:a', 'yt:b']);
  assert.equal(ytmusicPlaylistId('PL1'), 'ytpl:PL1');
});

test('preserves duplicate video occurrences in provider playlists for exact removal', () => {
  const tracks = mapYtMusicTracks([
    { videoId: 'same', title: 'First', setVideoId: 'item-1' },
    { videoId: 'same', title: 'Second', setVideoId: 'item-2' },
  ], true);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((track) => track.setVideoId), ['item-1', 'item-2']);
  assert.notEqual(tracks[0].id, tracks[1].id);
  assert.deepEqual(mapYtMusicTracks([
    { videoId: 'same', title: 'First', setVideoId: 'item-1' },
    { videoId: 'same', title: 'Second', setVideoId: 'item-2' },
  ]).map((track) => track.id), ['yt:same']);
});

test('parses provider collection IDs without accepting local or SoundCloud IDs', () => {
  assert.deepEqual(parseYtMusicCollectionId('ytpl:PL1'), { kind: 'playlist', playlistId: 'PL1' });
  assert.deepEqual(parseYtMusicCollectionId('ytliked'), { kind: 'liked' });
  assert.equal(parseYtMusicCollectionId('ytsaved'), null);
  assert.equal(parseYtMusicCollectionId('scpl:1'), null);
  assert.equal(parseYtMusicCollectionId('local-id'), null);
  assert.equal(parseYtMusicCollectionId('ytpl:'), null);
});

test('upscales small YouTube Music artwork to the 544px crop', () => {
  assert.equal(
    upscaleYtmArtwork('https://lh3.googleusercontent.com/x=w120-h120-l90-rj'),
    'https://lh3.googleusercontent.com/x=w544-h544-l90-rj',
  );
  assert.equal(
    upscaleYtmArtwork('https://lh3.googleusercontent.com/x=w544-h544-l90-rj'),
    'https://lh3.googleusercontent.com/x=w544-h544-l90-rj',
  );
  assert.equal(
    upscaleYtmArtwork('https://i.ytimg.com/vi/x/hqdefault.jpg'),
    'https://i.ytimg.com/vi/x/hqdefault.jpg',
  );
  assert.equal(upscaleYtmArtwork(undefined), undefined);
  assert.equal(upscaleYtmArtwork(null), undefined);
});
