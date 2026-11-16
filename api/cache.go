package main

import (
	"log"
)

// cacheClearResult reports how much cached data was removed. User data —
// accounts, playlists, library, settings — is never touched.
type cacheClearResult struct {
	AudioFilesDeleted    int   `json:"audioFilesDeleted"`
	AudioBytesFreed      int64 `json:"audioBytesFreed"`
	LyricsEntriesCleared int   `json:"lyricsEntriesCleared"`
	StreamEntriesCleared int   `json:"streamEntriesCleared"`
}

// RPCCacheClear clears the Go sidecar's in-memory lyrics cache; YouTube audio and
// stream-URL caches are cleared directly by the Rust YouTube engine.
func (s *service) RPCCacheClear(_ emptyParams) (cacheClearResult, error) {
	result := cacheClearResult{}

	s.lyricsMu.Lock()
	result.LyricsEntriesCleared = len(s.lyricsCache)
	s.lyricsCache = make(map[int64]cachedLyrics)
	s.lyricsMu.Unlock()

	log.Printf("cache.clear lyrics=%d", result.LyricsEntriesCleared)
	return result, nil
}
