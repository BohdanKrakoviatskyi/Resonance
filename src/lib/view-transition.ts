/** WebKit snapshots drop backdrop-filter; iOS browsers also use WebKit despite Chromium tokens. */
export function isViewTransitionBlurSafe(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const isWebKit = ua.includes('applewebkit');
  const isChromium = /chrome|chromium|edg\//.test(ua);
  const isIOSWebKit = /iphone|ipad|ipod|crios|fxios|edgios/.test(ua);

  return !isWebKit || (isChromium && !isIOSWebKit);
}
