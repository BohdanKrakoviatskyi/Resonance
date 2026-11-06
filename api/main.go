package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	appName    = "Resonance"
	appVersion = "0.4.1"
	// legacyAppName is where this sidecar kept its files before the rename to Resonance. Only
	// migrateLegacyDataDir reads it, and only to move those files once; it is not a second
	// supported location, and nothing writes to it again.
	legacyAppName = "BetterSoundCloud"
	maxLine       = 1 << 20
	// maxRequestBytes is the true ceiling on a single request line.
	//
	// maxLine is kept only for reference: it is far too small for anything carrying a
	// background. A settings update with an animation is one JSON line of about sixteen million
	// characters, and a scanner buffer under that stops reading the line at all, so the request
	// is silently dropped and the frontend reports a save failure with no cause.
	maxRequestBytes = 40 << 20
	maxRecentTracks = 20

	// officialAPIBase — официальный API SoundCloud (OAuth-приложения).
	officialAPIBase = "https://api.soundcloud.com"
	// webAPIBase — Web API v2, который принимает токены веб-сессии SoundCloud.
	webAPIBase = "https://api-v2.soundcloud.com"
	userAgent  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
)

// errTokenRejected означает, что SoundCloud отклонил токен (401/403),
// а не то, что сервис недоступен.
var errTokenRejected = errors.New("SoundCloud отклонил токен, проверьте, что вставлен действующий access token")

type request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     uint64 `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type appInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Backend string `json:"backend"`
}

type emptyParams struct{}

type settings struct {
	Accent          string `json:"accent"`
	Volume          int    `json:"volume"`
	ClientID        string `json:"clientId"`
	BackgroundImage string `json:"backgroundImage"`
	BackgroundBlur  int    `json:"backgroundBlur"`
}

type settingsPatch struct {
	Accent          *string `json:"accent"`
	Volume          *int    `json:"volume"`
	ClientID        *string `json:"clientId"`
	BackgroundImage *string `json:"backgroundImage"`
	BackgroundBlur  *int    `json:"backgroundBlur"`
}

type profile struct {
	ID             int64  `json:"id"`
	Username       string `json:"username"`
	FullName       string `json:"fullName,omitempty"`
	PermalinkURL   string `json:"permalinkUrl,omitempty"`
	AvatarURL      string `json:"avatarUrl,omitempty"`
	City           string `json:"city,omitempty"`
	Country        string `json:"country,omitempty"`
	FollowersCount int64  `json:"followersCount,omitempty"`
	TrackCount     int64  `json:"trackCount,omitempty"`
	LikesCount     int64  `json:"likesCount,omitempty"`
}

type soundcloudUser struct {
	ID             int64  `json:"id"`
	Username       string `json:"username"`
	FullName       string `json:"full_name"`
	PermalinkURL   string `json:"permalink_url"`
	AvatarURL      string `json:"avatar_url"`
	City           string `json:"city"`
	Country        string `json:"country"`
	FollowersCount int64  `json:"followers_count"`
	TrackCount     int64  `json:"track_count"`
	LikesCount     int64  `json:"likes_count"`
}

type authState struct {
	Token   string  `json:"token"`
	Profile profile `json:"profile"`
	SavedAt string  `json:"savedAt"`
}

type authStatus struct {
	Authorized bool     `json:"authorized"`
	Profile    *profile `json:"profile,omitempty"`
}

type soundcloudTrack struct {
	ID            int64  `json:"id"`
	URN           string `json:"urn"`
	Title         string `json:"title"`
	PermalinkURL  string `json:"permalink_url"`
	ArtworkURL    string `json:"artwork_url"`
	Duration      int64  `json:"duration"`
	PlaybackCount int64  `json:"playback_count"`
	LikesCount    int64  `json:"likes_count"`
	User          struct {
		Username string `json:"username"`
	} `json:"user"`
}

type soundcloudLike struct {
	Track *soundcloudTrack `json:"track"`
}

type soundcloudTrackCard struct {
	ID            int64  `json:"id"`
	TrackURN      string `json:"trackUrn"`
	Title         string `json:"title"`
	PermalinkURL  string `json:"permalinkUrl,omitempty"`
	ArtworkURL    string `json:"artworkUrl,omitempty"`
	Duration      int64  `json:"duration"`
	PlaybackCount int64  `json:"playbackCount,omitempty"`
	LikesCount    int64  `json:"likesCount,omitempty"`
	User          struct {
		Username string `json:"username"`
	} `json:"user"`
}

type soundcloudPlaylistCard struct {
	ID           string `json:"id"`
	URN          string `json:"urn"`
	Title        string `json:"title"`
	PermalinkURL string `json:"permalinkUrl"`
	ArtworkURL   string `json:"artworkUrl"`
	TrackCount   int64  `json:"trackCount"`
	User         struct {
		Username string `json:"username"`
	} `json:"user"`
}

type soundcloudPlaylistSource struct {
	ID           int64             `json:"id"`
	URN          string            `json:"urn"`
	Title        string            `json:"title"`
	PermalinkURL string            `json:"permalink_url"`
	ArtworkURL   string            `json:"artwork_url"`
	TrackCount   int64             `json:"track_count"`
	Tracks       []soundcloudTrack `json:"tracks,omitempty"`
	Public       *bool             `json:"public"`
	IsAlbum      bool              `json:"is_album"`
	User         struct {
		Username string `json:"username"`
	} `json:"user"`
}

type soundcloudPlaylistCollectionItem struct {
	soundcloudPlaylistSource
	Playlist *soundcloudPlaylistSource `json:"playlist"`
}

type loginParams struct {
	Token string `json:"token"`
}

type trackLikeParams struct {
	TrackID        int64  `json:"trackId"`
	TrackURN       string `json:"trackUrn"`
	DataDomeCookie string `json:"datadomeCookie,omitempty"`
}

type trackLikeResult struct {
	Liked      bool   `json:"liked"`
	CaptchaURL string `json:"captchaUrl,omitempty"`
}

type captchaChallengeError struct {
	URL string
}

func (e *captchaChallengeError) Error() string {
	return "SoundCloud требует пройти проверку перед изменением лайка"
}

type trackDetailsParams struct {
	TrackID int64 `json:"trackId"`
}

type playlistTracksParams struct {
	PlaylistURN string `json:"playlistUrn"`
}

type searchTracksParams struct {
	Query string `json:"query"`
}

type relatedTracksParams struct {
	TrackID int64 `json:"trackId"`
}

type userProfileParams struct {
	UserID int64 `json:"userId"`
}

type userLikesParams struct {
	UserID int64  `json:"userId"`
	Next   string `json:"next,omitempty"`
}

type soundcloudUserProfile struct {
	ID              int64  `json:"id"`
	Username        string `json:"username"`
	FullName        string `json:"fullName,omitempty"`
	PermalinkURL    string `json:"permalinkUrl,omitempty"`
	AvatarURL       string `json:"avatarUrl,omitempty"`
	BannerURL       string `json:"bannerUrl,omitempty"`
	Description     string `json:"description,omitempty"`
	City            string `json:"city,omitempty"`
	Country         string `json:"country,omitempty"`
	FollowersCount  int64  `json:"followersCount"`
	FollowingsCount int64  `json:"followingsCount"`
	TrackCount      int64  `json:"trackCount"`
	LikesCount      int64  `json:"likesCount,omitempty"`
	Verified        bool   `json:"verified,omitempty"`
}

type soundcloudSocialUser struct {
	ID              int64  `json:"id"`
	Username        string `json:"username"`
	FullName        string `json:"full_name,omitempty"`
	PermalinkURL    string `json:"permalink_url,omitempty"`
	AvatarURL       string `json:"avatar_url,omitempty"`
	AvatarURLCamel  string `json:"avatarUrl,omitempty"`
	Avatar          string `json:"avatar,omitempty"`
	FollowersCount  int64  `json:"followers_count,omitempty"`
	FollowersCamel  int64  `json:"followersCount,omitempty"`
	FollowingsCount int64  `json:"followings_count,omitempty"`
	FollowingsCamel int64  `json:"followingsCount,omitempty"`
	TrackCount      int64  `json:"track_count,omitempty"`
}

type soundcloudSocialPage struct {
	Collection []socialUserDTO `json:"collection"`
	NextHref   string          `json:"nextHref,omitempty"`
}

type soundcloudTrackPage struct {
	Tracks   []soundcloudTrackCard `json:"tracks"`
	NextHref string                `json:"nextHref,omitempty"`
}

type soundcloudSocialSourcePage struct {
	Collection []soundcloudSocialUser `json:"collection"`
	NextHref   string                 `json:"next_href"`
}

type socialUserDTO struct {
	ID              int64  `json:"id"`
	Username        string `json:"username"`
	FullName        string `json:"fullName,omitempty"`
	PermalinkURL    string `json:"permalinkUrl,omitempty"`
	AvatarURL       string `json:"avatarUrl,omitempty"`
	FollowersCount  int64  `json:"followersCount,omitempty"`
	FollowingsCount int64  `json:"followingsCount,omitempty"`
	TrackCount      int64  `json:"trackCount,omitempty"`
}

type userSocialParams struct {
	UserID int64  `json:"userId"`
	Next   string `json:"next,omitempty"`
}

type historyTrackParams struct {
	Track soundcloudTrackCard `json:"track"`
}

type mixedSelection struct {
	ID          string                   `json:"id"`
	Title       string                   `json:"title"`
	Description string                   `json:"description,omitempty"`
	Tracks      []soundcloudSearchTrack  `json:"tracks"`
	Playlists   []soundcloudPlaylistCard `json:"playlists,omitempty"`
	MadeForYou  bool                     `json:"madeForYou,omitempty"`
}

type soundcloudSearchTrack struct {
	ID           int64  `json:"id"`
	URN          string `json:"urn"`
	Title        string `json:"title"`
	PermalinkURL string `json:"permalinkUrl"`
	ArtworkURL   string `json:"artworkUrl"`
	Duration     int64  `json:"duration"`
	User         struct {
		Username  string `json:"username"`
		AvatarURL string `json:"avatarUrl"`
	} `json:"user"`
}

type soundcloudSearchTrackSource struct {
	ID           int64  `json:"id"`
	URN          string `json:"urn"`
	Title        string `json:"title"`
	PermalinkURL string `json:"permalink_url"`
	ArtworkURL   string `json:"artwork_url"`
	Duration     int64  `json:"duration"`
	User         struct {
		Username  string `json:"username"`
		AvatarURL string `json:"avatar_url"`
	} `json:"user"`
}

type soundcloudTrackDetails struct {
	ID            int64  `json:"id"`
	URN           string `json:"urn"`
	Title         string `json:"title"`
	PermalinkURL  string `json:"permalinkUrl"`
	ArtworkURL    string `json:"artworkUrl"`
	Description   string `json:"description"`
	Genre         string `json:"genre"`
	TagList       string `json:"tagList"`
	Duration      int64  `json:"duration"`
	PlaybackCount int64  `json:"playbackCount"`
	LikesCount    int64  `json:"likesCount"`
	RepostsCount  int64  `json:"repostsCount"`
	CommentCount  int64  `json:"commentCount"`
	CreatedAt     string `json:"createdAt"`
	DisplayDate   string `json:"displayDate"`
	WaveformURL   string `json:"waveformUrl"`
	User          struct {
		ID             int64  `json:"id"`
		Username       string `json:"username"`
		AvatarURL      string `json:"avatarUrl"`
		PermalinkURL   string `json:"permalinkUrl"`
		FollowersCount int64  `json:"followersCount"`
	} `json:"user"`
}

// cachedLyrics is one entry of the lyrics cache: the response, and when it was stored.
//
// A miss is kept for five minutes rather than for the session. It used to be permanent, so a track
// whose text was missing — or whose first lookup failed while reporting a miss — stayed empty for
// as long as the app ran.
type cachedLyrics struct {
	lyrics   trackLyrics
	cachedAt time.Time
}

type service struct {
	mu           sync.RWMutex
	settingsPath string
	settings     settings
	authPath     string
	auth         authState
	historyPath  string
	history      []soundcloudTrackCard
	apiBase      string
	httpClient   *http.Client
	// Lyrics are cached separately from everything else and behind their own lock: mu is held
	// across disk writes and settings updates, so borrowing it for a cache that outlives an HTTP
	// lookup would queue unrelated work behind the network.
	lyricsMu    sync.RWMutex
	lyricsCache map[int64]cachedLyrics
	// Resolved yt-dlp audio URLs are cached to avoid spawning yt-dlp on every play.
	// Signed googlevideo URLs expire; entries are short-lived and failures bypass cache.
	ytStreamMu    sync.Mutex
	ytStreamCache map[string]ytStreamCacheEntry
	ytStreamCalls map[string]*ytStreamCall
	// Local HTTP audio proxy/cache for YouTube playback (download+stream+disk cache).
	ytAudio *ytAudioManager
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "local backend:", err)
		os.Exit(1)
	}
}

func run(input io.Reader, output io.Writer) error {
	dataDir, err := appDataDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create app data directory: %w", err)
	}
	if err := removeFileIfExists(filepath.Join(dataDir, "spotify.json")); err != nil {
		log.Printf("could not remove retired provider credentials: %v", err)
	}

	svc := &service{
		settingsPath: filepath.Join(dataDir, "settings.json"),
		settings:     defaultSettings(),
		authPath:     filepath.Join(dataDir, "auth.json"),
		historyPath:  filepath.Join(dataDir, "history.json"),
		apiBase:      apiBase(),
		httpClient:   &http.Client{Timeout: 15 * time.Second},
		lyricsCache:  make(map[int64]cachedLyrics),
	}
	audioMgr := newYTAudioManager(filepath.Join(dataDir, "yt-audio-cache"), svc.httpClient)
	if err := audioMgr.start(); err != nil {
		log.Printf("yt audio cache disabled: %v", err)
	} else {
		svc.ytAudio = audioMgr
	}
	if err := svc.loadSettings(); err != nil {
		return err
	}
	if err := svc.loadAuth(); err != nil {
		fmt.Fprintln(os.Stderr, "local backend: auth state ignored:", err)
	}
	if err := svc.loadHistory(); err != nil {
		fmt.Fprintln(os.Stderr, "local backend: playback history ignored:", err)
	}

	scanner := bufio.NewScanner(input)
	// Grown on demand, so this only reserves a small buffer until a genuinely large request
	// arrives; Scanner allocates more as it reads rather than up front.
	scanner.Buffer(make([]byte, 64*1024), maxRequestBytes)
	writer := bufio.NewWriter(output)
	var writeMu sync.Mutex
	var inFlight sync.WaitGroup
	write := func(res response) {
		writeMu.Lock()
		err := writeResponse(writer, res)
		writeMu.Unlock()
		if err != nil {
			log.Printf("write response: %v", err)
		}
	}
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			write(response{Error: "invalid request"})
			continue
		}

		// One goroutine per request: a slow network call must not queue playback
		// or settings behind it. The response carries the request id, so the
		// client matches out-of-order replies.
		inFlight.Add(1)
		go func(req request) {
			defer inFlight.Done()
			result, callErr := svc.call(req.Method, req.Params)
			res := response{ID: req.ID, Result: result}
			if callErr != nil {
				res.Result = nil
				res.Error = callErr.Error()
			}
			write(res)
		}(req)
	}
	inFlight.Wait()
	return scanner.Err()
}

// rpcWriteLocked names the methods that mutate in-memory state (settings,
// auth, history) and so need an exclusive lock. Everything else takes a read
// lock and can run concurrently: a slow SoundCloud fetch no longer freezes
// playback or lyrics.
var rpcWriteLocked = map[string]bool{
	"settings.update": true,
	"settings.clear":  true,
	"history.record":  true,
	"history.clear":   true,
	"auth.login":      true,
	"auth.refresh":    true,
	"auth.logout":     true,
}

// rpcSelfLocked methods manage their own locking. tracks.mine reads auth under
// a short read lock, does its paging without a lock, and takes a write lock
// only when it has to refresh a rejected token.
var rpcSelfLocked = map[string]bool{
	"tracks.mine": true,
}

func (s *service) call(method string, params json.RawMessage) (any, error) {
	startedAt := time.Now()
	log.Printf("rpc stage=received method=%q params_bytes=%d", method, len(params))
	spec, ok := rpcMethods()[method]
	if !ok {
		log.Printf("rpc stage=dispatch_error method=%q error=%q", method, "unknown method")
		return nil, errors.New("unknown method")
	}
	paramsValue := reflect.New(spec.params)
	if len(params) == 0 {
		params = json.RawMessage(`{}`)
	}
	if err := json.Unmarshal(params, paramsValue.Interface()); err != nil {
		wrapped := fmt.Errorf("invalid %s payload: %w", method, err)
		log.Printf("rpc stage=decode_error method=%q params_type=%s error=%q", method, spec.params, wrapped.Error())
		return nil, wrapped
	}
	methodValue := reflect.ValueOf(s).MethodByName(spec.goName)
	if !methodValue.IsValid() {
		log.Printf("rpc stage=dispatch_error method=%q go_method=%q error=%q", method, spec.goName, "method disappeared after discovery")
		return nil, errors.New("unknown method")
	}

	switch {
	case rpcSelfLocked[method]:
	case rpcWriteLocked[method]:
		s.mu.Lock()
		defer s.mu.Unlock()
	default:
		s.mu.RLock()
		defer s.mu.RUnlock()
	}

	outputs := methodValue.Call([]reflect.Value{paramsValue.Elem()})
	if !outputs[1].IsNil() {
		err := outputs[1].Interface().(error)
		log.Printf("rpc stage=handler_error method=%q go_method=%q elapsed_ms=%d error=%q", method, spec.goName, time.Since(startedAt).Milliseconds(), err.Error())
		return nil, err
	}
	log.Printf("rpc stage=complete method=%q result_type=%s elapsed_ms=%d", method, spec.result, time.Since(startedAt).Milliseconds())
	return outputs[0].Interface(), nil
}

type rpcMethodSpec struct {
	goName string
	params reflect.Type
	result reflect.Type
}

func rpcMethods() map[string]rpcMethodSpec {
	methods := map[string]rpcMethodSpec{}
	errorType := reflect.TypeOf((*error)(nil)).Elem()
	serviceType := reflect.TypeOf((*service)(nil))
	for i := 0; i < serviceType.NumMethod(); i++ {
		method := serviceType.Method(i)
		if !strings.HasPrefix(method.Name, "RPC") || method.Type.NumIn() != 2 || method.Type.NumOut() != 2 || method.Type.Out(1) != errorType {
			continue
		}
		apiName := rpcNameFromGo(method.Name)
		methods[apiName] = rpcMethodSpec{goName: method.Name, params: method.Type.In(1), result: method.Type.Out(0)}
	}
	return methods
}

func rpcNameFromGo(goName string) string {
	runes := []rune(strings.TrimPrefix(goName, "RPC"))
	var result strings.Builder
	for i, current := range runes {
		if i > 0 && unicode.IsUpper(current) {
			previous := runes[i-1]
			nextIsLower := i+1 < len(runes) && unicode.IsLower(runes[i+1])
			if unicode.IsLower(previous) || unicode.IsDigit(previous) || (unicode.IsUpper(previous) && nextIsLower) {
				result.WriteByte('.')
			}
		}
		result.WriteRune(unicode.ToLower(current))
	}
	return result.String()
}

// Exported methods prefixed with RPC are discovered automatically, published
// by the JSON-RPC dispatcher.
func (s *service) RPCAppInfo(_ emptyParams) (appInfo, error) {
	return appInfo{Name: appName, Version: appVersion, Backend: "go-sidecar"}, nil
}

func (s *service) RPCSettingsGet(_ emptyParams) (settings, error) {
	return s.settings, nil
}

func (s *service) RPCSettingsUpdate(patch settingsPatch) (settings, error) {
	updated := s.settings
	if patch.Accent != nil {
		if !validAccent(*patch.Accent) {
			return settings{}, errors.New("акцент должен быть шестизначным цветом в формате hex")
		}
		updated.Accent = strings.ToLower(*patch.Accent)
	}
	if patch.Volume != nil {
		if *patch.Volume < 0 || *patch.Volume > 100 {
			return settings{}, errors.New("громкость должна быть от 0 до 100")
		}
		updated.Volume = *patch.Volume
	}
	if patch.ClientID != nil {
		clientID := strings.TrimSpace(*patch.ClientID)
		if !validSoundCloudClientID(clientID) {
			return settings{}, errors.New("client_id должен содержать от 8 до 128 латинских букв, цифр, дефисов или подчёркиваний")
		}
		updated.ClientID = clientID
	}
	if patch.BackgroundImage != nil {
		if !validBackgroundImage(*patch.BackgroundImage) {
			return settings{}, errors.New("фон должен быть изображением JPEG в формате data URL размером до 700 КБ")
		}
		updated.BackgroundImage = *patch.BackgroundImage
	}
	if patch.BackgroundBlur != nil {
		if *patch.BackgroundBlur < 0 || *patch.BackgroundBlur > 24 {
			return settings{}, errors.New("размытие фона должно быть от 0 до 24")
		}
		updated.BackgroundBlur = *patch.BackgroundBlur
	}
	if err := s.saveSettings(updated); err != nil {
		return settings{}, fmt.Errorf("save settings: %w", err)
	}
	s.settings = updated
	return updated, nil
}

// RPCSettingsClear clears locally persisted account credentials and preferences.
func (s *service) RPCSettingsClear(_ emptyParams) (settings, error) {
	if err := s.clearAuth(); err != nil {
		return settings{}, fmt.Errorf("clear auth: %w", err)
	}
	if err := removeFileIfExists(s.settingsPath); err != nil {
		return settings{}, fmt.Errorf("clear settings: %w", err)
	}
	if err := removeFileIfExists(s.historyPath); err != nil {
		return settings{}, fmt.Errorf("clear history: %w", err)
	}
	s.auth = authState{}
	s.settings = defaultSettings()
	s.history = nil
	return s.settings, nil
}

func (s *service) RPCHistoryList(_ emptyParams) ([]soundcloudTrackCard, error) {
	return append([]soundcloudTrackCard{}, s.history...), nil
}

func (s *service) RPCHistoryRecord(params historyTrackParams) ([]soundcloudTrackCard, error) {
	track := params.Track
	if track.ID <= 0 || strings.TrimSpace(track.Title) == "" {
		return nil, errors.New("для записи истории нужны корректные ID и название трека")
	}
	if track.TrackURN == "" {
		track.TrackURN = fmt.Sprintf("soundcloud:tracks:%d", track.ID)
	}
	updated := make([]soundcloudTrackCard, 0, maxRecentTracks)
	updated = append(updated, track)
	for _, existing := range s.history {
		if existing.ID == track.ID {
			continue
		}
		updated = append(updated, existing)
		if len(updated) == maxRecentTracks {
			break
		}
	}
	if err := s.saveHistory(updated); err != nil {
		return nil, fmt.Errorf("save playback history: %w", err)
	}
	s.history = updated
	return append([]soundcloudTrackCard{}, updated...), nil
}

func (s *service) RPCHistoryClear(_ emptyParams) ([]soundcloudTrackCard, error) {
	if err := removeFileIfExists(s.historyPath); err != nil {
		return nil, fmt.Errorf("clear playback history: %w", err)
	}
	s.history = nil
	return []soundcloudTrackCard{}, nil
}

func (s *service) RPCAuthStatus(_ emptyParams) (authStatus, error) {
	return s.authStatus(), nil
}

func (s *service) RPCAuthLogin(login loginParams) (authStatus, error) {
	token := strings.TrimSpace(login.Token)
	if token == "" {
		return authStatus{}, errors.New("вставьте access token SoundCloud")
	}
	user, err := s.fetchProfile(token)
	if err != nil {
		return authStatus{}, err
	}
	state := authState{Token: token, Profile: user, SavedAt: time.Now().UTC().Format(time.RFC3339)}
	if err := s.saveAuth(state); err != nil {
		return authStatus{}, fmt.Errorf("save auth: %w", err)
	}
	s.auth = state
	return s.authStatus(), nil
}

func (s *service) RPCAuthRefresh(_ emptyParams) (authStatus, error) {
	if s.auth.Token == "" {
		return authStatus{Authorized: false}, nil
	}
	user, err := s.fetchProfile(s.auth.Token)
	if err != nil {
		if errors.Is(err, errTokenRejected) {
			if clearErr := s.clearAuth(); clearErr != nil {
				return authStatus{}, fmt.Errorf("clear auth: %w", clearErr)
			}
			s.auth = authState{}
			return authStatus{Authorized: false}, nil
		}
		// Сеть недоступна: сохраняем сессию и отдаём кэшированный профиль.
		return s.authStatus(), nil
	}
	s.auth.Profile = user
	if err := s.saveAuth(s.auth); err != nil {
		return authStatus{}, fmt.Errorf("save auth: %w", err)
	}
	return s.authStatus(), nil
}

func (s *service) RPCAuthLogout(_ emptyParams) (authStatus, error) {
	if err := s.clearAuth(); err != nil {
		return authStatus{}, fmt.Errorf("clear auth: %w", err)
	}
	s.auth = authState{}
	return authStatus{Authorized: false}, nil
}

func (s *service) RPCTracksMine(_ emptyParams) ([]soundcloudTrackCard, error) {
	s.mu.RLock()
	token, userID := s.auth.Token, s.auth.Profile.ID
	s.mu.RUnlock()
	if token == "" {
		return nil, errors.New("сначала подключите аккаунт SoundCloud")
	}
	tracks, err := s.fetchMyTracks(token, userID)
	if err != nil && errors.Is(err, errTokenRejected) {
		// Токен отклонён двумя хостами (web и official) — сессия устарела.
		// Пробуем ре-валидацию профиля; если и он не проходит — явно
		// сообщаем о необходимости повторного логина. The write lock is held
		// only for the refresh, not for the paging above.
		s.mu.Lock()
		revalidated, refreshErr := s.RPCAuthRefresh(emptyParams{})
		if refreshErr == nil && revalidated.Authorized {
			token, userID = s.auth.Token, s.auth.Profile.ID
			s.mu.Unlock()
			retried, retryErr := s.fetchMyTracks(token, userID)
			if retryErr == nil {
				return retried, nil
			}
			return nil, retryErr
		}
		s.auth = authState{}
		_ = s.clearAuth()
		s.mu.Unlock()
		return nil, errors.New("сессия SoundCloud устарела — войдите снова")
	}
	return tracks, err
}

func (s *service) RPCPlaylistsMine(_ emptyParams) ([]soundcloudPlaylistCard, error) {
	if s.auth.Token == "" {
		return nil, errors.New("сначала подключите аккаунт SoundCloud")
	}
	userID := s.auth.Profile.ID
	if userID <= 0 {
		return nil, errors.New("SoundCloud не вернул ID аккаунта для загрузки плейлистов")
	}
	var lastErr error
	for _, base := range s.apiBases() {
		paths := []string{fmt.Sprintf("/users/%d/playlists", userID)}
		if base == webAPIBase {
			paths = append([]string{fmt.Sprintf("/users/%d/playlists/liked_and_owned", userID)}, paths...)
		}
		if base == officialAPIBase {
			paths = append([]string{"/me/playlists"}, paths...)
		}
		for _, path := range paths {
			endpoint, err := url.Parse(strings.TrimRight(base, "/") + path)
			if err != nil {
				lastErr = err
				continue
			}
			query := endpoint.Query()
			query.Set("limit", "200")
			query.Set("linked_partitioning", "true")

			query.Set("client_id", s.settings.ClientID)
			endpoint.RawQuery = query.Encode()
			playlists, err := s.fetchPlaylistsFrom(base, endpoint.String())
			if err == nil {
				return playlists, nil
			}
			lastErr = err
			log.Printf("playlists.mine stage=fallback host=%s path=%s error=%q", hostForLog(base), path, err.Error())
		}
	}
	if lastErr == nil {
		lastErr = errors.New("SoundCloud API не вернул список плейлистов")
	}
	return nil, fmt.Errorf("не удалось загрузить плейлисты SoundCloud: %w", lastErr)
}

func (s *service) RPCPlaylistTracks(params playlistTracksParams) ([]soundcloudTrackCard, error) {
	if s.auth.Token == "" {
		return nil, errors.New("сначала подключите аккаунт SoundCloud")
	}
	playlistURN := strings.TrimSpace(params.PlaylistURN)
	if playlistURN == "" {
		return nil, errors.New("у плейлиста отсутствует идентификатор SoundCloud")
	}
	playlistID := strings.TrimPrefix(playlistURN, "soundcloud:playlists:")
	if playlistID == playlistURN {
		playlistID = playlistURN
	}
	var lastErr error
	for _, base := range s.apiBases() {
		endpoint, err := url.Parse(strings.TrimRight(base, "/") + "/playlists/" + url.PathEscape(playlistID))
		if err != nil {
			lastErr = err
			continue
		}
		query := endpoint.Query()
		query.Set("representation", "full")
		query.Set("limit", "500")
		query.Set("client_id", s.settings.ClientID)
		endpoint.RawQuery = query.Encode()
		tracks, err := s.fetchPlaylistTracksFrom(base, endpoint.String())
		if err == nil {
			return tracks, nil
		}
		lastErr = err
		log.Printf("playlist.tracks stage=fallback host=%s error=%q", hostForLog(base), err.Error())
	}
	if lastErr == nil {
		lastErr = errors.New("SoundCloud API не вернул треки плейлиста")
	}
	return nil, fmt.Errorf("не удалось загрузить треки плейлиста: %w", lastErr)
}

func (s *service) fetchPlaylistTracksFrom(base, endpoint string) ([]soundcloudTrackCard, error) {
	baseURL, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil {
		return nil, err
	}
	playlistURL, err := url.Parse(endpoint)
	if err != nil || playlistURL.Scheme != baseURL.Scheme || !strings.EqualFold(playlistURL.Host, baseURL.Host) {
		return nil, errors.New("SoundCloud вернул некорректный URL плейлиста")
	}
	query := playlistURL.Query()
	query.Set("client_id", s.settings.ClientID)
	playlistURL.RawQuery = query.Encode()

	var payload struct {
		Collection []soundcloudTrack `json:"collection"`
		Tracks     []soundcloudTrack `json:"tracks"`
	}
	if err := s.getSoundCloudJSONLimit(playlistURL.String(), &payload, 16<<20); err != nil {
		return nil, err
	}
	playlistTracks := payload.Tracks
	if playlistTracks == nil {
		playlistTracks = payload.Collection
	}
	return s.hydratePlaylistTracks(base, playlistTracks)
}

func (s *service) hydratePlaylistTracks(base string, playlistTracks []soundcloudTrack) ([]soundcloudTrackCard, error) {
	trackIDs := make([]int64, 0, len(playlistTracks))
	seenIDs := make(map[int64]struct{}, len(playlistTracks))
	for _, track := range playlistTracks {
		if track.ID <= 0 {
			continue
		}
		if _, seen := seenIDs[track.ID]; seen {
			continue
		}
		seenIDs[track.ID] = struct{}{}
		trackIDs = append(trackIDs, track.ID)
	}

	tracksByID := make(map[int64]soundcloudTrack, len(trackIDs))
	for start := 0; start < len(trackIDs); start += 50 {
		end := min(start+50, len(trackIDs))
		fullTracks, err := s.fetchTracksByIDs(base, trackIDs[start:end])
		if err != nil {
			return nil, fmt.Errorf("не удалось дозагрузить треки плейлиста (пакет %d): %w", start/50+1, err)
		}
		for _, track := range fullTracks {
			if track.ID > 0 && track.Title != "" {
				tracksByID[track.ID] = track
			}
		}
	}

	ordered := make([]soundcloudTrackCard, 0, len(playlistTracks))
	for _, original := range playlistTracks {
		if original.ID <= 0 {
			continue
		}
		track, found := tracksByID[original.ID]
		if !found {
			if strings.TrimSpace(original.Title) == "" {
				continue
			}
			track = original
		}
		if track.Title == "" {
			continue
		}
		trackURN := track.URN
		if trackURN == "" {
			trackURN = fmt.Sprintf("soundcloud:tracks:%d", track.ID)
		}
		artwork := normalizeArtworkURL(track.ArtworkURL)
		card := soundcloudTrackCard{ID: track.ID, TrackURN: trackURN, Title: track.Title, PermalinkURL: track.PermalinkURL, ArtworkURL: artwork, Duration: track.Duration, PlaybackCount: track.PlaybackCount, LikesCount: track.LikesCount}
		card.User.Username = track.User.Username
		ordered = append(ordered, card)
	}
	return ordered, nil
}

func (s *service) fetchTracksByIDs(base string, trackIDs []int64) ([]soundcloudTrack, error) {
	if len(trackIDs) == 0 {
		return []soundcloudTrack{}, nil
	}
	baseURL, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil || baseURL.Host == "" {
		return nil, errors.New("некорректный адрес SoundCloud API")
	}

	endpoint := &url.URL{
		Scheme: baseURL.Scheme,
		Host:   baseURL.Host,
		Path:   strings.TrimRight(baseURL.Path, "/") + "/tracks",
	}
	query := endpoint.Query()
	ids := make([]string, len(trackIDs))
	for index, id := range trackIDs {
		ids[index] = strconv.FormatInt(id, 10)
	}
	query.Set("ids", strings.Join(ids, ","))
	query.Set("client_id", s.settings.ClientID)
	endpoint.RawQuery = query.Encode()

	var response json.RawMessage
	if err := s.getSoundCloudJSONLimit(endpoint.String(), &response, 16<<20); err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(response)
	var tracks []soundcloudTrack
	switch {
	case len(trimmed) > 0 && trimmed[0] == '[':
		if err := json.Unmarshal(trimmed, &tracks); err != nil {
			return nil, fmt.Errorf("не удалось разобрать список треков SoundCloud: %w", err)
		}
	case len(trimmed) > 0 && trimmed[0] == '{':
		var payload struct {
			Collection []soundcloudTrack `json:"collection"`
			Tracks     []soundcloudTrack `json:"tracks"`
		}
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			return nil, fmt.Errorf("не удалось разобрать список треков SoundCloud: %w", err)
		}
		tracks = payload.Collection
		if tracks == nil {
			tracks = payload.Tracks
		}
	default:
		return nil, errors.New("SoundCloud вернул пустой или некорректный список треков")
	}
	return tracks, nil
}

func (s *service) fetchPlaylistsFrom(base, endpoint string) ([]soundcloudPlaylistCard, error) {
	baseURL, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil {
		return nil, err
	}
	playlists := make([]soundcloudPlaylistCard, 0)
	seenPages := make(map[string]bool)
	for page := 0; endpoint != ""; page++ {
		if page >= 100 {
			return nil, errors.New("SoundCloud вернул слишком много страниц плейлистов (лимит 100)")
		}
		parsed, parseErr := url.Parse(endpoint)
		if parseErr != nil || parsed.Scheme != baseURL.Scheme || !strings.EqualFold(parsed.Host, baseURL.Host) {
			return nil, errors.New("SoundCloud вернул некорректную ссылку страницы плейлистов")
		}
		if seenPages[endpoint] {
			return nil, errors.New("SoundCloud вернул повторяющуюся ссылку страницы плейлистов")
		}
		seenPages[endpoint] = true
		query := parsed.Query()
		query.Set("client_id", s.settings.ClientID)
		parsed.RawQuery = query.Encode()
		endpoint = parsed.String()
		var payload struct {
			Collection []soundcloudPlaylistCollectionItem `json:"collection"`
			NextHref   string                             `json:"next_href"`
		}
		if err := s.getSoundCloudJSONLimit(endpoint, &payload, 16<<20); err != nil {
			return nil, err
		}
		for _, item := range payload.Collection {
			source := item.soundcloudPlaylistSource
			if item.Playlist != nil {
				source = *item.Playlist
			}
			playlistURN := source.URN
			if playlistURN == "" && source.ID > 0 {
				playlistURN = fmt.Sprintf("soundcloud:playlists:%d", source.ID)
			}
			playlistID := playlistURN
			if source.ID > 0 {
				playlistID = strconv.FormatInt(source.ID, 10)
			}
			if playlistID == "" || source.Title == "" {
				continue
			}
			artwork := normalizeArtworkURL(source.ArtworkURL)
			if artwork == "" && len(source.Tracks) > 0 {
				artwork = normalizeArtworkURL(source.Tracks[0].ArtworkURL)
			}
			if artwork == "" && source.ID > 0 {
				fallback, fallbackErr := s.fetchFirstPlaylistTrackArtwork(base, source.ID)
				if fallbackErr != nil {
					log.Printf("playlists.mine stage=cover_fallback playlist_id=%d error=%q", source.ID, fallbackErr.Error())
				} else {
					artwork = fallback
				}
			}
			playlist := soundcloudPlaylistCard{ID: playlistID, URN: playlistURN, Title: source.Title, PermalinkURL: source.PermalinkURL, ArtworkURL: artwork, TrackCount: source.TrackCount}
			playlist.User.Username = source.User.Username
			playlists = append(playlists, playlist)
		}
		endpoint = payload.NextHref
	}
	return playlists, nil
}

func normalizeArtworkURL(artwork string) string {
	artwork = strings.Replace(artwork, "-large.", "-t500x500.", 1)
	return strings.Replace(artwork, "/large/", "/t500x500/", 1)
}

func (s *service) fetchFirstPlaylistTrackArtwork(base string, playlistID int64) (string, error) {
	baseURL, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil || baseURL.Host == "" || playlistID <= 0 {
		return "", errors.New("некорректный адрес или ID плейлиста")
	}

	endpoint := &url.URL{
		Scheme: baseURL.Scheme,
		Host:   baseURL.Host,
		Path:   strings.TrimRight(baseURL.Path, "/") + "/playlists/" + strconv.FormatInt(playlistID, 10),
	}
	query := endpoint.Query()
	query.Set("representation", "full")
	query.Set("limit", "5")
	query.Set("client_id", s.settings.ClientID)
	endpoint.RawQuery = query.Encode()

	var payload struct {
		Tracks     []soundcloudTrack `json:"tracks"`
		Collection []soundcloudTrack `json:"collection"`
	}
	if err := s.getSoundCloudJSONLimit(endpoint.String(), &payload, 16<<20); err != nil {
		return "", err
	}
	playlistTracks := payload.Tracks
	if playlistTracks == nil {
		playlistTracks = payload.Collection
	}
	if len(playlistTracks) == 0 {
		return "", nil
	}

	first := playlistTracks[0]
	if artwork := normalizeArtworkURL(first.ArtworkURL); artwork != "" {
		return artwork, nil
	}
	if first.ID <= 0 {
		return "", nil
	}

	tracks, err := s.fetchTracksByIDs(base, []int64{first.ID})
	if err != nil {
		return "", err
	}
	for _, track := range tracks {
		if track.ID == first.ID {
			return normalizeArtworkURL(track.ArtworkURL), nil
		}
	}
	return "", nil
}

func (s *service) RPCTrackDetails(params trackDetailsParams) (soundcloudTrackDetails, error) {
	if s.auth.Token == "" {
		return soundcloudTrackDetails{}, errors.New("сначала подключите аккаунт SoundCloud")
	}
	if params.TrackID <= 0 {
		return soundcloudTrackDetails{}, errors.New("некорректный ID трека")
	}
	startedAt := time.Now()
	endpoint, err := s.soundcloudV2URL("/tracks/"+strconv.FormatInt(params.TrackID, 10), nil)
	if err != nil {
		return soundcloudTrackDetails{}, fmt.Errorf("не удалось сформировать запрос деталей трека: %w", err)
	}
	var track struct {
		ID            int64  `json:"id"`
		URN           string `json:"urn"`
		Title         string `json:"title"`
		PermalinkURL  string `json:"permalink_url"`
		ArtworkURL    string `json:"artwork_url"`
		Description   string `json:"description"`
		Genre         string `json:"genre"`
		TagList       string `json:"tag_list"`
		Duration      int64  `json:"duration"`
		PlaybackCount int64  `json:"playback_count"`
		LikesCount    int64  `json:"likes_count"`
		RepostsCount  int64  `json:"reposts_count"`
		CommentCount  int64  `json:"comment_count"`
		CreatedAt     string `json:"created_at"`
		DisplayDate   string `json:"display_date"`
		WaveformURL   string `json:"waveform_url"`
		User          struct {
			ID             int64  `json:"id"`
			Username       string `json:"username"`
			AvatarURL      string `json:"avatar_url"`
			PermalinkURL   string `json:"permalink_url"`
			FollowersCount int64  `json:"followers_count"`
		} `json:"user"`
	}
	log.Printf("track.details stage=request track_id=%d", params.TrackID)
	if err := s.getSoundCloudJSON(endpoint, &track); err != nil {
		log.Printf("track.details stage=failed track_id=%d elapsed_ms=%d error=%q", params.TrackID, time.Since(startedAt).Milliseconds(), err.Error())
		return soundcloudTrackDetails{}, fmt.Errorf("не удалось загрузить информацию о треке из SoundCloud: %w", err)
	}
	artwork := track.ArtworkURL
	if artwork != "" {
		artwork = strings.Replace(artwork, "-large.", "-t500x500.", 1)
		artwork = strings.Replace(artwork, "/large/", "/t500x500/", 1)
	}
	result := soundcloudTrackDetails{
		ID: track.ID, URN: track.URN, Title: track.Title, PermalinkURL: track.PermalinkURL,
		ArtworkURL: artwork, Description: track.Description, Genre: track.Genre, TagList: track.TagList,
		Duration: track.Duration, PlaybackCount: track.PlaybackCount, LikesCount: track.LikesCount,
		RepostsCount: track.RepostsCount, CommentCount: track.CommentCount, CreatedAt: track.CreatedAt,
		DisplayDate: track.DisplayDate, WaveformURL: track.WaveformURL,
	}
	result.User.ID = track.User.ID
	result.User.Username = track.User.Username
	result.User.AvatarURL = track.User.AvatarURL
	result.User.PermalinkURL = track.User.PermalinkURL
	result.User.FollowersCount = track.User.FollowersCount
	log.Printf("track.details stage=complete track_id=%d elapsed_ms=%d", params.TrackID, time.Since(startedAt).Milliseconds())
	return result, nil
}

func (s *service) RPCSearchTracks(params searchTracksParams) ([]soundcloudSearchTrack, error) {
	query := strings.TrimSpace(params.Query)
	if query == "" {
		return []soundcloudSearchTrack{}, nil
	}
	if s.auth.Token == "" {
		return nil, errors.New("сначала подключите аккаунт SoundCloud")
	}
	values := url.Values{}
	values.Set("q", query)
	values.Set("limit", "5")
	endpoint, err := s.soundcloudV2URL("/search/tracks", values)
	if err != nil {
		return nil, fmt.Errorf("не удалось сформировать запрос поиска: %w", err)
	}
	var response struct {
		Collection []struct {
			ID           int64  `json:"id"`
			URN          string `json:"urn"`
			Title        string `json:"title"`
			PermalinkURL string `json:"permalink_url"`
			ArtworkURL   string `json:"artwork_url"`
			Duration     int64  `json:"duration"`
			User         struct {
				Username  string `json:"username"`
				AvatarURL string `json:"avatar_url"`
			} `json:"user"`
		} `json:"collection"`
	}
	startedAt := time.Now()
	log.Printf("tracks.search stage=request query=%q limit=5", query)
	if err := s.getSoundCloudJSON(endpoint, &response); err != nil {
		log.Printf("tracks.search stage=failed elapsed_ms=%d error=%q", time.Since(startedAt).Milliseconds(), err.Error())
		return nil, fmt.Errorf("поиск SoundCloud не выполнен: %w", err)
	}
	results := make([]soundcloudSearchTrack, 0, len(response.Collection))
	for _, item := range response.Collection {
		artwork := item.ArtworkURL
		if artwork == "" {
			artwork = item.User.AvatarURL
		}
		if artwork != "" {
			artwork = strings.Replace(artwork, "-large.", "-t300x300.", 1)
		}
		trackURN := item.URN
		if trackURN == "" {
			trackURN = fmt.Sprintf("soundcloud:tracks:%d", item.ID)
		}
		result := soundcloudSearchTrack{ID: item.ID, URN: trackURN, Title: item.Title, PermalinkURL: item.PermalinkURL, ArtworkURL: artwork, Duration: item.Duration}
		result.User.Username = item.User.Username
		result.User.AvatarURL = item.User.AvatarURL
		results = append(results, result)
	}
	log.Printf("tracks.search stage=complete count=%d elapsed_ms=%d", len(results), time.Since(startedAt).Milliseconds())
	return results, nil
}

func (s *service) RPCTrackRelated(params relatedTracksParams) ([]soundcloudSearchTrack, error) {
	if s.auth.Token == "" {
		return nil, errors.New("сначала подключите аккаунт SoundCloud")
	}
	if params.TrackID <= 0 {
		return nil, errors.New("некорректный ID трека")
	}
	query := url.Values{}
	query.Set("limit", "10")
	endpoint, err := s.soundcloudV2URL("/tracks/"+strconv.FormatInt(params.TrackID, 10)+"/related", query)
	if err != nil {
		return nil, fmt.Errorf("не удалось сформировать запрос похожих треков: %w", err)
	}
	var response struct {
		Collection []struct {
			ID           int64  `json:"id"`
			URN          string `json:"urn"`
			Title        string `json:"title"`
			PermalinkURL string `json:"permalink_url"`
			ArtworkURL   string `json:"artwork_url"`
			Duration     int64  `json:"duration"`
			User         struct {
				Username  string `json:"username"`
				AvatarURL string `json:"avatar_url"`
			} `json:"user"`
		} `json:"collection"`
	}
	startedAt := time.Now()
	log.Printf("track.related stage=request track_id=%d limit=10", params.TrackID)
	if err := s.getSoundCloudJSON(endpoint, &response); err != nil {
		log.Printf("track.related stage=failed track_id=%d elapsed_ms=%d error=%q", params.TrackID, time.Since(startedAt).Milliseconds(), err.Error())
		return nil, fmt.Errorf("не удалось загрузить похожие треки: %w", err)
	}
	results := make([]soundcloudSearchTrack, 0, len(response.Collection))
	for _, item := range response.Collection {
		track := normalizeSearchTrack(item.ID, item.URN, item.Title, item.PermalinkURL, item.ArtworkURL, item.User.AvatarURL, item.Duration, item.User.Username)
		results = append(results, track)
	}
	log.Printf("track.related stage=complete track_id=%d count=%d elapsed_ms=%d", params.TrackID, len(results), time.Since(startedAt).Milliseconds())
	return results, nil
}

func (s *service) RPCUserProfile(params userProfileParams) (soundcloudUserProfile, error) {
	if s.auth.Token == "" {
		return soundcloudUserProfile{}, errors.New("сначала подключите аккаунт SoundCloud")
	}
	if params.UserID <= 0 {
		return soundcloudUserProfile{}, errors.New("некорректный ID пользователя")
	}
	endpoint, err := s.soundcloudV2URL("/users/"+strconv.FormatInt(params.UserID, 10), nil)
	if err != nil {
		return soundcloudUserProfile{}, fmt.Errorf("не удалось сформировать запрос профиля: %w", err)
	}
	var user struct {
		ID              int64  `json:"id"`
		Username        string `json:"username"`
		FullName        string `json:"full_name"`
		PermalinkURL    string `json:"permalink_url"`
		AvatarURL       string `json:"avatar_url"`
		Description     string `json:"description"`
		City            string `json:"city"`
		CountryCode     string `json:"country_code"`
		FollowersCount  int64  `json:"followers_count"`
		FollowingsCount int64  `json:"followings_count"`
		TrackCount      int64  `json:"track_count"`
		LikesCount      int64  `json:"likes_count"`
		Verified        bool   `json:"verified"`
		Visuals         struct {
			Visuals []struct {
				VisualURL string `json:"visual_url"`
				URLs      struct {
					URL string `json:"url"`
				} `json:"urls"`
			} `json:"visuals"`
		} `json:"visuals"`
	}
	startedAt := time.Now()
	log.Printf("user.profile stage=request user_id=%d", params.UserID)
	if err := s.getSoundCloudJSON(endpoint, &user); err != nil {
		log.Printf("user.profile stage=failed user_id=%d elapsed_ms=%d error=%q", params.UserID, time.Since(startedAt).Milliseconds(), err.Error())
		return soundcloudUserProfile{}, fmt.Errorf("не удалось загрузить профиль автора: %w", err)
	}
	avatar := user.AvatarURL
	if avatar != "" {
		avatar = strings.Replace(avatar, "-large.", "-t500x500.", 1)
	}
	banner := ""
	if len(user.Visuals.Visuals) > 0 {
		visual := user.Visuals.Visuals[0]
		if visual.VisualURL != "" {
			banner = visual.VisualURL
		} else {
			banner = visual.URLs.URL
		}
	}
	result := soundcloudUserProfile{
		ID: user.ID, Username: user.Username, FullName: user.FullName, PermalinkURL: user.PermalinkURL,
		AvatarURL: avatar, BannerURL: banner, Description: user.Description, City: user.City, Country: user.CountryCode,
		FollowersCount: user.FollowersCount, FollowingsCount: user.FollowingsCount, TrackCount: user.TrackCount, LikesCount: user.LikesCount, Verified: user.Verified,
	}
	log.Printf("user.profile stage=complete user_id=%d elapsed_ms=%d", params.UserID, time.Since(startedAt).Milliseconds())
	return result, nil
}

func (s *service) RPCUserTracks(params userProfileParams) ([]soundcloudTrackCard, error) {
	if s.auth.Token == "" {
		return nil, errors.New("сначала подключите аккаунт SoundCloud")
	}
	if params.UserID <= 0 {
		return nil, errors.New("некорректный ID пользователя")
	}
	query := url.Values{}
	query.Set("limit", "200")
	query.Set("linked_partitioning", "1")
	endpoint, err := s.soundcloudV2URL("/users/"+strconv.FormatInt(params.UserID, 10)+"/tracks", query)
	if err != nil {
		return nil, fmt.Errorf("не удалось сформировать запрос треков автора: %w", err)
	}
	startedAt := time.Now()
	log.Printf("user.tracks stage=request user_id=%d", params.UserID)
	result := make([]soundcloudTrackCard, 0, 200)
	seenTracks := make(map[int64]struct{})
	seenPages := make(map[string]struct{})
	pageCount := 0
	for endpoint != "" && pageCount < 100 {
		if _, duplicate := seenPages[endpoint]; duplicate {
			break
		}
		seenPages[endpoint] = struct{}{}
		pageCount++
		var page struct {
			Collection []soundcloudTrack `json:"collection"`
			NextHref   string            `json:"next_href"`
		}
		if err := s.getSoundCloudJSON(endpoint, &page); err != nil {
			log.Printf("user.tracks stage=failed user_id=%d page=%d elapsed_ms=%d error=%q", params.UserID, pageCount, time.Since(startedAt).Milliseconds(), err.Error())
			return nil, fmt.Errorf("не удалось загрузить треки автора: %w", err)
		}
		for _, track := range page.Collection {
			if _, duplicate := seenTracks[track.ID]; duplicate {
				continue
			}
			seenTracks[track.ID] = struct{}{}
			artwork := track.ArtworkURL
			if artwork != "" {
				artwork = strings.Replace(artwork, "-large.", "-t500x500.", 1)
			}
			trackURN := track.URN
			if trackURN == "" {
				trackURN = fmt.Sprintf("soundcloud:tracks:%d", track.ID)
			}
			item := soundcloudTrackCard{ID: track.ID, TrackURN: trackURN, Title: track.Title, PermalinkURL: track.PermalinkURL, ArtworkURL: artwork, Duration: track.Duration, PlaybackCount: track.PlaybackCount, LikesCount: track.LikesCount}
			item.User.Username = track.User.Username
			result = append(result, item)
		}
		if page.NextHref == "" {
			endpoint = ""
			continue
		}
		endpoint, err = s.soundcloudV2URLFromAbsolute(page.NextHref)
		if err != nil {
			return nil, fmt.Errorf("SoundCloud вернул некорректную ссылку следующей страницы: %w", err)
		}
	}
	log.Printf("user.tracks stage=complete user_id=%d count=%d pages=%d elapsed_ms=%d", params.UserID, len(result), pageCount, time.Since(startedAt).Milliseconds())
	return result, nil
}

func (s *service) RPCUserLikes(params userLikesParams) (soundcloudTrackPage, error) {
	if s.auth.Token == "" {
		return soundcloudTrackPage{}, errors.New("сначала подключите аккаунт SoundCloud")
	}
	if params.UserID <= 0 {
		return soundcloudTrackPage{}, errors.New("некорректный ID пользователя")
	}
	query := url.Values{}
	query.Set("limit", "20")
	query.Set("linked_partitioning", "1")
	endpoint, err := s.soundcloudV2URL("/users/"+strconv.FormatInt(params.UserID, 10)+"/likes", query)
	if err != nil {
		return soundcloudTrackPage{}, fmt.Errorf("не удалось сформировать запрос лайков: %w", err)
	}
	if params.Next != "" {
		endpoint, err = s.soundcloudV2URLFromAbsolute(params.Next)
		if err != nil {
			return soundcloudTrackPage{}, fmt.Errorf("некорректная ссылка следующей страницы лайков: %w", err)
		}
	}
	result := soundcloudTrackPage{Tracks: make([]soundcloudTrackCard, 0, 20)}
	seenTracks := make(map[int64]struct{})
	var response struct {
		Collection []json.RawMessage `json:"collection"`
		NextHref   string            `json:"next_href"`
	}
	if err := s.getSoundCloudJSON(endpoint, &response); err != nil {
		return soundcloudTrackPage{}, fmt.Errorf("не удалось загрузить публичные лайки автора: %w", err)
	}
	for _, item := range response.Collection {
		var wrapped soundcloudLike
		if err := json.Unmarshal(item, &wrapped); err != nil {
			continue
		}
		var track soundcloudTrack
		if wrapped.Track != nil {
			track = *wrapped.Track
		} else if err := json.Unmarshal(item, &track); err != nil || track.ID == 0 {
			continue
		}
		if _, duplicate := seenTracks[track.ID]; duplicate {
			continue
		}
		seenTracks[track.ID] = struct{}{}
		trackURN := track.URN
		if trackURN == "" {
			trackURN = fmt.Sprintf("soundcloud:tracks:%d", track.ID)
		}
		artwork := strings.Replace(track.ArtworkURL, "-large.", "-t500x500.", 1)
		card := soundcloudTrackCard{ID: track.ID, TrackURN: trackURN, Title: track.Title, PermalinkURL: track.PermalinkURL, ArtworkURL: artwork, Duration: track.Duration, PlaybackCount: track.PlaybackCount, LikesCount: track.LikesCount}
		card.User.Username = track.User.Username
		result.Tracks = append(result.Tracks, card)
	}
	if response.NextHref != "" {
		result.NextHref, err = s.soundcloudV2URLFromAbsolute(response.NextHref)
		if err != nil {
			return soundcloudTrackPage{}, fmt.Errorf("SoundCloud вернул некорректную ссылку следующей страницы лайков: %w", err)
		}
	}
	return result, nil
}

func (s *service) RPCUserFollowers(params userSocialParams) (soundcloudSocialPage, error) {
	return s.userSocialPage(params, "followers")
}

func (s *service) RPCUserFollowings(params userSocialParams) (soundcloudSocialPage, error) {
	return s.userSocialPage(params, "followings")
}

func (s *service) userSocialPage(params userSocialParams, relation string) (soundcloudSocialPage, error) {
	if s.auth.Token == "" {
		return soundcloudSocialPage{}, errors.New("сначала подключите аккаунт SoundCloud")
	}
	if params.UserID <= 0 {
		return soundcloudSocialPage{}, errors.New("некорректный ID пользователя")
	}
	query := url.Values{}
	query.Set("limit", "50")
	query.Set("linked_partitioning", "1")
	endpoint, err := s.soundcloudV2URL("/users/"+strconv.FormatInt(params.UserID, 10)+"/"+relation, query)
	if err != nil {
		return soundcloudSocialPage{}, fmt.Errorf("не удалось сформировать запрос списка: %w", err)
	}
	if params.Next != "" {
		endpoint, err = s.soundcloudV2URLFromAbsolute(params.Next)
		if err != nil {
			return soundcloudSocialPage{}, fmt.Errorf("некорректная ссылка следующей страницы: %w", err)
		}
	}
	var source soundcloudSocialSourcePage
	if err := s.getSoundCloudJSON(endpoint, &source); err != nil {
		return soundcloudSocialPage{}, fmt.Errorf("не удалось загрузить список %s: %w", relation, err)
	}
	page := soundcloudSocialPage{NextHref: source.NextHref, Collection: make([]socialUserDTO, 0, len(source.Collection))}
	for _, user := range source.Collection {
		if user.AvatarURL == "" {
			user.AvatarURL = user.AvatarURLCamel
		}
		if user.AvatarURL == "" {
			user.AvatarURL = user.Avatar
		}
		if user.FollowersCount == 0 {
			user.FollowersCount = user.FollowersCamel
		}
		if user.FollowingsCount == 0 {
			user.FollowingsCount = user.FollowingsCamel
		}
		page.Collection = append(page.Collection, socialUserDTO{
			ID: user.ID, Username: user.Username, FullName: user.FullName,
			PermalinkURL: user.PermalinkURL, AvatarURL: user.AvatarURL,
			FollowersCount: user.FollowersCount, FollowingsCount: user.FollowingsCount, TrackCount: user.TrackCount,
		})
	}
	return page, nil
}

func (s *service) RPCUserPlaylists(params userProfileParams) ([]soundcloudPlaylistCard, error) {
	if s.auth.Token == "" {
		return nil, errors.New("сначала подключите аккаунт SoundCloud")
	}
	if params.UserID <= 0 {
		return nil, errors.New("некорректный ID пользователя")
	}
	var lastErr error
	for _, base := range s.apiBases() {
		endpoint, err := url.Parse(strings.TrimRight(base, "/") + fmt.Sprintf("/users/%d/playlists", params.UserID))
		if err != nil {
			lastErr = err
			continue
		}
		query := endpoint.Query()
		query.Set("limit", "200")
		query.Set("linked_partitioning", "true")
		query.Set("client_id", s.settings.ClientID)
		endpoint.RawQuery = query.Encode()
		playlists, err := s.fetchPlaylistsFrom(base, endpoint.String())
		if err == nil {
			return playlists, nil
		}
		lastErr = err
		log.Printf("user.playlists stage=fallback host=%s error=%q", hostForLog(base), err.Error())
	}
	if lastErr == nil {
		lastErr = errors.New("SoundCloud API не вернул плейлисты автора")
	}
	return nil, fmt.Errorf("не удалось загрузить плейлисты автора: %w", lastErr)
}

func (s *service) RPCMixedSelections(_ emptyParams) ([]mixedSelection, error) {
	if s.auth.Token == "" {
		return nil, errors.New("сначала подключите аккаунт SoundCloud")
	}
	query := url.Values{}
	query.Set("oauth_token", s.auth.Token)
	endpoint, err := s.soundcloudV2URL("/mixed-selections", query)
	if err != nil {
		return nil, fmt.Errorf("не удалось сформировать запрос подборок: %w", err)
	}
	var response struct {
		Collection []struct {
			ID          string          `json:"id"`
			Title       string          `json:"title"`
			Description string          `json:"description"`
			Items       json.RawMessage `json:"items"`
		} `json:"collection"`
	}
	startedAt := time.Now()
	log.Printf("mixed-selections stage=request")
	if err := s.getSoundCloudJSON(endpoint, &response); err != nil {
		log.Printf("mixed-selections stage=failed elapsed_ms=%d error=%q", time.Since(startedAt).Milliseconds(), err.Error())
		return nil, fmt.Errorf("не удалось загрузить подборки SoundCloud: %w", err)
	}
	selections := make([]mixedSelection, 0, len(response.Collection))
	for index, item := range response.Collection {
		itemPayloads := mixedSelectionItemPayloads(item.Items)
		selection := mixedSelection{
			ID:          item.ID,
			Title:       item.Title,
			Description: item.Description,
			Tracks:      make([]soundcloudSearchTrack, 0, len(itemPayloads)),
			MadeForYou:  isMadeForYouSelection(item.ID, item.Title),
		}
		seenTrackIDs := make(map[int64]struct{}, len(itemPayloads))
		seenPlaylistIDs := make(map[string]struct{}, len(itemPayloads))
		if selection.ID == "" {
			selection.ID = fmt.Sprintf("selection-%d", index)
		}
		if selection.MadeForYou && selection.Title == "" {
			selection.Title = "Made for you"
		}
		for _, raw := range itemPayloads {
			if playlist, ok := decodeMixedSelectionPlaylist(raw); ok {
				if _, exists := seenPlaylistIDs[playlist.ID]; exists {
					continue
				}
				seenPlaylistIDs[playlist.ID] = struct{}{}
				selection.Playlists = append(selection.Playlists, playlist)
				continue
			}
			candidate, ok := decodeMixedSelectionTrack(raw)
			if !ok {
				continue
			}
			if _, exists := seenTrackIDs[candidate.ID]; exists {
				continue
			}
			seenTrackIDs[candidate.ID] = struct{}{}
			selection.Tracks = append(selection.Tracks, normalizeSearchTrack(candidate.ID, candidate.URN, candidate.Title, candidate.PermalinkURL, candidate.ArtworkURL, candidate.User.AvatarURL, candidate.Duration, candidate.User.Username))
		}
		if selection.Title != "" && (len(selection.Tracks) > 0 || len(selection.Playlists) > 0) {
			selections = append(selections, selection)
		}
	}
	log.Printf("mixed-selections stage=complete count=%d elapsed_ms=%d", len(selections), time.Since(startedAt).Milliseconds())
	return selections, nil
}

func isMadeForYouSelection(id, title string) bool {
	id = strings.ToLower(id)
	title = strings.ToLower(strings.TrimSpace(title))
	return strings.Contains(id, "discovery") || strings.Contains(id, "personalized") || strings.Contains(id, "personalised") ||
		strings.Contains(title, "made for you") || strings.Contains(title, "специально для вас")
}

func decodeMixedSelectionPlaylist(raw json.RawMessage) (soundcloudPlaylistCard, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return soundcloudPlaylistCard{}, false
	}

	var itemType string
	_ = json.Unmarshal(object["type"], &itemType)
	if itemType == "playlist" || itemType == "system-playlist" {
		for _, key := range []string{"playlist", "resource", "item", "data"} {
			if nested, ok := object[key]; ok {
				if playlist, valid := decodeMixedSelectionPlaylistSource(nested); valid {
					return mixedSelectionPlaylistCard(playlist)
				}
			}
		}
		if playlist, valid := decodeMixedSelectionPlaylistSource(raw); valid {
			return mixedSelectionPlaylistCard(playlist)
		}
		return soundcloudPlaylistCard{}, false
	}

	for _, key := range []string{"playlist", "resource", "item", "data"} {
		if nested, ok := object[key]; ok {
			if playlist, valid := decodeMixedSelectionPlaylist(nested); valid {
				return playlist, true
			}
		}
	}

	playlist, valid := decodeMixedSelectionPlaylistSource(raw)
	if !valid || (!strings.Contains(playlist.URN, "soundcloud:playlists:") && object["is_album"] == nil) {
		return soundcloudPlaylistCard{}, false
	}
	return mixedSelectionPlaylistCard(playlist)
}

func decodeMixedSelectionPlaylistSource(raw json.RawMessage) (soundcloudPlaylistSource, bool) {
	var playlist soundcloudPlaylistSource
	if json.Unmarshal(raw, &playlist) != nil || playlist.Title == "" || (playlist.ID <= 0 && playlist.URN == "") {
		return soundcloudPlaylistSource{}, false
	}
	return playlist, true
}

func mixedSelectionPlaylistCard(source soundcloudPlaylistSource) (soundcloudPlaylistCard, bool) {
	playlistURN := source.URN
	if playlistURN == "" && source.ID > 0 {
		playlistURN = fmt.Sprintf("soundcloud:playlists:%d", source.ID)
	}
	playlistID := playlistURN
	if source.ID > 0 {
		playlistID = strconv.FormatInt(source.ID, 10)
	}
	if playlistID == "" || source.Title == "" {
		return soundcloudPlaylistCard{}, false
	}
	playlist := soundcloudPlaylistCard{
		ID:           playlistID,
		URN:          playlistURN,
		Title:        source.Title,
		PermalinkURL: source.PermalinkURL,
		ArtworkURL:   normalizeArtworkURL(source.ArtworkURL),
		TrackCount:   source.TrackCount,
	}
	playlist.User.Username = source.User.Username
	return playlist, true
}

func mixedSelectionItemPayloads(raw json.RawMessage) []json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] == '[' {
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) == nil {
			return items
		}
		return nil
	}
	if trimmed[0] != '{' {
		return nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(trimmed, &object) != nil {
		return nil
	}
	for _, key := range []string{"collection", "items", "tracks", "data"} {
		if nested, ok := object[key]; ok {
			if items := mixedSelectionItemPayloads(nested); len(items) > 0 {
				return items
			}
		}
	}
	return nil
}

func decodeMixedSelectionTrack(raw json.RawMessage) (soundcloudSearchTrackSource, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return soundcloudSearchTrackSource{}, false
	}
	var itemType string
	_ = json.Unmarshal(object["type"], &itemType)
	if itemType == "playlist" || itemType == "system-playlist" {
		return soundcloudSearchTrackSource{}, false
	}
	var source soundcloudSearchTrackSource
	if json.Unmarshal(raw, &source) == nil && source.ID > 0 && source.Title != "" {
		return source, true
	}
	for _, key := range []string{"track", "item", "resource", "data"} {
		if nested, ok := object[key]; ok {
			if source, valid := decodeMixedSelectionTrack(nested); valid {
				return source, true
			}
		}
	}
	return soundcloudSearchTrackSource{}, false
}

func normalizeSearchTrack(id int64, urn, title, permalinkURL, artworkURL, avatarURL string, duration int64, username string) soundcloudSearchTrack {
	if artworkURL == "" {
		artworkURL = avatarURL
	}
	if artworkURL != "" {
		artworkURL = strings.Replace(artworkURL, "-large.", "-t300x300.", 1)
	}
	if urn == "" {
		urn = fmt.Sprintf("soundcloud:tracks:%d", id)
	}
	track := soundcloudSearchTrack{ID: id, URN: urn, Title: title, PermalinkURL: permalinkURL, ArtworkURL: artworkURL, Duration: duration}
	track.User.Username = username
	return track
}

func (s *service) RPCTrackLike(params trackLikeParams) (trackLikeResult, error) {
	return trackLikeResponse(s.setTrackLiked(params.TrackID, params.TrackURN, true, params.DataDomeCookie), true)
}

func (s *service) RPCTrackUnlike(params trackLikeParams) (trackLikeResult, error) {
	return trackLikeResponse(s.setTrackLiked(params.TrackID, params.TrackURN, false, params.DataDomeCookie), false)
}

func trackLikeResponse(err error, requestedLiked bool) (trackLikeResult, error) {
	if err == nil {
		return trackLikeResult{Liked: requestedLiked}, nil
	}
	var challenge *captchaChallengeError
	if errors.As(err, &challenge) {
		return trackLikeResult{Liked: !requestedLiked, CaptchaURL: challenge.URL}, nil
	}
	return trackLikeResult{}, err
}

func (s *service) setTrackLiked(trackID int64, trackURN string, liked bool, dataDomeCookie string) error {
	action := "unlike"
	if liked {
		action = "like"
	}
	startedAt := time.Now()
	if s.auth.Token == "" {
		log.Printf("track.%s stage=auth_error track_id=%d error=%q", action, trackID, "account is not connected")
		return errors.New("сначала подключите аккаунт SoundCloud")
	}
	if trackID <= 0 {
		log.Printf("track.%s stage=validation_error track_id=%d error=%q", action, trackID, "invalid track id")
		return errors.New("некорректный ID трека")
	}
	if strings.TrimSpace(trackURN) == "" {
		trackURN = fmt.Sprintf("soundcloud:tracks:%d", trackID)
	}
	if len(dataDomeCookie) > 4096 || strings.IndexFunc(dataDomeCookie, func(character rune) bool {
		return character < 0x21 || character > 0x7e || strings.ContainsRune(";,\\\"", character)
	}) >= 0 {
		return errors.New("некорректная cookie проверки SoundCloud")
	}
	method := http.MethodDelete
	if liked {
		method = http.MethodPost
	}
	var lastErr error
	var attempts []string
	bases := s.apiBases()
	if len(bases) > 1 {
		bases = bases[:1]
	}
	for _, base := range bases {
		requestMethod := method
		isWebAPI := base == webAPIBase || (s.apiBase != "" && s.apiBase != officialAPIBase && base == s.apiBase)
		endpoint := fmt.Sprintf("%s/likes/tracks/%s", strings.TrimRight(base, "/"), url.PathEscape(trackURN))
		if isWebAPI {
			if s.auth.Profile.ID <= 0 {
				return errors.New("не удалось определить ID аккаунта SoundCloud для изменения лайка")
			}
			endpoint = fmt.Sprintf("%s/users/%d/track_likes/%d", strings.TrimRight(base, "/"), s.auth.Profile.ID, trackID)
			parsed, err := url.Parse(endpoint)
			if err != nil {
				return err
			}
			query := parsed.Query()
			query.Set("client_id", s.settings.ClientID)
			parsed.RawQuery = query.Encode()
			endpoint = parsed.String()
			if liked {
				requestMethod = http.MethodPut
			}
		}
		log.Printf("track.%s stage=request host=%s track_id=%d method=%s", action, hostForLog(base), trackID, requestMethod)
		req, err := http.NewRequest(requestMethod, endpoint, nil)
		if err != nil {
			log.Printf("track.%s stage=request_build_error track_id=%d error=%q", action, trackID, err.Error())
			return err
		}
		req.Header.Set("Authorization", "OAuth "+s.auth.Token)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", userAgent)
		if dataDomeCookie != "" {
			req.Header.Set("Cookie", "datadome="+dataDomeCookie)
			req.Header.Set("X-Datadome-ClientId", dataDomeCookie)
		}
		if base == webAPIBase {
			req.Header.Set("Origin", "https://soundcloud.com")
			req.Header.Set("Referer", "https://soundcloud.com/")
		}
		resp, err := s.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("SoundCloud недоступен, проверьте подключение к интернету: %w", err)
			log.Printf("track.%s stage=transport_error host=%s track_id=%d error=%q", action, hostForLog(base), trackID, err.Error())
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		bodyText := strings.TrimSpace(string(body))
		if s.auth.Token != "" {
			bodyText = strings.ReplaceAll(bodyText, s.auth.Token, "[redacted]")
		}
		bodyText = strings.Join(strings.Fields(bodyText), " ")
		challengeURL := ""
		if resp.StatusCode == http.StatusForbidden {
			challengeURL = extractCaptchaURL(resp.Header, body)
			if challengeURL != "" {
				bodyText = "[captcha challenge response; URL omitted]"
			}
		}
		if len(bodyText) > 600 {
			bodyText = bodyText[:600] + "…"
		}
		log.Printf("track.%s stage=response host=%s track_id=%d status=%d content_type=%q body=%q read_error=%v", action, hostForLog(base), trackID, resp.StatusCode, resp.Header.Get("Content-Type"), bodyText, readErr)
		if challengeURL != "" {
			log.Printf("track.%s stage=captcha_challenge track_id=%d", action, trackID)
			return &captchaChallengeError{URL: challengeURL}
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			log.Printf("track.%s stage=complete track_id=%d elapsed_ms=%d", action, trackID, time.Since(startedAt).Milliseconds())
			return nil
		}
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			message := fmt.Sprintf("%s вернул HTTP %d", hostForLog(base), resp.StatusCode)
			if bodyText != "" {
				message += ": " + bodyText
			}
			attempts = append(attempts, message)
			lastErr = fmt.Errorf("SoundCloud отклонил запрос изменения лайка: %s", message)
		case http.StatusTooManyRequests:
			lastErr = errors.New("SoundCloud временно ограничил запросы (HTTP 429), повторите позже")
			attempts = append(attempts, fmt.Sprintf("%s вернул HTTP 429", hostForLog(base)))
		default:
			message := fmt.Sprintf("%s вернул HTTP %d", hostForLog(base), resp.StatusCode)
			if bodyText != "" {
				message += ": " + bodyText
			}
			attempts = append(attempts, message)
			lastErr = fmt.Errorf("SoundCloud вернул ошибку при изменении лайка: %s", message)
		}
	}
	if len(attempts) > 1 {
		lastErr = fmt.Errorf("изменить лайк не удалось: %s", strings.Join(attempts, "; "))
	}
	if lastErr == nil {
		lastErr = errors.New("не удалось изменить лайк SoundCloud")
	}
	log.Printf("track.%s stage=failed track_id=%d elapsed_ms=%d error=%q", action, trackID, time.Since(startedAt).Milliseconds(), lastErr.Error())
	return lastErr
}

func extractCaptchaURL(headers http.Header, body []byte) string {
	if candidate := safeChallengeURL(headers.Get("Location")); candidate != "" {
		return candidate
	}
	var payload any
	if json.Unmarshal(body, &payload) == nil {
		if candidate := findChallengeURL(payload); candidate != "" {
			return candidate
		}
	}

	remaining := string(body)
	for {
		start := strings.Index(remaining, "https://")
		if start < 0 {
			return ""
		}
		remaining = remaining[start:]
		end := strings.IndexAny(remaining, " \t\r\n\"'<>]")
		candidate := remaining
		if end >= 0 {
			candidate = remaining[:end]
		}
		candidate = strings.TrimRight(candidate, ",.;:)")
		if safe := safeChallengeURL(candidate); safe != "" {
			return safe
		}
		if end < 0 {
			return ""
		}
		remaining = remaining[end:]
	}
}

func findChallengeURL(value any) string {
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			name := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
			if candidate, ok := nested.(string); ok && (name == "url" || name == "location" || name == "redirect" || strings.Contains(name, "captcha") || strings.Contains(name, "challenge")) {
				if safe := safeChallengeURL(candidate); safe != "" {
					return safe
				}
			}
			if safe := findChallengeURL(nested); safe != "" {
				return safe
			}
		}
	case []any:
		for _, nested := range typed {
			if safe := findChallengeURL(nested); safe != "" {
				return safe
			}
		}
	}
	return ""
}

func safeChallengeURL(candidate string) string {
	parsed, err := url.Parse(strings.TrimSpace(candidate))
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return ""
	}
	return parsed.String()
}

// authStatus отдаёт renderer-у только признак входа и профиль.
// Сам токен никогда не покидает Go sidecar.
func (s *service) authStatus() authStatus {
	if s.auth.Token == "" {
		return authStatus{Authorized: false}
	}
	user := s.auth.Profile
	return authStatus{Authorized: true, Profile: &user}
}

func (s *service) fetchProfile(token string) (profile, error) {
	bases := s.apiBases()
	var lastErr error
	for _, base := range bases {
		user, err := s.fetchProfileFrom(base, token)
		if err == nil {
			return user, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("SoundCloud недоступен")
	}
	return profile{}, lastErr
}

func (s *service) fetchProfileFrom(base, token string) (profile, error) {
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(base, "/")+"/me", nil)
	if err != nil {
		return profile{}, err
	}
	req.Header.Set("Authorization", "OAuth "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if base == webAPIBase {
		req.Header.Set("Origin", "https://soundcloud.com")
		req.Header.Set("Referer", "https://soundcloud.com/")
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return profile{}, fmt.Errorf("SoundCloud недоступен, проверьте подключение к интернету: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return profile{}, fmt.Errorf("%w (HTTP %d)", errTokenRejected, resp.StatusCode)
	case resp.StatusCode == http.StatusTooManyRequests:
		return profile{}, errors.New("SoundCloud временно ограничил запросы (HTTP 429), повторите позже")
	case resp.StatusCode != http.StatusOK:
		return profile{}, fmt.Errorf("SoundCloud вернул HTTP %d", resp.StatusCode)
	}

	var user soundcloudUser
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	if err := decoder.Decode(&user); err != nil || user.ID == 0 || user.Username == "" {
		return profile{}, errors.New("SoundCloud вернул неожиданный ответ при проверке токена")
	}
	return profileFrom(user), nil
}

func (s *service) fetchMyTracks(token string, userID int64) ([]soundcloudTrackCard, error) {
	var lastErr error
	if userID == 0 {
		log.Printf("tracks.mine stage=profile error=missing_user_id")
		return nil, errors.New("SoundCloud не вернул ID аккаунта для загрузки треков")
	}
	log.Printf("tracks.mine stage=start user_id=%d", userID)
	// The Python entrypoint displays get_user_likes(), not get_user_tracks().
	// Match its endpoint and query so the desktop shows the same library items.
	for _, base := range s.apiBases() {
		endpoint := fmt.Sprintf("%s/users/%d/likes?limit=200&linked_partitioning=true", strings.TrimRight(base, "/"), userID)
		log.Printf("tracks.mine stage=request host=%s path=/users/%d/likes", hostForLog(base), userID)
		pageURL := endpoint
		seenPageURLs := make(map[string]bool)
		likes := make([]soundcloudLike, 0)
		pageCount := 0
		failed := false
		for pageURL != "" {
			if pageCount >= 250 {
				lastErr = errors.New("SoundCloud вернул слишком много страниц лайков (лимит 250)")
				failed = true
				break
			}
			parsedPage, err := url.Parse(pageURL)
			parsedBase, baseErr := url.Parse(base)
			if err != nil || baseErr != nil || parsedPage.Scheme != "https" || parsedPage.Host != parsedBase.Host {
				lastErr = errors.New("SoundCloud вернул некорректную ссылку следующей страницы")
				failed = true
				break
			}
			if seenPageURLs[pageURL] {
				lastErr = errors.New("SoundCloud вернул повторяющуюся ссылку страницы лайков")
				failed = true
				break
			}
			seenPageURLs[pageURL] = true
			pageCount++
			req, err := http.NewRequest(http.MethodGet, pageURL, nil)
			if err != nil {
				lastErr = err
				failed = true
				break
			}
			req.Header.Set("Authorization", "OAuth "+token)
			req.Header.Set("Accept", "application/json")
			req.Header.Set("User-Agent", userAgent)
			if base == webAPIBase {
				req.Header.Set("Origin", "https://soundcloud.com")
				req.Header.Set("Referer", "https://soundcloud.com/")
			}
			resp, err := s.httpClient.Do(req)
			if err != nil {
				lastErr = fmt.Errorf("SoundCloud недоступен, проверьте подключение к интернету: %w", err)
				log.Printf("tracks.mine stage=response host=%s page=%d error=%q", hostForLog(base), pageCount, err.Error())
				failed = true
				break
			}
			log.Printf("tracks.mine stage=response host=%s page=%d status=%d content_type=%q", hostForLog(base), pageCount, resp.StatusCode, resp.Header.Get("Content-Type"))
			if resp.StatusCode != http.StatusOK {
				resp.Body.Close()
				// 401/403: токен отклонён этим хостом (истёкший web-токен
				// или токен другого типа). Если страницы ещё не прочитаны —
				// пробуем следующий базовый URL; иначе сообщаем.
				// 401/403: токен отклонён этим хостом. На первой странице —
				// пробуем следующий базовый URL; дальше — сообщаем.
				if (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) && pageCount == 1 {
					lastErr = errTokenRejected
				} else {
					lastErr = fmt.Errorf("SoundCloud вернул HTTP %d при загрузке страницы лайков %d", resp.StatusCode, pageCount)
				}
				log.Printf("tracks.mine stage=http_error host=%s page=%d status=%d", hostForLog(base), pageCount, resp.StatusCode)
				failed = true
				break
			}
			data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
			resp.Body.Close()
			if err != nil {
				lastErr = fmt.Errorf("не удалось прочитать страницу лайков: %w", err)
				log.Printf("tracks.mine stage=body_read page=%d error=%q", pageCount, err.Error())
				failed = true
				break
			}
			var payload struct {
				Collection []soundcloudLike `json:"collection"`
				NextHref   string           `json:"next_href"`
			}
			if err := json.Unmarshal(data, &payload); err != nil {
				lastErr = fmt.Errorf("не удалось разобрать страницу лайков: %w", err)
				log.Printf("tracks.mine stage=parse page=%d error=%q", pageCount, err.Error())
				failed = true
				break
			}
			likes = append(likes, payload.Collection...)
			log.Printf("tracks.mine stage=parse page=%d count=%d total=%d has_next=%t", pageCount, len(payload.Collection), len(likes), payload.NextHref != "")
			pageURL = payload.NextHref
		}
		if failed {
			continue
		}
		log.Printf("tracks.mine stage=parse shape=collection count=%d pages=%d", len(likes), pageCount)
		result := make([]soundcloudTrackCard, 0, len(likes))
		seenTrackIDs := make(map[int64]struct{}, len(likes))
		for _, like := range likes {
			if like.Track == nil {
				continue
			}
			track := *like.Track
			if _, exists := seenTrackIDs[track.ID]; exists {
				continue
			}
			seenTrackIDs[track.ID] = struct{}{}
			artwork := track.ArtworkURL
			if strings.Contains(artwork, "-large.") {
				artwork = strings.Replace(artwork, "-large.", "-t500x500.", 1)
			}
			trackURN := track.URN
			if trackURN == "" {
				trackURN = fmt.Sprintf("soundcloud:tracks:%d", track.ID)
			}
			item := soundcloudTrackCard{ID: track.ID, TrackURN: trackURN, Title: track.Title, PermalinkURL: track.PermalinkURL, ArtworkURL: artwork, Duration: track.Duration, PlaybackCount: track.PlaybackCount, LikesCount: track.LikesCount}
			item.User.Username = track.User.Username
			result = append(result, item)
		}
		log.Printf("tracks.mine stage=complete count=%d", len(result))
		return result, nil
	}
	if lastErr == nil {
		lastErr = errors.New("не удалось загрузить треки SoundCloud")
	}
	log.Printf("tracks.mine stage=failed error=%q", lastErr.Error())
	return nil, lastErr
}

func hostForLog(base string) string {
	if strings.HasPrefix(base, "https://") {
		return strings.TrimPrefix(base, "https://")
	}
	return base
}

// apiBases перечисляет хосты SoundCloud в порядке проверки. Токены веб-сессии
// SoundCloud обслуживает api-v2, а OAuth-токены зарегистрированных приложений —
// официальный api.soundcloud.com, поэтому пробуем оба.
func (s *service) apiBases() []string {
	base := strings.TrimRight(strings.TrimSpace(s.apiBase), "/")
	if base != "" && base != officialAPIBase {
		return []string{base}
	}
	return []string{webAPIBase, officialAPIBase}
}

func profileFrom(user soundcloudUser) profile {
	avatar := user.AvatarURL
	if strings.Contains(avatar, "-large.") {
		avatar = strings.Replace(avatar, "-large.", "-t500x500.", 1)
	}
	return profile{
		ID:             user.ID,
		Username:       user.Username,
		FullName:       user.FullName,
		PermalinkURL:   user.PermalinkURL,
		AvatarURL:      avatar,
		City:           user.City,
		Country:        user.Country,
		FollowersCount: user.FollowersCount,
		TrackCount:     user.TrackCount,
		LikesCount:     user.LikesCount,
	}
}

func (s *service) loadSettings() error {
	data, err := os.ReadFile(s.settingsPath)
	if errors.Is(err, os.ErrNotExist) {
		return s.saveSettings(s.settings)
	}
	if err != nil {
		return fmt.Errorf("read settings: %w", err)
	}
	loaded := defaultSettings()
	if err := json.Unmarshal(data, &loaded); err != nil {
		// Corrupt file must not stop the app. Back it up and use defaults.
		_ = os.Rename(s.settingsPath, s.settingsPath+".bak")
		s.settings = defaultSettings()
		return s.saveSettings(s.settings)
	}
	if !validAccent(loaded.Accent) || loaded.Volume < 0 || loaded.Volume > 100 || (loaded.ClientID != "" && !validSoundCloudClientID(loaded.ClientID)) || !validBackgroundImage(loaded.BackgroundImage) || loaded.BackgroundBlur < 0 || loaded.BackgroundBlur > 24 {
		_ = os.Rename(s.settingsPath, s.settingsPath+".bak")
		s.settings = defaultSettings()
		return s.saveSettings(s.settings)
	}
	s.settings = loaded
	return nil
}

func (s *service) saveSettings(value settings) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeSecretFile(s.settingsPath, data)
}

func (s *service) loadHistory() error {
	data, err := os.ReadFile(s.historyPath)
	if errors.Is(err, os.ErrNotExist) {
		s.history = nil
		return nil
	}
	if err != nil {
		return fmt.Errorf("read history: %w", err)
	}
	var loaded []soundcloudTrackCard
	if err := json.Unmarshal(data, &loaded); err != nil {
		return fmt.Errorf("parse history: %w", err)
	}
	seen := make(map[int64]struct{}, len(loaded))
	s.history = make([]soundcloudTrackCard, 0, min(len(loaded), maxRecentTracks))
	for _, track := range loaded {
		if track.ID <= 0 || strings.TrimSpace(track.Title) == "" {
			continue
		}
		if _, exists := seen[track.ID]; exists {
			continue
		}
		seen[track.ID] = struct{}{}
		s.history = append(s.history, track)
		if len(s.history) == maxRecentTracks {
			break
		}
	}
	if len(s.history) != len(loaded) {
		return s.saveHistory(s.history)
	}
	return nil
}

func (s *service) saveHistory(value []soundcloudTrackCard) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeSecretFile(s.historyPath, data)
}

func (s *service) loadAuth() error {
	data, err := os.ReadFile(s.authPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read auth: %w", err)
	}
	var loaded authState
	if err := json.Unmarshal(data, &loaded); err != nil {
		return fmt.Errorf("parse auth: %w", err)
	}
	if strings.TrimSpace(loaded.Token) == "" {
		return errors.New("saved auth token is empty")
	}
	s.auth = loaded
	return nil
}

func (s *service) saveAuth(value authState) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeSecretFile(s.authPath, data)
}

func (s *service) clearAuth() error {
	return removeFileIfExists(s.authPath)
}

func removeFileIfExists(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// writeSecretFile атомарно пишет JSON с правами 0600: файл может содержать токен.
func writeSecretFile(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func appDataDir() (string, error) {
	if configured := os.Getenv("BSC_DATA_DIR"); configured != "" {
		return configured, nil
	}
	userConfig, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return migrateLegacyDataDir(filepath.Join(userConfig, appName), filepath.Join(userConfig, legacyAppName)), nil
}

// migrateLegacyDataDir carries the files from the previous app name across to the current one.
//
// It is written to be safe to run more than once rather than guarded by a marker file. Each file is
// copied only when the new location does not already have it, so a run interrupted halfway resumes
// where it stopped instead of leaving half a profile behind, and a user who has already been
// migrated pays nothing for the check.
//
// The old directory is left in place. Deleting it is the one irreversible step here and it is not
// worth taking to save a few hundred kilobytes: if the copy turns out to have missed something, the
// original is still there to fall back to.
//
// Failures are logged and swallowed. A migration problem must not stop the app from starting — the
// user would see a signed-out app with no way to tell it apart from a real session problem.
func migrateLegacyDataDir(dir, legacy string) string {
	entries, err := os.ReadDir(legacy)
	if err != nil {
		// No previous install, which is the ordinary case for a fresh machine.
		return dir
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("data_dir stage=migrate_mkdir_failed dir=%q error=%q", dir, err.Error())
		return dir
	}

	moved := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		target := filepath.Join(dir, entry.Name())
		if _, err := os.Stat(target); err == nil {
			continue
		}
		if err := copyDataFile(filepath.Join(legacy, entry.Name()), target); err != nil {
			log.Printf("data_dir stage=migrate_copy_failed file=%q error=%q", entry.Name(), err.Error())
			continue
		}
		moved++
	}

	if moved > 0 {
		log.Printf("data_dir stage=migrated from=%q to=%q files=%d", legacy, dir, moved)
	}
	return dir
}

// copyDataFile copies one file, keeping the source file's permissions.
//
// The token files are written 0600 on Unix and that is enforced there. It is worth being honest that
// the same call does nothing on Windows: Go's os package ignores every bit of the mode argument
// there except the write bit and reports 0666 for any writable file, so a file created 0600 on
// Windows already reports 0666. What still holds on both is that the copy is no more permissive than
// its source — a widening here would be a real bug even where the numbers never differ. On Windows
// the protection is the profile ACL that %APPDATA% sits behind, not the mode.
func copyDataFile(from, to string) error {
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if info, err := os.Stat(from); err == nil {
		mode = info.Mode().Perm()
	}
	return os.WriteFile(to, data, mode)
}

func apiBase() string {
	if configured := strings.TrimSpace(os.Getenv("BSC_SOUNDCLOUD_API_BASE")); configured != "" {
		return configured
	}
	return officialAPIBase
}

func defaultSettings() settings {
	return settings{Accent: "#ff765d", Volume: 70, BackgroundBlur: 0}
}

func validSoundCloudClientID(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_') {
			return false
		}
	}
	return true
}

// animatedFileBytes is the largest animation accepted, in bytes of the original file.
//
// The table below stores a character count, which is a different unit and used to disagree with
// this one: a literal figure there quietly became a smaller file limit, because base64 spends four
// characters on every three bytes. maxAnimatedURLLength keeps the two tied together.
const animatedFileBytes = 12 * 1024 * 1024

func maxAnimatedURLLength() int {
	// base64.StdEncoding.EncodedLen is ceil(n/3)*4; the prefix is counted in full on top.
	return len("data:image/gif;base64,") + base64.StdEncoding.EncodedLen(animatedFileBytes)
}

// backgroundFormats maps the data URL prefix to its size ceiling and magic bytes.
//
// The ceilings differ because the encoders differ: a still image is redrawn by the frontend
// and re-encoded as JPEG, while an animation is passed through untouched, since a canvas would
// flatten it to a single frame. Base64 costs about a third more than the raw file in both
// cases, so the animated ceiling is roughly three times the still one.
var backgroundFormats = []struct {
	prefix string
	// magic is the byte signature the decoded payload must start with.
	magic []byte
	// maxLength caps the whole data URL, prefix included.
	maxLength int
}{
	{prefix: "data:image/jpeg;base64,", magic: []byte{0xff, 0xd8, 0xff}, maxLength: 700_000},
	{prefix: "data:image/png;base64,", magic: []byte{0x89, 'P', 'N', 'G'}, maxLength: 700_000},
	{prefix: "data:image/webp;base64,", magic: []byte{'R', 'I', 'F', 'F'}, maxLength: 700_000},
	{prefix: "data:image/gif;base64,", magic: []byte{'G', 'I', 'F', '8'}, maxLength: maxAnimatedURLLength()},
}

func validBackgroundImage(value string) bool {
	if value == "" {
		return true
	}
	for _, format := range backgroundFormats {
		if !strings.HasPrefix(value, format.prefix) {
			continue
		}
		if len(value) > format.maxLength {
			return false
		}
		image, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, format.prefix))
		if err != nil || len(image) < len(format.magic) {
			return false
		}
		// The declared type alone is not enough: the bytes have to carry the same signature,
		// so a data URL labelled image/jpeg cannot smuggle an arbitrary payload through here.
		if !bytes.Equal(image[:len(format.magic)], format.magic) {
			return false
		}
		// GIF87a is the older revision and GIF89a adds the graphic control extension. Both are
		// real GIFs, and the 8 alone does not distinguish them, so the revision byte is ignored.
		return true
	}
	return false
}

func validAccent(value string) bool {
	if len(value) != 7 || value[0] != '#' {
		return false
	}
	for _, char := range value[1:] {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

func writeResponse(writer *bufio.Writer, value response) error {
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		return err
	}
	return writer.Flush()
}
