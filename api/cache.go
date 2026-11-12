package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// cacheClearResult reports how much cached data was removed. User data —
// accounts, playlists, library, settings — is never touched.
type cacheClearResult struct {
	AudioFilesDeleted    int   `json:"audioFilesDeleted"`
	AudioBytesFreed      int64 `json:"audioBytesFreed"`
	LyricsEntriesCleared int   `json:"lyricsEntriesCleared"`
	StreamEntriesCleared int   `json:"streamEntriesCleared"`
}

// RPCCacheClear deletes every cache: the on-disk yt audio cache (music),
// the in-memory lyrics and stream-URL caches.
func (s *service) RPCCacheClear(_ emptyParams) (cacheClearResult, error) {
	result := cacheClearResult{}

	s.lyricsMu.Lock()
	result.LyricsEntriesCleared = len(s.lyricsCache)
	s.lyricsCache = make(map[int64]cachedLyrics)
	s.lyricsMu.Unlock()

	s.ytStreamMu.Lock()
	result.StreamEntriesCleared = len(s.ytStreamCache)
	s.ytStreamCache = make(map[string]ytStreamCacheEntry)
	s.ytStreamGen++
	s.ytStreamMu.Unlock()

	if s.ytAudio != nil {
		deleted, bytesFreed, err := s.ytAudio.clear()
		if err != nil {
			return result, fmt.Errorf("clear audio cache: %w", err)
		}
		result.AudioFilesDeleted = deleted
		result.AudioBytesFreed = bytesFreed
	}

	log.Printf("cache.clear audio_files=%d audio_bytes=%d lyrics=%d streams=%d", result.AudioFilesDeleted, result.AudioBytesFreed, result.LyricsEntriesCleared, result.StreamEntriesCleared)
	return result, nil
}

// clear removes every cached audio file (and its .done marker) from the
// cache directory. Files belonging to in-flight downloads are skipped, since
// they are open or still being written (and can't be removed on Windows).
// Removal is best effort: a file that can't be removed is skipped.
func (m *ytAudioManager) clear() (int, int64, error) {
	// Held for the whole pass so no download can register between the
	// active check and the removal (acquire takes the same lock).
	m.mu.Lock()
	defer m.mu.Unlock()
	entries, err := os.ReadDir(m.cacheDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, err
	}
	deleted := 0
	var bytesFreed int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		// Cache files are "<videoID>.<ext>" (and .done/.meta siblings); video IDs contain no dots.
		id, _, _ := strings.Cut(e.Name(), ".")
		if _, busy := m.active[id]; busy {
			continue
		}
		path := filepath.Join(m.cacheDir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}
		if err := os.Remove(path); err != nil {
			log.Printf("cache.clear skip %s: %v", e.Name(), err)
			continue
		}
		deleted++
		bytesFreed += info.Size()
	}
	return deleted, bytesFreed, nil
}
