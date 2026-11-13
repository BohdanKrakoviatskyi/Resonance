package main

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestParseYtDlpSearchResultsMapsEntriesToPlayableTracks(t *testing.T) {
	results, err := parseYtDlpSearchResults([]byte(`{
		"_type":"playlist",
		"entries":[
			{"id":"cswfR85D7jM","title":"Love Me Not","channel":"Ravyn Lenae","duration":219,"thumbnail":"https://i.ytimg.com/vi/cswfR85D7jM/hqdefault.jpg"},
			{"id":"NB7WuqWzDhw","title":"Lyrics","uploader":"R&BHype","duration":214}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("got %d results, want 2", len(results))
	}
	if results[0].NativeID != "cswfR85D7jM" || results[0].Artist != "Ravyn Lenae" || results[0].DurationMs != 219000 {
		t.Fatalf("unexpected first result: %#v", results[0])
	}
	if results[1].Artist != "R&BHype" || results[1].ArtworkURL == "" {
		t.Fatalf("missing uploader or fallback thumbnail: %#v", results[1])
	}
}

func TestYtDlpAudioURLRequiresHTTPSGoogleVideoHost(t *testing.T) {
	if !validYtDlpAudioURL("https://rr2---sn.googlevideo.com/videoplayback?sig=secret") {
		t.Fatal("expected googlevideo URL to be allowed")
	}
	for _, value := range []string{
		"http://rr2---sn.googlevideo.com/videoplayback",
		"https://example.com/audio",
		"https://googlevideo.com.evil.example/audio",
	} {
		if validYtDlpAudioURL(value) {
			t.Errorf("unexpectedly accepted URL %q", value)
		}
	}
}

func TestParseYtDlpSearchResultsSkipsLiveAndZeroDuration(t *testing.T) {
	results, err := parseYtDlpSearchResults([]byte(`{"entries":[
		{"id":"cswfR85D7jM","title":"Live","duration":0},
		{"id":"NB7WuqWzDhw","title":"Song","duration":214}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].NativeID != "NB7WuqWzDhw" {
		t.Fatalf("got %#v, want only the track with a duration", results)
	}
}

func TestYtStreamExpiryHonorsSignedExpire(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	signed := "https://rr1.googlevideo.com/videoplayback?expire=1000600&sig=x"
	if got, want := ytStreamExpiry(signed, now), time.Unix(1_000_300, 0); !got.Equal(want) {
		t.Fatalf("expiry = %v, want %v (expire minus margin)", got, want)
	}
	if got, want := ytStreamExpiry("https://rr1.googlevideo.com/videoplayback?sig=x", now), now.Add(ytStreamCacheTTL); !got.Equal(want) {
		t.Fatalf("unsigned expiry = %v, want %v", got, want)
	}
	if got := ytStreamExpiry("https://rr1.googlevideo.com/videoplayback?expire=1000000", now); now.Before(got) {
		t.Fatalf("already-expired URL should not be cacheable, got expiry %v", got)
	}
}

func TestYtDlpErrorDetailKeepsLastErrorAndValidUTF8(t *testing.T) {
	stderr := "WARNING: noise\nERROR: Sign in to confirm\n" + strings.Repeat("é", 600)
	msg := ytDlpErrorDetail(stderr)
	if !strings.HasPrefix(msg, "ERROR: Sign in") {
		t.Fatalf("expected the ERROR line, got %q", msg[:20])
	}
	if !utf8.ValidString(msg) || len([]rune(msg)) > 500 {
		t.Fatalf("message not valid UTF-8 or too long: %d runes", len([]rune(msg)))
	}
}

func TestYtDlpVideoIDValidation(t *testing.T) {
	if !validYouTubeVideoID("cswfR85D7jM") {
		t.Fatal("expected valid video id")
	}
	for _, value := range []string{"", "bad", "https://example.com", "cswfR85D7jM?x=1"} {
		if validYouTubeVideoID(value) {
			t.Errorf("unexpectedly accepted video id %q", value)
		}
	}
}
