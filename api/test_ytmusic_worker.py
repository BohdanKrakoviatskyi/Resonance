import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from api import ytmusic_worker as worker


HEADERS = {
    "Accept": "*/*",
    "Authorization": "SAPISIDHASH 1700000000_deadbeef",
    "Content-Type": "application/json",
    "X-Goog-AuthUser": "0",
    "x-origin": "https://music.youtube.com",
    "Cookie": "__Secure-3PAPISID=cookie-value; SID=session-value",
}


class FakeYTMusic:
    def __init__(self, auth):
        self.auth = auth

    def get_account_info(self):
        return {"accountName": "Test User", "channelHandle": "@test", "accountPhotoUrl": "https://img.test/user.jpg"}

    def get_library_playlists(self, limit=None):
        return [
            {"playlistId": "PL1", "title": "Mix", "count": "2", "thumbnails": [{"url": "https://img.test/mix.jpg"}]},
            {"title": "No id"},
        ]

    def get_playlist(self, playlist_id, limit=None):
        return {
            "id": playlist_id,
            "title": "Mix",
            "thumbnails": [{"url": "https://img.test/mix.jpg"}],
            "tracks": [
                {
                    "videoId": "video-1",
                    "title": "Song",
                    "artists": [{"name": "Artist"}],
                    "duration_seconds": 123,
                    "thumbnails": [
                        {"url": "https://img.test/small.jpg"},
                        {"url": "https://img.test/large.jpg"},
                    ],
                    "isAvailable": True,
                },
                {"title": "Unavailable", "videoId": None},
            ],
        }

    def get_liked_songs(self, limit=None):
        return {
            "tracks": [
                {"videoId": "liked-1", "title": "Liked", "artists": [{"name": "Artist"}], "duration_seconds": 99}
            ]
        }


class WorkerTests(unittest.TestCase):
    def test_headers_require_cookie_and_keep_or_derive_authorization(self):
        normalized = worker.validate_headers(HEADERS)
        self.assertEqual(normalized["X-Goog-AuthUser"], "0")
        self.assertEqual(normalized["x-origin"], "https://music.youtube.com")
        self.assertEqual(normalized["Cookie"], HEADERS["Cookie"])
        self.assertRegex(normalized["Authorization"], r"^SAPISIDHASH \S+$")

        # The login window now supplies the native cookie only; Authorization is
        # derived from __Secure-3PAPISID so capture never depends on page hooks.
        derived = worker.validate_headers(
            {key: value for key, value in HEADERS.items() if key != "Authorization"}
        )
        self.assertRegex(derived["Authorization"], r"^SAPISIDHASH \S+$")

        replaced = worker.validate_headers({**HEADERS, "Authorization": "Bearer token"})
        self.assertRegex(replaced["Authorization"], r"^SAPISIDHASH \S+$")

        with self.assertRaises(worker.WorkerError):
            worker.validate_headers({**HEADERS, "Cookie": "SID=x"})
        with self.assertRaises(worker.WorkerError):
            worker.validate_headers({"Authorization": HEADERS["Authorization"]})

    def test_normalizes_track_and_drops_missing_video_id(self):
        result = worker.normalize_playlist(FakeYTMusic(HEADERS).get_playlist("PL1"))
        self.assertEqual(result["playlistId"], "PL1")
        self.assertEqual(result["trackCount"], 1)
        self.assertEqual(result["artworkUrl"], "https://img.test/mix.jpg")
        self.assertEqual(result["tracks"][0]["videoId"], "video-1")
        self.assertEqual(result["tracks"][0]["artist"], "Artist")
        self.assertEqual(result["tracks"][0]["artworkUrl"], "https://img.test/large.jpg")
        self.assertEqual(result["tracks"][0]["durationSeconds"], 123)
        self.assertEqual(len(result["tracks"]), 1)

    def test_normalizes_duration_strings_and_missing_artists(self):
        track = worker.normalize_track({"videoId": "x", "title": "T", "duration": "1:02:03"})
        self.assertEqual(track["durationSeconds"], 3723)
        self.assertEqual(track["artist"], "")

    def test_credentials_are_saved_with_restrictive_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ytmusic.json"
            worker.save_credentials(path, HEADERS, {"name": "Test User"})
            saved = json.loads(path.read_text())
            self.assertEqual(saved["headers"], worker.validate_headers(HEADERS))
            self.assertEqual(saved["profile"], {"name": "Test User"})
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_error_text_redacts_secret_values(self):
        error = worker.redact_error(
            f"Cookie={HEADERS['Cookie']} Authorization={HEADERS['Authorization']}"
        )
        self.assertNotIn(HEADERS["Cookie"], error)
        self.assertNotIn(HEADERS["Authorization"], error)
        self.assertIn("[redacted]", error)

    @patch.object(worker, "YTMusic", FakeYTMusic)
    def test_auth_save_validates_and_persists(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            result = worker.handle(
                {"method": "auth.save", "params": {"headers": HEADERS}},
                data_dir,
            )
            self.assertTrue(result["authorized"])
            self.assertEqual(result["profile"]["name"], "Test User")
            self.assertTrue((data_dir / worker.CREDENTIALS_FILE).exists())

    @patch.object(worker, "YTMusic", FakeYTMusic)
    def test_sync_returns_normalized_library(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            worker.handle({"method": "auth.save", "params": {"headers": HEADERS}}, data_dir)
            result = worker.handle({"method": "library.sync", "params": {}}, data_dir)
            self.assertEqual(result["profile"]["name"], "Test User")
            self.assertEqual(result["playlists"][0]["playlistId"], "PL1")
            self.assertEqual(result["playlists"][0]["trackCount"], 2)
            self.assertEqual(result["likedSongs"][0]["videoId"], "liked-1")
            self.assertNotIn("savedSongs", result)

    @patch.object(worker, "YTMusic", FakeYTMusic)
    def test_playlist_artwork_resolves_thumbnail(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            worker.handle({"method": "auth.save", "params": {"headers": HEADERS}}, data_dir)
            art = worker.handle({"method": "playlist.artwork", "params": {"playlistId": "PL1"}}, data_dir)
            self.assertEqual(art, "https://img.test/mix.jpg")

    @patch.object(worker, "YTMusic", FakeYTMusic)
    def test_playlist_tracks_returns_normalized_tracks(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            worker.handle({"method": "auth.save", "params": {"headers": HEADERS}}, data_dir)
            result = worker.handle({"method": "playlist.tracks", "params": {"playlistId": "PL1"}}, data_dir)
            self.assertEqual(result["playlistId"], "PL1")
            self.assertEqual(result["tracks"][0]["videoId"], "video-1")

    def test_status_and_logout(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            self.assertEqual(worker.handle({"method": "auth.status", "params": {}}, data_dir), {"authorized": False})
            worker.save_credentials(
                data_dir / worker.CREDENTIALS_FILE,
                HEADERS,
                {"name": "Test User", "handle": "@test", "picture": ""},
            )
            status = worker.handle({"method": "auth.status", "params": {}}, data_dir)
            self.assertTrue(status["authorized"])
            self.assertEqual(status["profile"]["name"], "Test User")
            self.assertEqual(worker.handle({"method": "auth.logout", "params": {}}, data_dir), {"authorized": False})
            self.assertFalse((data_dir / worker.CREDENTIALS_FILE).exists())

    def test_corrupt_credentials_are_discarded(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            (data_dir / worker.CREDENTIALS_FILE).write_text("{not json")
            self.assertEqual(worker.handle({"method": "auth.status", "params": {}}, data_dir), {"authorized": False})

    def test_unknown_method_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(worker.WorkerError):
                worker.handle({"method": "nope", "params": {}}, Path(directory))


if __name__ == "__main__":
    unittest.main()
