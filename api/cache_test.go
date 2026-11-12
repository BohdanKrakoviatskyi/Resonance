package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// Evicting an audio file must also drop its .done marker and .meta sidecars,
// otherwise they are left behind forever.
func TestEnforceCacheLimitRemovesFileWithSidecars(t *testing.T) {
	dir := t.TempDir()
	manager := &ytAudioManager{cacheDir: dir, maxBytes: 1000}
	id := "cswfR85D7jM"
	audio := filepath.Join(dir, id+".m4a")
	if err := os.WriteFile(audio, bytes.Repeat([]byte("a"), 2000), 0o600); err != nil {
		t.Fatal(err)
	}
	meta := filepath.Join(dir, id+".deadbeef.meta")
	for _, path := range []string{audio + ".done", meta} {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	manager.enforceCacheLimit(0)

	for _, path := range []string{audio, audio + ".done", meta} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s survived eviction", filepath.Base(path))
		}
	}
}

func TestEnforceCacheLimitKeepsFilesUnderTheLimit(t *testing.T) {
	dir := t.TempDir()
	manager := &ytAudioManager{cacheDir: dir, maxBytes: 1000}
	id := "cswfR85D7jM"
	audio := filepath.Join(dir, id+".m4a")
	if err := os.WriteFile(audio, bytes.Repeat([]byte("a"), 100), 0o600); err != nil {
		t.Fatal(err)
	}
	meta := filepath.Join(dir, id+".deadbeef.meta")
	for _, path := range []string{audio + ".done", meta} {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	manager.enforceCacheLimit(0)

	for _, path := range []string{audio, audio + ".done", meta} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s was removed while under the limit", filepath.Base(path))
		}
	}
}
