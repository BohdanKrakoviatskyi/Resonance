import assert from 'node:assert/strict';
import test from 'node:test';
import { isViewTransitionBlurSafe } from './view-transition.ts';

test('uses the live transition fallback for a WKWebView user agent without a Safari token', () => {
  assert.equal(
    isViewTransitionBlurSafe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'),
    false,
  );
});

test('uses the live transition fallback for Safari, which loses backdrop blur in snapshots', () => {
  assert.equal(
    isViewTransitionBlurSafe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'),
    false,
  );
});

test('uses the live transition fallback for iOS Chrome, which still runs on WebKit', () => {
  assert.equal(
    isViewTransitionBlurSafe('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1'),
    false,
  );
});

test('keeps view transitions enabled in desktop Chromium browsers', () => {
  assert.equal(
    isViewTransitionBlurSafe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
    true,
  );
});
