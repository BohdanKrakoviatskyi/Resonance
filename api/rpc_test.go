package main

import (
	"sort"
	"testing"
)

// TestRPCMethodNames pins the RPC method names the frontend calls. Renaming
// a Go method silently changes its RPC name (reflection dispatch), which
// would surface only as "unknown method" at runtime.
func TestRPCMethodNames(t *testing.T) {
	want := []string{
		"app.info",
		"auth.login",
		"auth.logout",
		"auth.refresh",
		"auth.status",
		"cache.clear",
		"frontend.backup",
		"frontend.restore",
		"history.clear",
		"history.list",
		"history.record",
		"mixed.selections",
		"playlist.tracks",
		"playlists.mine",
		"resolve.playlist",
		"search.tracks",
		"settings.clear",
		"settings.get",
		"settings.update",
		"track.details",
		"track.like",
		"track.lyrics",
		"track.related",
		"track.stream",
		"track.unlike",
		"tracks.mine",
		"user.followers",
		"user.followings",
		"user.likes",
		"user.likes.by.input",
		"user.playlists",
		"user.profile",
		"user.tracks",
	}
	methods := rpcMethods()
	got := make([]string, 0, len(methods))
	for name := range methods {
		got = append(got, name)
	}
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("RPC method count changed: got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("RPC methods changed: got %v, want %v", got, want)
		}
	}
}

func TestRPCNameFromGo(t *testing.T) {
	cases := map[string]string{
		"RPCAppInfo":            "app.info",
		"RPCSettingsGet":        "settings.get",
		"RPCTrackStream":        "track.stream",
		"RPCUserLikesByInput":   "user.likes.by.input",
		"RPCFrontendRestore":    "frontend.restore",
		"RPCMixedSelections":    "mixed.selections",
		"RPCUserFollowings":     "user.followings",
		"RPCUserLikes":          "user.likes",
		"RPCPlaylistsMine":      "playlists.mine",
		"RPCUserPlaylists":      "user.playlists",
		"RPCTrackLike":          "track.like",
		"RPCTrackUnlike":        "track.unlike",
		"RPCUserProfile":        "user.profile",
		"RPCUserTracks":         "user.tracks",
		"RPCUserFollowers":      "user.followers",
		"RPCTrackDetails":       "track.details",
		"RPCSearchTracks":       "search.tracks",
		"RPCTrackRelated":       "track.related",
		"RPCPlaylistTracks":     "playlist.tracks",
		"RPCTracksMine":         "tracks.mine",
		"RPCResolvePlaylist":    "resolve.playlist",
		"RPCCacheClear":         "cache.clear",
		"RPCSettingsUpdate":     "settings.update",
		"RPCSettingsClear":      "settings.clear",
		"RPCHistoryList":        "history.list",
		"RPCHistoryRecord":      "history.record",
		"RPCHistoryClear":       "history.clear",
		"RPCFrontendBackup":     "frontend.backup",
		"RPCAuthStatus":         "auth.status",
		"RPCAuthLogin":          "auth.login",
		"RPCAuthRefresh":        "auth.refresh",
		"RPCAuthLogout":         "auth.logout",
		"RPCTrackLyrics":        "track.lyrics",
	}
	for goName, want := range cases {
		if got := rpcNameFromGo(goName); got != want {
			t.Errorf("rpcNameFromGo(%q) = %q, want %q", goName, got, want)
		}
	}
}
