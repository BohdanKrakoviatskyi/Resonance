package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writePartialAudio(t *testing.T, data []byte) (string, *ytAudioActive) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "video.m4a")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	active := newYTAudioActive()
	active.setMeta(int64(len(data)) + 1000) // final file is still growing
	active.setContentType(path, "audio/mp4")
	active.addSize(int64(len(data)))
	return path, active
}

func TestGrowingFileServesRangeFromPartialDownload(t *testing.T) {
	data := bytes.Repeat([]byte("abcdefghij"), 100) // 1000 bytes downloaded...
	path, active := writePartialAudio(t, data)      // ...out of a 2000-byte file

	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	growing := &ytGrowingFile{file: file, active: active, ctx: context.Background()}

	request := httptest.NewRequest(http.MethodGet, "/yt-audio/x", nil)
	request.Header.Set("Range", "bytes=100-199")
	recorder := httptest.NewRecorder()
	recorder.Header().Set("Content-Type", "audio/mp4")
	http.ServeContent(recorder, request, "", time.Time{}, growing)

	if recorder.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", recorder.Code)
	}
	if got, want := recorder.Header().Get("Content-Range"), "bytes 100-199/2000"; got != want {
		t.Fatalf("Content-Range = %q, want %q", got, want)
	}
	if got := recorder.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges = %q, want bytes", got)
	}
	if !bytes.Equal(recorder.Body.Bytes(), data[100:200]) {
		t.Fatal("range body does not match the requested bytes")
	}
}

func TestGrowingFileSeeksAgainstFinalSize(t *testing.T) {
	data := bytes.Repeat([]byte("x"), 100)
	path, active := writePartialAudio(t, data)
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	growing := &ytGrowingFile{file: file, active: active, ctx: context.Background()}
	position, err := growing.Seek(0, io.SeekEnd)
	if err != nil {
		t.Fatal(err)
	}
	if position != 1100 {
		t.Fatalf("SeekEnd = %d, want the reported total 1100", position)
	}
}

func TestGrowingFileReadWaitsForDataStillDownloading(t *testing.T) {
	data := bytes.Repeat([]byte("a"), 100)
	path, active := writePartialAudio(t, data)
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	growing := &ytGrowingFile{file: file, active: active, ctx: context.Background(), pos: 100}
	type result struct {
		data []byte
		err  error
	}
	results := make(chan result, 1)
	go func() {
		buffer := make([]byte, 100)
		read, err := growing.Read(buffer)
		results <- result{data: buffer[:read], err: err}
	}()

	select {
	case got := <-results:
		t.Fatalf("Read returned %d bytes before more data was written", len(got.data))
	case <-time.After(100 * time.Millisecond):
	}

	appendFile, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := appendFile.Write(bytes.Repeat([]byte("b"), 100)); err != nil {
		t.Fatal(err)
	}
	if err := appendFile.Close(); err != nil {
		t.Fatal(err)
	}
	active.addSize(100)

	select {
	case got := <-results:
		if got.err != nil {
			t.Fatalf("Read error: %v", got.err)
		}
		if !bytes.Equal(got.data, bytes.Repeat([]byte("b"), 100)) {
			t.Fatal("Read returned the wrong bytes")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Read did not resume after data was appended")
	}
}
