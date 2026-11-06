package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	ytAudioCacheMaxBytes = 3 << 30 // 3 GiB
	ytAudioTokenBytes    = 16
)

type ytAudioManager struct {
	mu       sync.Mutex
	cacheDir string
	port     int
	token    string
	client   *http.Client
	active   map[string]*ytAudioActive
}

// ytAudioActive is one in-flight download plus everything a reader needs to
// follow the growing file. Readers do not wait for the whole download: they
// block only until the bytes they asked for have been written, which lets a
// seek mid-download resume from the requested offset.
type ytAudioActive struct {
	done chan struct{}

	mu          sync.Mutex
	changed     chan struct{} // closed and replaced on every state change
	size        int64         // bytes written so far
	total       int64         // expected final size, 0 when unknown
	path        string
	contentType string
	metaKnown   bool
	finished    bool
	err         error
}

func newYTAudioActive() *ytAudioActive {
	return &ytAudioActive{
		done:    make(chan struct{}),
		changed: make(chan struct{}),
	}
}

func (a *ytAudioActive) notifyLocked() {
	close(a.changed)
	a.changed = make(chan struct{})
}

func (a *ytAudioActive) setMeta(total int64) {
	a.mu.Lock()
	if total > 0 {
		a.total = total
	}
	a.metaKnown = true
	a.notifyLocked()
	a.mu.Unlock()
}

func (a *ytAudioActive) setContentType(path, contentType string) {
	a.mu.Lock()
	a.path = path
	a.contentType = contentType
	a.notifyLocked()
	a.mu.Unlock()
}

func (a *ytAudioActive) addSize(n int64) {
	a.mu.Lock()
	a.size += n
	a.notifyLocked()
	a.mu.Unlock()
}

func (a *ytAudioActive) finish(err error) {
	a.mu.Lock()
	a.err = err
	a.finished = true
	a.notifyLocked()
	a.mu.Unlock()
	close(a.done)
}

// waitReady blocks until the first audio chunk has been sniffed (so the
// container type and the intended total size are known), or the download ends.
func (a *ytAudioActive) waitReady(ctx context.Context) bool {
	for {
		a.mu.Lock()
		ready := (a.metaKnown && a.path != "" && a.contentType != "") || a.finished
		changed := a.changed
		a.mu.Unlock()
		if ready {
			return true
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return false
		}
	}
}

func newYTAudioManager(cacheDir string, client *http.Client) *ytAudioManager {
	token := randomHex(ytAudioTokenBytes)
	return &ytAudioManager{
		cacheDir: cacheDir,
		token:    token,
		client:   client,
		active:   make(map[string]*ytAudioActive),
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (m *ytAudioManager) start() error {
	if err := os.MkdirAll(m.cacheDir, 0o700); err != nil {
		return fmt.Errorf("create yt audio cache: %w", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen yt audio server: %w", err)
	}
	m.port = ln.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	mux.HandleFunc("/yt-audio/", m.handleAudio)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("yt audio server stopped: %v", err)
		}
	}()
	log.Printf("yt audio cache server listening on 127.0.0.1:%d dir=%q", m.port, m.cacheDir)
	return nil
}

func (m *ytAudioManager) streamURL(videoID string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/yt-audio/%s?t=%s", m.port, videoID, m.token)
}

// ensureCached starts a background download to the on-disk cache if needed.
// It is safe to call repeatedly; in-flight and completed downloads are deduped.
func (m *ytAudioManager) ensureCached(videoID string) {
	if !validYouTubeVideoID(videoID) {
		return
	}
	m.acquire(videoID)
}

// acquire returns the active download for id, starting one if needed, or nil
// when the file is already fully cached.
func (m *ytAudioManager) acquire(videoID string) *ytAudioActive {
	if _, ok := m.cachedPath(videoID); ok {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Re-check under the lock: two callers can both miss the fast path above.
	if _, ok := m.cachedPath(videoID); ok {
		return nil
	}
	if active, ok := m.active[videoID]; ok {
		return active
	}
	active := newYTAudioActive()
	m.active[videoID] = active
	go func() {
		err := m.downloadToCache(videoID, active)
		m.mu.Lock()
		delete(m.active, videoID)
		m.mu.Unlock()
		active.finish(err)
		if err != nil {
			log.Printf("yt audio download error id=%s: %v", videoID, err)
			active.mu.Lock()
			path := active.path
			active.mu.Unlock()
			if path != "" {
				// Leave no partial file behind for cachedPath to trip over.
				_ = os.Remove(path)
			}
		}
	}()
	return active
}

func (m *ytAudioManager) cachedPath(videoID string) (string, bool) {
	// A file counts only with its .done marker, so a truncated download
	// (>64 KB but incomplete) is not mistaken for a complete cache.
	for _, ext := range []string{".m4a", ".webm", ".opus", ".mp3", ".ogg"} {
		path := filepath.Join(m.cacheDir, videoID+ext)
		if _, err := os.Stat(path + ".done"); err != nil {
			continue
		}
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Size() > 64*1024 {
			return path, true
		}
	}
	return "", false
}

func (m *ytAudioManager) serveCached(w http.ResponseWriter, r *http.Request, path string) {
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, path)
}

func (m *ytAudioManager) handleAudio(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("t") != m.token {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/yt-audio/")
	if !validYouTubeVideoID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	if path, ok := m.cachedPath(id); ok {
		m.serveCached(w, r, path)
		return
	}

	// Prefetch probe: start caching in background without tying up this request.
	if r.URL.Query().Get("prefetch") == "1" {
		m.ensureCached(id)
		w.WriteHeader(http.StatusAccepted)
		return
	}

	active := m.acquire(id)
	if active == nil {
		if path, ok := m.cachedPath(id); ok {
			m.serveCached(w, r, path)
			return
		}
		http.Error(w, "audio unavailable", http.StatusInternalServerError)
		return
	}
	if !active.waitReady(r.Context()) {
		return
	}

	active.mu.Lock()
	total, path, contentType := active.total, active.path, active.contentType
	finished, err := active.finished, active.err
	active.mu.Unlock()
	if path == "" || contentType == "" {
		http.Error(w, "audio stream unavailable", http.StatusBadGateway)
		return
	}

	// Without a known final size a Range response cannot be honest, so wait
	// for the download to finish and let ServeFile answer with its real size.
	if total <= 0 {
		if !finished {
			select {
			case <-active.done:
			case <-r.Context().Done():
				return
			}
		}
		if cached, ok := m.cachedPath(id); ok {
			m.serveCached(w, r, cached)
			return
		}
		http.Error(w, "audio stream unavailable", http.StatusBadGateway)
		return
	}
	if finished && err != nil {
		http.Error(w, "audio stream unavailable", http.StatusBadGateway)
		return
	}

	file, openErr := os.Open(path)
	if openErr != nil {
		// The download may have completed and finalized between the checks.
		if cached, ok := m.cachedPath(id); ok {
			m.serveCached(w, r, cached)
			return
		}
		http.Error(w, "audio stream unavailable", http.StatusBadGateway)
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// ServeContent implements Range/If-Range/416, but asks the reader for its
	// final size. growingFile answers with the size yt-dlp reported, then
	// blocks reads until the on-disk file has caught up.
	http.ServeContent(w, r, "", time.Time{}, &ytGrowingFile{file: file, active: active, ctx: r.Context()})
}

// ytGrowingFile is an io.ReadSeeker over a file that another goroutine is
// still appending to. Read waits for the requested offset to be written.
type ytGrowingFile struct {
	file   *os.File
	active *ytAudioActive
	ctx    context.Context
	pos    int64
}

func (g *ytGrowingFile) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
		g.pos = offset
	case io.SeekCurrent:
		g.pos += offset
	case io.SeekEnd:
		g.active.mu.Lock()
		total := g.active.total
		g.active.mu.Unlock()
		g.pos = total + offset
	default:
		return 0, errors.New("invalid whence")
	}
	if g.pos < 0 {
		return 0, errors.New("negative seek position")
	}
	return g.pos, nil
}

func (g *ytGrowingFile) Read(p []byte) (int, error) {
	for {
		g.active.mu.Lock()
		size, total := g.active.size, g.active.total
		finished, err := g.active.finished, g.active.err
		changed := g.active.changed
		g.active.mu.Unlock()

		if total > 0 && g.pos >= total {
			return 0, io.EOF
		}
		if g.pos < size {
			want := int64(len(p))
			if size-g.pos < want {
				want = size - g.pos
			}
			if total > 0 && total-g.pos < want {
				want = total - g.pos
			}
			read, readErr := g.file.ReadAt(p[:int(want)], g.pos)
			g.pos += int64(read)
			if read > 0 {
				return read, nil
			}
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return 0, readErr
			}
		}
		if finished {
			if err != nil {
				return 0, err
			}
			return 0, io.EOF
		}
		select {
		case <-changed:
		case <-g.ctx.Done():
			return 0, g.ctx.Err()
		}
	}
}

func sniffAudioType(chunk []byte) (ext, contentType string) {
	if len(chunk) >= 12 && chunk[4] == 'f' && chunk[5] == 't' && chunk[6] == 'y' && chunk[7] == 'p' {
		return ".m4a", "audio/mp4"
	}
	if len(chunk) >= 4 && chunk[0] == 0x1a && chunk[1] == 0x45 && chunk[2] == 0xdf && chunk[3] == 0xa3 {
		return ".webm", "audio/webm"
	}
	if len(chunk) >= 4 && string(chunk[:4]) == "OggS" {
		return ".ogg", "audio/ogg"
	}
	if len(chunk) >= 3 && string(chunk[:3]) == "ID3" {
		return ".mp3", "audio/mpeg"
	}
	if len(chunk) >= 2 && chunk[0] == 0xff && (chunk[1]&0xe0) == 0xe0 {
		return ".mp3", "audio/mpeg"
	}
	return ".m4a", "audio/mp4"
}

// readYtDlpSize parses the byte count yt-dlp writes before downloading. The
// file appears before the first media byte, so a short retry is enough.
func readYtDlpSize(path string) int64 {
	for attempt := 0; attempt < 20; attempt++ {
		if data, err := os.ReadFile(path); err == nil {
			text := strings.TrimSpace(string(data))
			if text != "" {
				total, err := strconv.ParseInt(text, 10, 64)
				if err == nil && total > 0 {
					return total
				}
				return 0
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return 0
}

func (m *ytAudioManager) downloadToCache(id string, active *ytAudioActive) error {
	binary, err := findYtDlp()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(m.cacheDir, 0o700); err != nil {
		return err
	}
	m.enforceCacheLimit(0)

	metaPath := filepath.Join(m.cacheDir, id+"."+randomHex(8)+".meta")
	defer os.Remove(metaPath)

	// Background context so client disconnects don't kill caching.
	dlCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	videoURL := "https://www.youtube.com/watch?v=" + id
	cmd := exec.CommandContext(dlCtx, binary,
		"--no-warnings", "--no-progress", "--no-playlist",
		"--extractor-retries", "2", "--socket-timeout", "15",
		"--no-simulate", "--print-to-file", "%(filesize)s", metaPath,
		"--format", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
		"-o", "-",
		videoURL,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf
	if err := cmd.Start(); err != nil {
		return err
	}

	var file *os.File
	var path string
	fileClosed := false
	closeFile := func() {
		if file != nil && !fileClosed {
			fileClosed = true
			_ = file.Sync()
			_ = file.Close()
		}
	}
	defer closeFile()

	buf := make([]byte, 32*1024)
	var total int64
	for {
		n, readErr := stdout.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if file == nil {
				total = readYtDlpSize(metaPath)
				active.setMeta(total)
				ext, contentType := sniffAudioType(chunk)
				path = filepath.Join(m.cacheDir, id+ext)
				file, err = os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
				if err != nil {
					return err
				}
				active.setContentType(path, contentType)
			}
			if _, werr := file.Write(chunk); werr != nil {
				return fmt.Errorf("write cache file: %w", werr)
			}
			active.addSize(int64(n))
		}
		if readErr != nil {
			break
		}
	}

	waitErr := cmd.Wait()
	if waitErr != nil {
		msg := strings.TrimSpace(stderrBuf.String())
		if len(msg) > 400 {
			msg = msg[:400]
		}
		if msg != "" {
			return fmt.Errorf("yt-dlp: %s", msg)
		}
		return fmt.Errorf("yt-dlp: %w", waitErr)
	}

	active.mu.Lock()
	written := active.size
	active.mu.Unlock()
	if written < 64*1024 {
		return errors.New("yt-dlp produced too little audio data")
	}
	if total > 0 && written != total {
		// The stream is still usable; only a reader that was promised the
		// reported length would stop early. Record it so the cause is obvious.
		log.Printf("yt audio size mismatch id=%s expected=%d actual=%d", id, total, written)
	}

	closeFile()
	_ = os.Chtimes(path, time.Now(), time.Now())
	// Marker so a truncated file is never mistaken for a complete cache.
	if err := os.WriteFile(path+".done", []byte("ok"), 0o600); err != nil {
		return fmt.Errorf("mark cache complete: %w", err)
	}
	m.enforceCacheLimit(0)
	return nil
}

func (m *ytAudioManager) enforceCacheLimit(extra int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entries, err := os.ReadDir(m.cacheDir)
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	var items []item
	var total int64
	for _, e := range entries {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".part") || strings.HasSuffix(e.Name(), ".done") || strings.HasSuffix(e.Name(), ".meta") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, item{path: filepath.Join(m.cacheDir, e.Name()), size: info.Size(), mod: info.ModTime()})
		total += info.Size()
	}
	target := int64(ytAudioCacheMaxBytes) - extra
	if total <= target {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items {
		if total <= target {
			break
		}
		if err := os.Remove(it.path); err == nil {
			total -= it.size
		}
	}
}
