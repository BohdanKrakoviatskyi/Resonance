export function isWebKitPlaybackUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const isWebKit = ua.includes('applewebkit');
  const isChromium = /chrome|chromium|edg\//.test(ua);
  const isIOSWebKit = /iphone|ipad|ipod|crios|fxios|edgios/.test(ua);

  return isWebKit && (!isChromium || isIOSWebKit);
}

export function webkitDoubledDuration(trackDuration: number, elementDuration: number): number | null {
  if (!Number.isFinite(elementDuration) || elementDuration <= 0 || !Number.isFinite(trackDuration) || trackDuration < 30) return null;
  return elementDuration >= trackDuration * 1.7 && elementDuration <= trackDuration * 2.35 ? trackDuration : null;
}
