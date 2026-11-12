package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ytDlpSearchParams struct {
	Query string `json:"query"`
}

type ytDlpStreamParams struct {
	VideoID string `json:"videoId"`
}

type ytDlpTrack struct {
	NativeID   string `json:"nativeId"`
	Source     string `json:"source"`
	URN        string `json:"urn"`
	Title      string `json:"title"`
	Permalink  string `json:"permalink"`
	ArtworkURL string `json:"artworkUrl"`
	DurationMs int64  `json:"durationMs"`
	Artist     string `json:"artist"`
}

type ytDlpEntry struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Channel   string  `json:"channel"`
	Uploader  string  `json:"uploader"`
	Duration  float64 `json:"duration"`
	Thumbnail string  `json:"thumbnail"`
}

type ytDlpSearchPage struct {
	Entries []ytDlpEntry `json:"entries"`
}

type ytDlpStreamResult struct {
	URL string `json:"url"`
}

type ytStreamCacheEntry struct {
	url     string
	expires time.Time
}

type ytStreamCall struct {
	done   chan struct{}
	result ytDlpStreamResult
	err    error
}

const (
	ytStreamCacheTTL = 90 * time.Minute
	// Signed googlevideo URLs carry an expire timestamp; stop serving them this long before it.
	ytStreamExpiryMargin = 5 * time.Minute
	ytStreamCacheMax     = 256
	// Direct HTTPS audio only: HLS/DASH manifests can't play in a plain <audio> element.
	ytDlpDirectAudioFormat = "bestaudio[ext=m4a][protocol=https]/bestaudio[ext=webm][protocol=https]/bestaudio[protocol=https]"
)

var (
	ytDlpBinaryMu   sync.Mutex
	ytDlpBinaryPath string
)

func (s *service) RPCYtDlpSearch(params ytDlpSearchParams) ([]ytDlpTrack, error) {
	query := strings.TrimSpace(params.Query)
	if query == "" {
		return nil, errors.New("search query is required")
	}
	if len(query) > 300 {
		return nil, errors.New("search query is too long")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := runYtDlp(ctx, "--ignore-config", "--no-warnings", "--no-progress", "--skip-download", "--flat-playlist", "--socket-timeout", "10", "--extractor-retries", "1", "--dump-single-json", "ytsearch10:"+query)
	if err != nil {
		return nil, err
	}
	return parseYtDlpSearchResults(output)
}

func (s *service) RPCYtDlpStream(params ytDlpStreamParams) (ytDlpStreamResult, error) {
	if !validYouTubeVideoID(params.VideoID) {
		return ytDlpStreamResult{}, errors.New("invalid YouTube video ID")
	}
	if s.ytAudio != nil {
		// Start caching now so audio is ready by the time the browser requests it.
		s.ytAudio.ensureCached(params.VideoID)
		return ytDlpStreamResult{URL: s.ytAudio.streamURL(params.VideoID)}, nil
	}
	// Fallback: direct resolved URL (browser streams from CDN).
	id := params.VideoID
	now := time.Now()
	s.ytStreamMu.Lock()
	if s.ytStreamCache == nil {
		s.ytStreamCache = make(map[string]ytStreamCacheEntry)
	}
	if s.ytStreamCalls == nil {
		s.ytStreamCalls = make(map[string]*ytStreamCall)
	}
	if entry, ok := s.ytStreamCache[id]; ok && now.Before(entry.expires) && entry.url != "" {
		s.ytStreamMu.Unlock()
		return ytDlpStreamResult{URL: entry.url}, nil
	}
	if call, ok := s.ytStreamCalls[id]; ok {
		s.ytStreamMu.Unlock()
		<-call.done
		return call.result, call.err
	}
	call := &ytStreamCall{done: make(chan struct{})}
	s.ytStreamCalls[id] = call
	// A cache clear while resolving bumps the generation; the result is then not stored.
	gen := s.ytStreamGen
	s.ytStreamMu.Unlock()
	result, err := resolveYtDlpStream(id)
	s.ytStreamMu.Lock()
	delete(s.ytStreamCalls, id)
	if err == nil && result.URL != "" && gen == s.ytStreamGen {
		s.storeYtStreamLocked(id, result.URL, time.Now())
	}
	s.ytStreamMu.Unlock()
	call.result = result
	call.err = err
	close(call.done)
	return result, err
}

// storeYtStreamLocked caches a resolved URL until its signed expiry. Caller holds ytStreamMu.
func (s *service) storeYtStreamLocked(id, streamURL string, now time.Time) {
	expires := ytStreamExpiry(streamURL, now)
	if !now.Before(expires) {
		return
	}
	for key, entry := range s.ytStreamCache {
		if !now.Before(entry.expires) {
			delete(s.ytStreamCache, key)
		}
	}
	if _, exists := s.ytStreamCache[id]; !exists && len(s.ytStreamCache) >= ytStreamCacheMax {
		oldestID := ""
		for key, entry := range s.ytStreamCache {
			if oldestID == "" || entry.expires.Before(s.ytStreamCache[oldestID].expires) {
				oldestID = key
			}
		}
		delete(s.ytStreamCache, oldestID)
	}
	s.ytStreamCache[id] = ytStreamCacheEntry{url: streamURL, expires: expires}
}

// ytStreamExpiry returns when a resolved URL must stop being served: the
// googlevideo expire parameter minus a margin, capped at the default TTL.
func ytStreamExpiry(streamURL string, now time.Time) time.Time {
	expires := now.Add(ytStreamCacheTTL)
	if parsed, err := url.Parse(streamURL); err == nil {
		if secs, err := strconv.ParseInt(parsed.Query().Get("expire"), 10, 64); err == nil {
			if signed := time.Unix(secs, 0).Add(-ytStreamExpiryMargin); signed.Before(expires) {
				expires = signed
			}
		}
	}
	return expires
}

func resolveYtDlpStream(videoID string) (ytDlpStreamResult, error) {
	// Must exceed the retries' combined socket timeouts, or yt-dlp is killed before it can retry.
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	videoURL := "https://www.youtube.com/watch?v=" + videoID
	output, err := runYtDlp(ctx,
		"--ignore-config", "--no-warnings", "--no-progress", "--no-playlist",
		"--extractor-retries", "2", "--socket-timeout", "10",
		"--format", ytDlpDirectAudioFormat,
		"--get-url", videoURL,
	)
	if err != nil {
		return ytDlpStreamResult{}, err
	}
	streamURL := strings.TrimSpace(strings.SplitN(string(output), "\n", 2)[0])
	if !validYtDlpAudioURL(streamURL) {
		return ytDlpStreamResult{}, errors.New("yt-dlp did not return a supported audio URL")
	}
	return ytDlpStreamResult{URL: streamURL}, nil
}

func runYtDlp(ctx context.Context, args ...string) ([]byte, error) {
	binary, err := findYtDlp()
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, binary, args...)
	output, err := command.Output()
	if err != nil {
		if isYtDlpMissing(err) {
			forgetYtDlp(binary)
		}
		if ctx.Err() == context.DeadlineExceeded {
			return nil, errors.New("yt-dlp timed out")
		}
		if exit, ok := err.(*exec.ExitError); ok {
			if message := ytDlpErrorDetail(string(exit.Stderr)); message != "" {
				return nil, fmt.Errorf("yt-dlp failed: %s", message)
			}
		}
		return nil, fmt.Errorf("yt-dlp failed: %w", err)
	}
	return output, nil
}

// ytDlpErrorDetail returns the line yt-dlp reports its real failure on (the last
// "ERROR:" line), capped at 500 runes so no UTF-8 sequence is split.
func ytDlpErrorDetail(stderr string) string {
	message := strings.TrimSpace(stderr)
	if i := strings.LastIndex(message, "ERROR:"); i >= 0 {
		message = message[i:]
	}
	if runes := []rune(message); len(runes) > 500 {
		message = string(runes[:500])
	}
	return message
}

func isYtDlpMissing(err error) bool {
	return errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist)
}

// findYtDlp returns the cached yt-dlp path, probing only until one is found.
func findYtDlp() (string, error) {
	ytDlpBinaryMu.Lock()
	defer ytDlpBinaryMu.Unlock()
	if ytDlpBinaryPath != "" {
		return ytDlpBinaryPath, nil
	}
	binary, err := probeYtDlp()
	if err != nil {
		return "", err
	}
	ytDlpBinaryPath = binary
	return binary, nil
}

// forgetYtDlp drops a cached path that no longer exists so the next call re-probes.
func forgetYtDlp(binary string) {
	ytDlpBinaryMu.Lock()
	defer ytDlpBinaryMu.Unlock()
	if ytDlpBinaryPath == binary {
		ytDlpBinaryPath = ""
	}
}

func probeYtDlp() (string, error) {
	if binary, err := exec.LookPath("yt-dlp"); err == nil {
		return binary, nil
	}
	// GUI/sidecar launches often lack the shell PATH, so check common install dirs too.
	dirs := []string{"/opt/homebrew/bin", "/usr/local/bin"}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"))
	}
	for _, dir := range dirs {
		for _, name := range []string{"yt-dlp", "yt-dlp.exe"} {
			candidate := filepath.Join(dir, name)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
				return candidate, nil
			}
		}
	}
	return "", errors.New("yt-dlp was not found; install it and make sure it is available in PATH")
}

func parseYtDlpSearchResults(data []byte) ([]ytDlpTrack, error) {
	var page ytDlpSearchPage
	if err := json.Unmarshal(data, &page); err != nil {
		return nil, fmt.Errorf("could not parse yt-dlp search results: %w", err)
	}
	tracks := make([]ytDlpTrack, 0, len(page.Entries))
	for _, entry := range page.Entries {
		// Zero duration means a live stream or premiere, which the direct audio path can't play.
		if !validYouTubeVideoID(entry.ID) || strings.TrimSpace(entry.Title) == "" || entry.Duration <= 0 {
			continue
		}
		artist := strings.TrimSpace(entry.Channel)
		if artist == "" {
			artist = strings.TrimSpace(entry.Uploader)
		}
		if artist == "" {
			artist = "YouTube"
		}
		thumbnail := strings.TrimSpace(entry.Thumbnail)
		if thumbnail == "" {
			thumbnail = "https://i.ytimg.com/vi/" + entry.ID + "/hqdefault.jpg"
		}
		tracks = append(tracks, ytDlpTrack{
			NativeID: entry.ID, Source: "youtube", URN: entry.ID, Title: strings.TrimSpace(entry.Title),
			Permalink:  "https://music.youtube.com/watch?v=" + url.QueryEscape(entry.ID),
			ArtworkURL: thumbnail, DurationMs: int64(entry.Duration * 1000), Artist: artist,
		})
	}
	return tracks, nil
}

func validYouTubeVideoID(value string) bool {
	if len(value) != 11 {
		return false
	}
	for _, char := range value {
		if !(char >= 'A' && char <= 'Z') && !(char >= 'a' && char <= 'z') && !(char >= '0' && char <= '9') && char != '_' && char != '-' {
			return false
		}
	}
	return true
}

func validYtDlpAudioURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "googlevideo.com" || strings.HasSuffix(host, ".googlevideo.com")
}
