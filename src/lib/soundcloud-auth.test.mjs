import assert from 'node:assert/strict';
import test from 'node:test';
import { isSoundCloudAuthError } from './soundcloud-auth.ts';

test('recognises the backend session errors as auth failures', () => {
  assert.equal(isSoundCloudAuthError(new Error('soundcloud_session_expired: SoundCloud: сессия истекла — войдите заново')), true);
  assert.equal(isSoundCloudAuthError(new Error('сначала подключите аккаунт SoundCloud')), true);
  assert.equal(isSoundCloudAuthError('сначала подключите аккаунт SoundCloud'), true);
});

test('leaves every other SoundCloud failure alone', () => {
  assert.equal(isSoundCloudAuthError(new Error('SoundCloud вернул ошибку HTTP 500')), false);
  assert.equal(isSoundCloudAuthError(new Error('SoundCloud временно ограничил запросы (HTTP 429), повторите позже')), false);
  assert.equal(isSoundCloudAuthError(new Error('не удалось получить ни один доступный поток SoundCloud')), false);
  assert.equal(isSoundCloudAuthError(undefined), false);
  assert.equal(isSoundCloudAuthError(null), false);
  assert.equal(isSoundCloudAuthError({ message: undefined }), false);
});
