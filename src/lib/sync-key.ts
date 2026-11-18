/** Loose identity of a song across services: case, punctuation and "feat." noise ignored. */
export function syncKey(title: string, artist: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\((?:feat|ft)\.?[^)]*\)|\[(?:feat|ft)\.?[^\]]*\]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const firstArtist = artist.split(/,|&| x | feat\.? | ft\.? /i)[0] ?? artist;
  return `${norm(firstArtist)}|${norm(title)}`;
}
