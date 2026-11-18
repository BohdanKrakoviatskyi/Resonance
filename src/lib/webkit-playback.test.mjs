import assert from 'node:assert/strict';
import test from 'node:test';
import { isWebKitPlaybackUserAgent, webkitDoubledDuration } from './webkit-playback.ts';

test('recognizes macOS WKWebView without a Safari user-agent token', () => {
  assert.equal(
    isWebKitPlaybackUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'),
    true,
  );
});

test('recognizes Safari and iOS browsers that use WebKit', () => {
  assert.equal(
    isWebKitPlaybackUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'),
    true,
  );
  assert.equal(
    isWebKitPlaybackUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1'),
    true,
  );
});

test('detects a doubled WebKit media duration against YouTube Music metadata', () => {
  assert.equal(webkitDoubledDuration(174, 347.35600907029476), 174);
  assert.equal(webkitDoubledDuration(174, 173.9), null);
});

test('does not classify desktop Chromium as WebKit playback', () => {
  assert.equal(
    isWebKitPlaybackUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
    false,
  );
});
