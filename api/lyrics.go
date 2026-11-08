package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Lyrics RPC types live beside the provider/matching code so the main sidecar stays focused on
// RPC dispatch and SoundCloud operations.
type trackLyricsParams struct {
	TrackID    int64  `json:"trackId"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	DurationMs int64  `json:"durationMs"`
}

type trackLyrics struct {
	TrackID   int64        `json:"trackId"`
	Lines     []lyricsLine `json:"lines"`
	SourceURL string       `json:"sourceUrl,omitempty"`
	IsSynced  bool         `json:"isSynced,omitempty"`
	Logs      []string     `json:"logs,omitempty"`
}

type lyricsLine struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	StartMs int64  `json:"startMs"`
}

type lrclibRecord struct {
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
	Duration     float64 `json:"duration"`
	SyncedLyrics string  `json:"syncedLyrics"`
	PlainLyrics  string  `json:"plainLyrics"`
	Instrumental bool    `json:"instrumental"`
}

type deezerTrack struct {
	Title    string `json:"title"`
	Duration int64  `json:"duration"`
	Artist   struct {
		Name string `json:"name"`
	} `json:"artist"`
}

type lyricsQuery struct {
	Title, Artist string
	Duration      int64
}

const lyricsUserAgent = "Resonance/0.1.0 (lyrics sidebar)"

var (
	lyricsNoisePatterns = []*regexp.Regexp{
		regexp.MustCompile(`\[[^\]]*\]`),
		regexp.MustCompile(`\([^)]*\)`),
		regexp.MustCompile(`#\S+`),
		regexp.MustCompile(`\+\S+`),
		regexp.MustCompile(`https?://\S+`),
		regexp.MustCompile(`(?i)\b(?:prod|tgk|tg|vk|inst|sc|by)\.?\s*[:.]?\s*[\p{L}\p{N}_.@/-]+`),
		regexp.MustCompile(`(?i)\b(?:ft|feat|featuring|with)\.?\s+[\p{L}\p{N}&,'’. -]+`),
	}
	lyricsVersionWords = []string{
		"slowed", "sped up", "speed up", "reverb", "bass boosted", "remix", "edit", "flip",
		"mashup", "slow version", "rework", "re-work", "bootleg", "vip", "nightcore", "8d",
		"reversed", "acapella", "capella", "spedup", "slowedit", "alt ver", "alt version",
	}
	lyricsDashParts = regexp.MustCompile(`\s+[-–—]\s+`)
)

// RPCTrackLyrics finds a canonical catalog record first, then falls back to direct LRCLIB search.
// It returns an empty line slice for a real miss; transport/provider errors stay in the logs.
func (s *service) RPCTrackLyrics(params trackLyricsParams) (trackLyrics, error) {
	if params.TrackID <= 0 || strings.TrimSpace(params.Title) == "" {
		return trackLyrics{}, errors.New("некорректные данные трека")
	}
	if s.httpClient == nil {
		return trackLyrics{}, errors.New("сервис поиска текста песни недоступен")
	}

	s.lyricsMu.RLock()
	if s.lyricsCache != nil {
		if cached, ok := s.lyricsCache[params.TrackID]; ok {
			// Найденный текст отдаём всегда: он не перестанет быть верным.
			// Промах — только пока не истекли пять минут, иначе трек останется пустым до конца сессии.
			if len(cached.lyrics.Lines) > 0 || time.Since(cached.cachedAt) < 5*time.Minute {
				s.lyricsMu.RUnlock()
				return cached.lyrics, nil
			}
		}
	}
	s.lyricsMu.RUnlock()
	saveCache := func(lyrics trackLyrics) trackLyrics {
		s.lyricsMu.Lock()
		if s.lyricsCache == nil {
			s.lyricsCache = make(map[int64]cachedLyrics)
		}
		s.lyricsCache[lyrics.TrackID] = cachedLyrics{
			lyrics:   lyrics,
			cachedAt: time.Now(),
		}
		s.lyricsMu.Unlock()
		return lyrics
	}
	logs := []string{"Старт поиска текста: " + params.Title + " — " + params.Artist}
	canonical, canonicalFound := s.resolveLyricsTrack(params, &logs)
	if canonicalFound {
		logs = append(logs, fmt.Sprintf("Deezer выбрал: %s — %s", canonical.Artist, canonical.Title))
		if lyrics, found := s.findLyricsForQuery(params, canonical, &logs); found {
			lyrics.Logs = logs
			return saveCache(lyrics), nil
		}
	} else {
		logs = append(logs, "Deezer не подтвердил подходящую запись; пробую исходные название и исполнителя")
	}
	if lyrics, found := s.findLyricsByVariants(params, &logs); found {
		lyrics.Logs = logs
		return saveCache(lyrics), nil
	}
	logs = append(logs, "Текст не найден: LRCLIB не вернул подходящих синхронизированных или обычных лирик")
	return saveCache(trackLyrics{TrackID: params.TrackID, Lines: []lyricsLine{}, Logs: logs}), nil
}

// lyricsDegenerateOverlap is the point at which a title and an artist are the same words, which
// makes the pair useless as a search: track_name=BATO&artist_name=BATO finds nothing useful.
//
// Kept at 0.75 and shared by both query builders. At 0.6 the pair ("BATO - Miura", "Miura")
// scores 0.65 and would be dropped, which loses a legitimate query without preventing the defect
// this was added for.
const lyricsDegenerateOverlap = 0.75

func lyricsDegenerateQueryPair(title, artist string) bool {
	return lyricsTokenOverlap(title, artist) >= lyricsDegenerateOverlap
}

func (s *service) resolveLyricsTrack(params trackLyricsParams, logs *[]string) (lyricsQuery, bool) {
	cleaned := stripLyricsNoise(params.Title)
	base := stripLyricsVersionMarkers(cleaned)
	if base == "" {
		base = cleaned
	}
	titles := lyricsTitleVariants(base)
	artists := lyricsArtistHints(params, base)
	queries := append([]string(nil), titles...)
	for _, title := range titles {
		for _, artist := range artists {
			if lyricsDegenerateQueryPair(title, artist) {
				continue
			}
			queries = appendUniqueFold(queries, title+" "+artist)
		}
	}
	if len(queries) > 8 {
		queries = queries[:8]
	}

	var best *scoredDeezerTrack
	seen := map[string]bool{}
	searchCount, candidateCount, errorCount := 0, 0, 0
	for _, query := range queries {
		searchCount++
		candidates, err := s.searchDeezer(query)
		if err != nil {
			errorCount++
			continue
		}
		candidateCount += len(candidates)
		for _, candidate := range candidates {
			key := strings.ToLower(candidate.Artist.Name + "\x00" + candidate.Title)
			if seen[key] {
				continue
			}
			seen[key] = true
			score, ok := scoreDeezerCandidate(params, candidate, titles, artists)
			if !ok {
				continue
			}
			if best == nil || score.rank > best.score.rank {
				best = &scoredDeezerTrack{track: candidate, score: score}
			}
		}
		if best != nil && best.score.rank >= 0.9 && best.score.artist >= 0.45 {
			break
		}
	}
	*logs = append(*logs, fmt.Sprintf("Deezer: запросов %d, найдено кандидатов %d, ошибок %d", searchCount, candidateCount, errorCount))
	if best == nil {
		return lyricsQuery{}, false
	}
	return lyricsQuery{Title: best.track.Title, Artist: best.track.Artist.Name, Duration: best.track.Duration}, true
}

type candidateScore struct {
	rank, title, artist, duration float64
}

type scoredDeezerTrack struct {
	track deezerTrack
	score candidateScore
}

func scoreDeezerCandidate(params trackLyricsParams, candidate deezerTrack, titles, artists []string) (candidateScore, bool) {
	bestTitle, bestTitleScore := "", 0.0
	for _, title := range titles {
		score := lyricsTokenOverlap(title, candidate.Title)
		if score > bestTitleScore {
			bestTitle, bestTitleScore = title, score
		}
	}
	if bestTitleScore < 0.72 {
		return candidateScore{}, false
	}

	artistScore := 0.0
	for _, artist := range artists {
		artistScore = math.Max(artistScore, lyricsTokenOverlap(artist, candidate.Artist.Name))
	}
	specificity := lyricsTitleSpecificity(bestTitle)
	wantSec := (params.DurationMs + 500) / 1000
	deltaSec := math.Abs(float64(wantSec - candidate.Duration))
	hasVersion := lyricsHasVersionMarker(params.Title)

	if wantSec > 0 && candidate.Duration > 0 && !hasVersion {
		if deltaSec > 4 {
			return candidateScore{}, false
		}
	}
	durationScore := lyricsDurationScore(wantSec, candidate.Duration)

	// Strict rule: if artist does not match, only allow when the title has >= 3 distinct words AND duration is within ±1.5s.
	if artistScore < 0.5 {
		if specificity < 3 || bestTitleScore < 0.98 || wantSec <= 0 || candidate.Duration <= 0 || deltaSec > 1.5 {
			return candidateScore{}, false
		}
	}
	rank := bestTitleScore*0.62 + artistScore*0.33 + durationScore*0.05
	return candidateScore{rank: rank, title: bestTitleScore, artist: artistScore, duration: durationScore}, true
}

func (s *service) findLyricsForQuery(params trackLyricsParams, query lyricsQuery, logs *[]string) (trackLyrics, bool) {
	trackID := params.TrackID
	lyrics, exactOK, exactErr := s.fetchLRCLibExact(trackID, query, params.DurationMs)
	if exactOK {
		*logs = append(*logs, "LRCLIB: точный поиск нашёл текст")
		return lyrics, true
	}
	if exactErr != nil {
		*logs = append(*logs, "LRCLIB: точный поиск — "+exactErr.Error())
	} else {
		*logs = append(*logs, "LRCLIB: точный поиск не дал подходящего текста; проверяю каталог")
	}
	var best *scoredLRCLibRecord
	records, err := s.searchLRCLib(query)
	if err != nil {
		*logs = append(*logs, "LRCLIB: ошибка поиска — "+err.Error())
		return trackLyrics{}, false
	}
	// The catalog is scored against the duration of the track that is actually
	// playing, not the canonical one Deezer returned: a reupload on SoundCloud
	// is usually a few seconds off, and its synced lines must line up with that
	// copy. Without this the fallback accepted a record of another length, whose
	// timestamps drifted one or two lines behind the song.
	scoring := query
	if params.DurationMs > 0 {
		scoring.Duration = (params.DurationMs + 500) / 1000
	}
	requireDuration := scoring.Duration > 0 && !lyricsHasVersionMarker(params.Title)
	for _, record := range records {
		if record.Instrumental || strings.TrimSpace(record.SyncedLyrics+record.PlainLyrics) == "" {
			continue
		}
		score, ok := scoreLRCLibRecord(scoring, record, requireDuration)
		if ok && (best == nil || score.rank > best.score.rank) {
			best = &scoredLRCLibRecord{record: record, score: score}
		}
	}
	if best == nil {
		*logs = append(*logs, fmt.Sprintf("LRCLIB: в каталоге проверено записей %d, подходящих нет", len(records)))
		return trackLyrics{}, false
	}
	*logs = append(*logs, fmt.Sprintf("LRCLIB: совпадение — %s — %s", best.record.ArtistName, best.record.TrackName))
	return lyricsFromLRCLibRecord(trackID, best.record, params.DurationMs)
}

func (s *service) findLyricsByVariants(params trackLyricsParams, logs *[]string) (trackLyrics, bool) {
	base := stripLyricsNoise(params.Title)
	titles := lyricsTitleVariants(stripLyricsVersionMarkers(base))
	if len(titles) == 0 {
		titles = lyricsTitleVariants(base)
	}
	artists := lyricsArtistHints(params, base)
	queries := make([]lyricsQuery, 0, len(titles)*len(artists))
	queryLimitReached := false
	for _, title := range titles {
		for _, artist := range artists {
			// Checked before the query budget, so a skipped pair does not use one of the eight
			// slots that real variants need.
			if lyricsDegenerateQueryPair(title, artist) {
				continue
			}
			if len(queries) >= 7 {
				queryLimitReached = true
				break
			}
			duration := int64(0)
			if params.DurationMs > 0 {
				duration = (params.DurationMs + 500) / 1000
			}
			queries = append(queries, lyricsQuery{Title: title, Artist: artist, Duration: duration})
		}
		if queryLimitReached {
			break
		}
	}
	if len(queries) < 8 && len(titles) > 0 {
		duration := int64(0)
		if params.DurationMs > 0 {
			duration = (params.DurationMs + 500) / 1000
		}
		queries = append(queries, lyricsQuery{Title: titles[0], Duration: duration})
	}

	var best *scoredLRCLibRecord
	seen := map[string]bool{}
	searchCount, recordCount, errorCount := 0, 0, 0
	for _, query := range queries {
		key := strings.ToLower(query.Title + "\x00" + query.Artist)
		if seen[key] {
			continue
		}
		seen[key] = true
		searchCount++
		candidates, err := s.searchLRCLib(query)
		if err != nil {
			errorCount++
			continue
		}
		recordCount += len(candidates)
		for _, candidate := range candidates {
			if candidate.Instrumental || strings.TrimSpace(candidate.SyncedLyrics+candidate.PlainLyrics) == "" {
				continue
			}
			score, ok := scoreLRCLibRecord(query, candidate, params.DurationMs > 0 && !lyricsHasVersionMarker(params.Title))
			if !ok {
				continue
			}
			if best == nil || score.rank > best.score.rank {
				best = &scoredLRCLibRecord{record: candidate, score: score}
			}
		}
		// A strong catalog identity is preferable to broadening the query matrix.
		if best != nil && best.score.rank >= 0.93 {
			break
		}
	}
	*logs = append(*logs, fmt.Sprintf("LRCLIB по вариантам: запросов %d, записей %d, ошибок %d", searchCount, recordCount, errorCount))
	if best == nil {
		return trackLyrics{}, false
	}
	*logs = append(*logs, fmt.Sprintf("LRCLIB выбрал: %s — %s", best.record.ArtistName, best.record.TrackName))
	return lyricsFromLRCLibRecord(params.TrackID, best.record, params.DurationMs)
}

type scoredLRCLibRecord struct {
	record lrclibRecord
	score  candidateScore
}

func scoreLRCLibRecord(query lyricsQuery, candidate lrclibRecord, requireDuration bool) (candidateScore, bool) {
	titleScore := lyricsTokenOverlap(query.Title, candidate.TrackName)
	if titleScore < 0.72 {
		return candidateScore{}, false
	}
	artistScore := lyricsTokenOverlap(query.Artist, candidate.ArtistName)
	specificity := lyricsTitleSpecificity(query.Title)
	deltaSec := math.Abs(float64(query.Duration) - candidate.Duration)

	if requireDuration && query.Duration > 0 && candidate.Duration > 0 {
		// Strict ±4s duration check for standard tracks (when artist matches), and ±1.5s when artist is unknown/reupload
		if deltaSec > 4 {
			return candidateScore{}, false
		}
	}
	durationScore := lyricsDurationScore(query.Duration, int64(math.Round(candidate.Duration)))
	if durationScore == 0 && requireDuration {
		return candidateScore{}, false
	}
	// Strict rule: never accept a different artist unless the title has 3+ unique words AND duration matches within ±1.5s!
	if artistScore < 0.5 {
		if specificity < 3 || titleScore < 0.98 || query.Duration <= 0 || candidate.Duration <= 0 || deltaSec > 1.5 {
			return candidateScore{}, false
		}
	}
	rank := titleScore*0.62 + artistScore*0.33 + durationScore*0.05
	if len(parseLRC(candidate.SyncedLyrics)) > 0 {
		rank += 0.04
	}
	return candidateScore{rank: rank, title: titleScore, artist: artistScore, duration: durationScore}, true
}

func (s *service) searchDeezer(query string) ([]deezerTrack, error) {
	endpoint := "https://api.deezer.com/search?limit=8&q=" + url.QueryEscape(query)
	var payload struct {
		Data  []deezerTrack `json:"data"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := s.getLyricsJSON(endpoint, &payload); err != nil {
		return nil, err
	}
	if payload.Error != nil {
		return nil, errors.New(payload.Error.Message)
	}
	return payload.Data, nil
}

func (s *service) searchLRCLib(query lyricsQuery) ([]lrclibRecord, error) {
	values := url.Values{}
	values.Set("track_name", query.Title)
	values.Set("artist_name", query.Artist)
	endpoint := "https://lrclib.net/api/search?" + values.Encode()
	var records []lrclibRecord
	if err := s.getLyricsJSON(endpoint, &records); err != nil {
		return nil, err
	}
	return records, nil
}

func (s *service) fetchLRCLibExact(trackID int64, query lyricsQuery, playingDurationMs int64) (trackLyrics, bool, error) {
	values := url.Values{}
	values.Set("track_name", query.Title)
	values.Set("artist_name", query.Artist)
	if query.Duration > 0 {
		values.Set("duration", strconv.FormatInt(query.Duration, 10))
	}
	var record lrclibRecord
	endpoint := "https://lrclib.net/api/get?" + values.Encode()
	if err := s.getLyricsJSON(endpoint, &record); err != nil {
		return trackLyrics{}, false, err
	}
	if record.Instrumental {
		return trackLyrics{}, false, nil
	}
	if _, ok := scoreLRCLibRecord(query, record, false); !ok {
		return trackLyrics{}, false, nil
	}
	lyrics, ok := lyricsFromLRCLibRecord(trackID, record, playingDurationMs)
	return lyrics, ok, nil
}

func (s *service) getLyricsJSON(endpoint string, target any) error {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		request, err := http.NewRequest(http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		request.Header.Set("User-Agent", lyricsUserAgent)
		response, err := s.httpClient.Do(request)
		if err != nil {
			lastErr = err
		} else {
			if response.StatusCode == http.StatusOK {
				err = json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(target)
				response.Body.Close()
				if err == nil {
					return nil
				}
				lastErr = err
			} else {
				lastErr = fmt.Errorf("источник текста вернул ошибку HTTP %d", response.StatusCode)
				response.Body.Close()
				if response.StatusCode < 500 {
					return lastErr
				}
			}
		}
		if attempt == 0 {
			time.Sleep(250 * time.Millisecond)
		}
	}
	return lastErr
}

func lyricsFromLRCLibRecord(trackID int64, record lrclibRecord, playingDurationMs int64) (trackLyrics, bool) {
	lines := parseLRC(record.SyncedLyrics)
	if len(lines) > 0 {
		lines = scaleLyricsToPlayingCopy(lines, record.Duration, playingDurationMs)
		return trackLyrics{TrackID: trackID, Lines: lines, SourceURL: "https://lrclib.net", IsSynced: true}, true
	}
	lines = parsePlainLyrics(record.PlainLyrics)
	if len(lines) == 0 {
		return trackLyrics{}, false
	}
	// Plain text arrives without timestamps, and there is no honest way to invent them. An evenly
	// spaced grid (the old syntheticTimings) drifts one or two lines from the real vocals through
	// every verse — the sidebar would highlight a line the singer has not reached yet — so the
	// text is handed over as unsynced: the panel shows it, but does not claim to follow playback.
	return trackLyrics{TrackID: trackID, Lines: lines, SourceURL: "https://lrclib.net"}, true
}

// scaleLyricsToPlayingCopy adjusts synced lines to the copy that is actually playing. A slowed or
// sped-up reupload keeps the words and their order but moves every line in time, and the matched
// record usually belongs to the original release. The timestamps are stretched by the ratio of the
// durations, so the highlight stays on the sung line.
//
// A difference of up to two seconds can be metadata rounding or an outro edit.
// Larger differences, including a three-second drift on a short recording, are
// adjusted. The bounds avoid stretching a clearly unrelated version.
func scaleLyricsToPlayingCopy(lines []lyricsLine, recordDurationSec float64, playingDurationMs int64) []lyricsLine {
	if recordDurationSec <= 0 || playingDurationMs <= 0 {
		return lines
	}
	ratio := float64(playingDurationMs) / (recordDurationSec * 1000)
	if math.Abs(float64(playingDurationMs)-recordDurationSec*1000) <= 2000 || ratio < 0.7 || ratio > 1.6 {
		return lines
	}
	scaled := make([]lyricsLine, len(lines))
	for i, line := range lines {
		scaled[i] = line
		scaled[i].StartMs = int64(float64(line.StartMs) * ratio)
	}
	return scaled
}

func lyricsArtistHints(params trackLyricsParams, title string) []string {
	hints := []string{strings.TrimSpace(params.Artist)}
	for _, part := range lyricsDashParts.Split(title, -1) {
		hints = append(hints, stripLyricsNoise(part))
	}
	return uniqueStrings(hints)
}

func lyricsTitleVariants(value string) []string {
	parts := lyricsDashParts.Split(value, -1)
	variants := make([]string, 0, len(parts)+1)
	variants = appendUniqueFold(variants, strings.TrimSpace(value))
	for _, part := range parts {
		variants = appendUniqueFold(variants, stripLyricsNoise(part))
	}
	if len(variants) > 4 {
		variants = variants[:4]
	}
	return variants
}

func stripLyricsNoise(value string) string {
	for _, pattern := range lyricsNoisePatterns {
		value = pattern.ReplaceAllString(value, " ")
	}
	return strings.Trim(strings.Join(strings.Fields(value), " "), " .-_–—")
}

func stripLyricsVersionMarkers(value string) string {
	for _, marker := range lyricsVersionWords {
		pattern := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(strings.TrimRight(marker, ".")) + `\b`)
		value = pattern.ReplaceAllString(value, " ")
	}
	return strings.Trim(strings.Join(strings.Fields(value), " "), " .-_–—")
}

func lyricsHasVersionMarker(value string) bool {
	normalized := " " + lyricsNormalizePunctuation(value) + " "
	for _, word := range lyricsVersionWords {
		marker := " " + lyricsNormalizePunctuation(word) + " "
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func lyricsNormalizePunctuation(value string) string {
	var builder strings.Builder
	space := true
	for _, char := range strings.ToLower(value) {
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			builder.WriteRune(char)
			space = false
		} else if !space {
			builder.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(builder.String())
}

func lyricsTokenOverlap(want, have string) float64 {
	a, b := lyricsTokenSet(stripLyricsNoise(want)), lyricsTokenSet(stripLyricsNoise(have))
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	forward, reverse := 0, 0
	for token := range a {
		if b[token] {
			forward++
		}
	}
	for token := range b {
		if a[token] {
			reverse++
		}
	}
	base := float64(forward)/float64(len(a))*0.7 + float64(reverse)/float64(len(b))*0.3
	surplus := len(b) - len(a)
	if surplus < 0 {
		surplus = 0
	}
	penalty := float64(surplus) / float64(len(b)) * 0.45
	if penalty > 0.45 {
		penalty = 0.45
	}
	return base * (1 - penalty)
}

func lyricsTokenSet(value string) map[string]bool {
	tokens := map[string]bool{}
	var token strings.Builder
	flush := func() {
		if token.Len() > 0 {
			tokens[token.String()] = true
			token.Reset()
		}
	}
	normalized := strings.ReplaceAll(strings.ToLower(value), "ё", "е")
	for _, char := range normalized {
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			token.WriteRune(char)
		} else {
			flush()
		}
	}
	flush()
	return tokens
}

func lyricsTitleSpecificity(value string) int {
	filler := map[string]bool{"a": true, "an": true, "and": true, "are": true, "as": true, "at": true, "be": true, "but": true, "by": true, "can": true, "do": true, "for": true, "from": true, "i": true, "if": true, "in": true, "is": true, "it": true, "me": true, "my": true, "of": true, "on": true, "or": true, "the": true, "to": true, "up": true, "we": true, "what": true, "when": true, "where": true, "who": true, "you": true, "your": true}
	count := 0
	for token := range lyricsTokenSet(value) {
		if !filler[token] {
			count++
		}
	}
	return count
}

func lyricsDurationScore(want, have int64) float64 {
	if want <= 0 || have <= 0 {
		return 0.6
	}
	delta := want - have
	if delta < 0 {
		delta = -delta
	}
	switch {
	case delta <= 2:
		return 1
	case delta <= 5:
		return 0.8
	case delta <= 12:
		return 0.5
	case float64(delta)/float64(want+have) > 0.35:
		return 0
	default:
		return 0.2
	}
}

func parsePlainLyrics(content string) []lyricsLine {
	lines := make([]lyricsLine, 0)
	for _, row := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		text := strings.TrimSpace(row)
		if text != "" {
			lines = append(lines, lyricsLine{ID: fmt.Sprintf("lrclib-plain-%d", len(lines)), Text: text})
		}
	}
	return lines
}

func parseLRC(content string) []lyricsLine {
	lines := make([]lyricsLine, 0)
	var offsetMs int64
	for _, row := range strings.Split(strings.ReplaceAll(content, "\r", ""), "\n") {
		row = strings.TrimSpace(row)
		var timestamps []int64
		for strings.HasPrefix(row, "[") {
			end := strings.IndexByte(row, ']')
			if end < 0 {
				break
			}
			tag := row[1:end]
			parts := strings.Split(tag, ":")
			if len(parts) != 2 {
				break
			}
			minutes, errMinutes := strconv.ParseInt(parts[0], 10, 64)
			seconds, errSeconds := strconv.ParseFloat(parts[1], 64)
			if errMinutes != nil || errSeconds != nil || seconds < 0 || seconds >= 60 {
				// [offset:±ms] shifts every timestamp of the record; the tag is consumed so it is
				// not mistaken for the text of the line.
				if strings.EqualFold(parts[0], "offset") {
					if value, errOffset := strconv.ParseInt(parts[1], 10, 64); errOffset == nil {
						offsetMs = value
						row = row[end+1:]
						continue
					}
				}
				break
			}
			timestamps = append(timestamps, minutes*60_000+int64(seconds*1000+0.5))
			row = row[end+1:]
		}
		text := strings.TrimSpace(row)
		if text == "" {
			continue
		}
		for _, startMs := range timestamps {
			adjusted := startMs + offsetMs
			if adjusted < 0 {
				adjusted = 0
			}
			lines = append(lines, lyricsLine{ID: fmt.Sprintf("lrclib-%d", len(lines)), Text: text, StartMs: adjusted})
		}
	}
	// A chorus written as "[00:12][01:30] refrain" near the top of the file leaves the list out of
	// order; the client binary-searches it, so the lines are sorted here.
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].StartMs < lines[j].StartMs })
	return lines
}

func appendUniqueFold(values []string, value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return values
	}
	for _, existing := range values {
		if strings.EqualFold(existing, value) {
			return values
		}
	}
	return append(values, value)
}

func uniqueStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = appendUniqueFold(result, value)
	}
	return result
}
