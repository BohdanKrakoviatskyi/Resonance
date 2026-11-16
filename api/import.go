package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

type resolvePlaylistParams struct {
	URL string `json:"url"`
}

type resolvedSoundCloudPlaylist struct {
	Title      string                `json:"title"`
	ArtworkURL string                `json:"artworkUrl,omitempty"`
	Tracks     []soundcloudTrackCard `json:"tracks"`
}

type userLikesByInputParams struct {
	Input string `json:"input"`
}

type resolvedSoundCloudLikes struct {
	Username   string                `json:"username"`
	AvatarURL  string                `json:"avatarUrl,omitempty"`
	ArtworkURL string                `json:"artworkUrl,omitempty"`
	Tracks     []soundcloudTrackCard `json:"tracks"`
}

var (
	scScriptRe   = regexp.MustCompile(`https://a-v2\.sndcdn\.com/assets/[^"'\s]+\.js`)
	scClientIDRe = regexp.MustCompile(`client_id\s*:\s*["']([a-zA-Z0-9]{24,64})["']`)
)

func (s *service) ensurePublicClientID() (string, error) {
	s.mu.RLock()
	existing := strings.TrimSpace(s.settings.ClientID)
	cached := strings.TrimSpace(s.publicClientID)
	s.mu.RUnlock()
	if existing != "" {
		return existing, nil
	}
	if cached != "" {
		return cached, nil
	}

	req, err := http.NewRequest(http.MethodGet, "https://soundcloud.com/", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "text/html")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("не удалось открыть SoundCloud: %w", err)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	resp.Body.Close()

	scripts := scScriptRe.FindAllString(string(body), -1)
	// Scan from the end because app bundles at the bottom usually hold api-v2 client_id.
	for i := len(scripts) - 1; i >= 0 && i >= len(scripts)-8; i-- {
		sReq, err := http.NewRequest(http.MethodGet, scripts[i], nil)
		if err != nil {
			continue
		}
		sReq.Header.Set("User-Agent", userAgent)
		sResp, err := s.httpClient.Do(sReq)
		if err != nil {
			continue
		}
		jsBytes, _ := io.ReadAll(io.LimitReader(sResp.Body, 6<<20))
		sResp.Body.Close()
		if matches := scClientIDRe.FindSubmatch(jsBytes); len(matches) == 2 {
			cid := string(matches[1])
			s.mu.Lock()
			s.publicClientID = cid
			s.mu.Unlock()
			return cid, nil
		}
	}
	return "", errors.New("не удалось получить публичный client_id SoundCloud")
}

func (s *service) getSoundCloudOptionalAuthJSON(endpoint string, dest any, maxBytes int64) error {
	s.mu.RLock()
	token := strings.TrimSpace(s.auth.Token)
	s.mu.RUnlock()

	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("некорректный адрес SoundCloud: %s", scrubToken(err.Error(), token))
	}
	if token != "" {
		req.Header.Set("Authorization", "OAuth "+token)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Origin", "https://soundcloud.com")
	req.Header.Set("Referer", "https://soundcloud.com/")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return errors.New("сетевая ошибка при обращении к SoundCloud")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("SoundCloud вернул ошибку HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBytes)).Decode(dest); err != nil {
		return fmt.Errorf("ошибка чтения JSON: %s", scrubToken(err.Error(), token))
	}
	return nil
}

func (s *service) resolveSoundCloudRedirect(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", errors.New("некорректная ссылка SoundCloud")
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "on.soundcloud.com" || host == "snd.click" {
		req, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("User-Agent", userAgent)
		resp, err := s.httpClient.Do(req)
		if err != nil {
			return "", fmt.Errorf("не удалось раскрыть короткую ссылку SoundCloud: %w", err)
		}
		finalURL := resp.Request.URL.String()
		resp.Body.Close()
		return finalURL, nil
	}
	return parsed.String(), nil
}

func (s *service) resolveSoundCloudResource(targetURL, clientID string, dest any) error {
	values := url.Values{}
	values.Set("url", targetURL)
	values.Set("client_id", clientID)
	endpoint := webAPIBase + "/resolve?" + values.Encode()
	return s.getSoundCloudOptionalAuthJSON(endpoint, dest, 16<<20)
}

func (s *service) hydratePublicPlaylistTracks(clientID string, playlistTracks []soundcloudTrack) ([]soundcloudTrackCard, error) {
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
		ids := make([]string, end-start)
		for i, id := range trackIDs[start:end] {
			ids[i] = fmt.Sprintf("%d", id)
		}
		values := url.Values{}
		values.Set("ids", strings.Join(ids, ","))
		values.Set("client_id", clientID)
		endpoint := webAPIBase + "/tracks?" + values.Encode()
		var batch []soundcloudTrack
		if err := s.getSoundCloudOptionalAuthJSON(endpoint, &batch, 16<<20); err != nil {
			continue
		}
		for _, track := range batch {
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
		if strings.TrimSpace(track.Title) == "" {
			continue
		}
		trackURN := track.URN
		if trackURN == "" {
			trackURN = fmt.Sprintf("soundcloud:tracks:%d", track.ID)
		}
		artwork := normalizeArtworkURL(track.ArtworkURL)
		card := soundcloudTrackCard{
			ID:            track.ID,
			TrackURN:      trackURN,
			Title:         track.Title,
			PermalinkURL:  track.PermalinkURL,
			ArtworkURL:    artwork,
			Duration:      track.Duration,
			PlaybackCount: track.PlaybackCount,
			LikesCount:    track.LikesCount,
		}
		card.User.Username = track.User.Username
		ordered = append(ordered, card)
	}
	return ordered, nil
}

func (s *service) RPCResolvePlaylist(params resolvePlaylistParams) (resolvedSoundCloudPlaylist, error) {
	rawURL := strings.TrimSpace(params.URL)
	if rawURL == "" {
		return resolvedSoundCloudPlaylist{}, errors.New("укажите ссылку на плейлист SoundCloud")
	}
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		rawURL = "https://" + rawURL
	}
	resolvedURL, err := s.resolveSoundCloudRedirect(rawURL)
	if err != nil {
		return resolvedSoundCloudPlaylist{}, err
	}
	clientID, err := s.ensurePublicClientID()
	if err != nil {
		return resolvedSoundCloudPlaylist{}, err
	}

	var payload struct {
		Kind         string            `json:"kind"`
		ID           int64             `json:"id"`
		Title        string            `json:"title"`
		ArtworkURL   string            `json:"artwork_url"`
		Tracks       []soundcloudTrack `json:"tracks"`
		Collection   []soundcloudTrack `json:"collection"`
		PermalinkURL string            `json:"permalink_url"`
		User         struct {
			Username string `json:"username"`
		} `json:"user"`
	}
	if err := s.resolveSoundCloudResource(resolvedURL, clientID, &payload); err != nil {
		return resolvedSoundCloudPlaylist{}, fmt.Errorf("не удалось загрузить плейлист SoundCloud: %w", err)
	}
	if payload.Kind != "" && payload.Kind != "playlist" {
		if payload.Kind == "user" {
			likes, likesErr := s.RPCUserLikesByInput(userLikesByInputParams{Input: resolvedURL})
			if likesErr != nil {
				return resolvedSoundCloudPlaylist{}, likesErr
			}
			title := strings.TrimSpace(likes.Username)
			if title != "" {
				title = title + " · Likes"
			} else {
				title = "SoundCloud Likes"
			}
			return resolvedSoundCloudPlaylist{
				Title:      title,
				ArtworkURL: likes.ArtworkURL,
				Tracks:     likes.Tracks,
			}, nil
		}
		return resolvedSoundCloudPlaylist{}, errors.New("ссылка не указывает на плейлист SoundCloud")
	}

	rawTracks := payload.Tracks
	if rawTracks == nil {
		rawTracks = payload.Collection
	}
	cards, err := s.hydratePublicPlaylistTracks(clientID, rawTracks)
	if err != nil {
		return resolvedSoundCloudPlaylist{}, err
	}
	if len(cards) == 0 {
		return resolvedSoundCloudPlaylist{}, errors.New("плейлист SoundCloud пуст или недоступен")
	}
	artwork := normalizeArtworkURL(payload.ArtworkURL)
	if artwork == "" {
		for _, c := range cards {
			if c.ArtworkURL != "" {
				artwork = c.ArtworkURL
				break
			}
		}
	}
	title := strings.TrimSpace(payload.Title)
	if title == "" {
		title = "SoundCloud Playlist"
	}
	return resolvedSoundCloudPlaylist{
		Title:      title,
		ArtworkURL: artwork,
		Tracks:     cards,
	}, nil
}

func (s *service) RPCUserLikesByInput(params userLikesByInputParams) (resolvedSoundCloudLikes, error) {
	trimmed := strings.TrimSpace(params.Input)
	if trimmed == "" {
		return resolvedSoundCloudLikes{}, errors.New("введите имя пользователя или ссылку SoundCloud")
	}

	profileURL := ""
	if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") || strings.Contains(trimmed, "soundcloud.com/") {
		if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
			trimmed = "https://" + trimmed
		}
		expanded, err := s.resolveSoundCloudRedirect(trimmed)
		if err != nil {
			return resolvedSoundCloudLikes{}, err
		}
		parsed, err := url.Parse(expanded)
		if err != nil {
			return resolvedSoundCloudLikes{}, errors.New("некорректная ссылка SoundCloud")
		}
		segs := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		if len(segs) == 0 || segs[0] == "" {
			return resolvedSoundCloudLikes{}, errors.New("не удалось определить пользователя SoundCloud из ссылки")
		}
		profileURL = "https://soundcloud.com/" + segs[0]
	} else {
		handle := strings.TrimPrefix(trimmed, "@")
		handle = strings.Trim(handle, "/")
		if handle == "" || strings.ContainsAny(handle, " \t\n/?#") {
			return resolvedSoundCloudLikes{}, errors.New("некорректное имя пользователя SoundCloud")
		}
		profileURL = "https://soundcloud.com/" + url.PathEscape(handle)
	}

	clientID, err := s.ensurePublicClientID()
	if err != nil {
		return resolvedSoundCloudLikes{}, err
	}

	var user struct {
		Kind      string `json:"kind"`
		ID        int64  `json:"id"`
		Username  string `json:"username"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := s.resolveSoundCloudResource(profileURL, clientID, &user); err != nil {
		return resolvedSoundCloudLikes{}, fmt.Errorf("пользователь SoundCloud не найден: %w", err)
	}
	if user.ID <= 0 {
		return resolvedSoundCloudLikes{}, errors.New("пользователь SoundCloud не найден")
	}

	pageURL := fmt.Sprintf("%s/users/%d/likes?limit=200&linked_partitioning=1&client_id=%s", webAPIBase, user.ID, url.QueryEscape(clientID))
	seenPages := make(map[string]bool)
	seenTracks := make(map[int64]struct{})
	cards := make([]soundcloudTrackCard, 0)

	for page := 0; pageURL != "" && page < 100; page++ {
		parsedPage, err := url.Parse(pageURL)
		if err != nil || parsedPage.Scheme != "https" || !strings.EqualFold(parsedPage.Host, "api-v2.soundcloud.com") {
			break
		}
		q := parsedPage.Query()
		q.Set("client_id", clientID)
		parsedPage.RawQuery = q.Encode()
		canonical := parsedPage.String()
		if seenPages[canonical] {
			break
		}
		seenPages[canonical] = true

		var payload struct {
			Collection []json.RawMessage `json:"collection"`
			NextHref   string            `json:"next_href"`
		}
		if err := s.getSoundCloudOptionalAuthJSON(canonical, &payload, 16<<20); err != nil {
			if len(cards) > 0 {
				break
			}
			return resolvedSoundCloudLikes{}, fmt.Errorf("не удалось загрузить лайки пользователя: %w", err)
		}
		for _, item := range payload.Collection {
			var wrapped soundcloudLike
			if json.Unmarshal(item, &wrapped) != nil {
				continue
			}
			var track soundcloudTrack
			if wrapped.Track != nil {
				track = *wrapped.Track
			} else if json.Unmarshal(item, &track) != nil || track.ID == 0 {
				continue
			}
			if _, exists := seenTracks[track.ID]; exists || strings.TrimSpace(track.Title) == "" {
				continue
			}
			seenTracks[track.ID] = struct{}{}
			trackURN := track.URN
			if trackURN == "" {
				trackURN = fmt.Sprintf("soundcloud:tracks:%d", track.ID)
			}
			artwork := normalizeArtworkURL(track.ArtworkURL)
			card := soundcloudTrackCard{
				ID:            track.ID,
				TrackURN:      trackURN,
				Title:         track.Title,
				PermalinkURL:  track.PermalinkURL,
				ArtworkURL:    artwork,
				Duration:      track.Duration,
				PlaybackCount: track.PlaybackCount,
				LikesCount:    track.LikesCount,
			}
			card.User.Username = track.User.Username
			cards = append(cards, card)
		}
		pageURL = payload.NextHref
	}

	if len(cards) == 0 {
		return resolvedSoundCloudLikes{}, errors.New("у пользователя нет публичных лайков")
	}

	avatar := normalizeArtworkURL(user.AvatarURL)
	artwork := avatar
	if artwork == "" {
		for _, c := range cards {
			if c.ArtworkURL != "" {
				artwork = c.ArtworkURL
				break
			}
		}
	}
	username := strings.TrimSpace(user.Username)
	if username == "" {
		username = "SoundCloud"
	}
	return resolvedSoundCloudLikes{
		Username:   username,
		AvatarURL:  avatar,
		ArtworkURL: artwork,
		Tracks:     cards,
	}, nil
}
