#!/usr/bin/env python3
"""JSON-lines adapter around ytmusicapi for the YouTube Music provider.

The worker is deliberately small: it owns the unofficial YouTube Music web
protocol, credential storage, and response normalization. Credentials travel
only over stdin/stdout or the owner-only credential file under the app data
directory; they are never passed in argv or written to logs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any

try:
    from ytmusicapi import YTMusic
except ImportError:  # Keep this module importable before the pinned deps are installed.
    YTMusic = None  # type: ignore[assignment]


class WorkerError(Exception):
    """An error that is safe to show to the user after redaction."""


ORIGIN = "https://music.youtube.com"
CREDENTIALS_FILE = "ytmusic-auth.json"
ARTWORK_FIELDS = ("thumbnails", "thumbnail")


# ---------------------------------------------------------------------------
# Header handling
# ---------------------------------------------------------------------------


def derive_authorization(cookie: str) -> str:
    """Build SAPISIDHASH from the cookie.

    ytmusicapi regenerates Authorization from ``__Secure-3PAPISID`` on every
    request, so the login window only has to provide the native session cookie.
    """
    try:
        from ytmusicapi.helpers import get_authorization, sapisid_from_cookie

        sapisid = sapisid_from_cookie(cookie)
        if sapisid:
            return get_authorization(f"{sapisid} {ORIGIN}")
    except Exception:
        pass
    # A shaped placeholder still selects ytmusicapi's browser auth mode; the
    # real header is recomputed from the cookie before any request is sent.
    return "SAPISIDHASH 0_0"


def validate_headers(headers: Any) -> dict[str, str]:
    """Normalize the six browser headers ytmusicapi needs.

    Cookie and Authorization identify the signed-in user. The remaining values
    are protocol constants captured from the account-menu request.
    """
    if not isinstance(headers, dict):
        raise WorkerError("YouTube Music sign-in data is invalid. Please reconnect.")

    normalized = {
        str(key).strip().lower(): str(value).strip()
        for key, value in headers.items()
        if key is not None and value is not None
    }
    cookie = normalized.get("cookie", "")
    if not re.search(r"(?:^|;\s*)__Secure-3PAPISID=[^;]+", cookie, re.IGNORECASE):
        raise WorkerError("YouTube Music session cookie is missing. Please reconnect.")

    # Always compute a fresh SAPISIDHASH from the current cookie so stored
    # credentials do not fail after the 10-minute SAPISIDHASH timestamp window.
    fresh_authorization = derive_authorization(cookie)
    authorization = normalized.get("authorization", "")
    if fresh_authorization != "SAPISIDHASH 0_0":
        authorization = fresh_authorization
    elif not re.match(r"^SAPISIDHASH\s+\S+$", authorization, re.IGNORECASE):
        authorization = fresh_authorization

    auth_user = normalized.get("x-goog-authuser", "0") or "0"
    if not re.fullmatch(r"\d+", auth_user):
        auth_user = "0"

    return {
        "Accept": normalized.get("accept") or "*/*",
        "Authorization": authorization,
        "Content-Type": normalized.get("content-type") or "application/json",
        "X-Goog-AuthUser": auth_user,
        "x-origin": ORIGIN,
        "Cookie": cookie,
    }


def redact_error(text: Any) -> str:
    """Strip cookie/token material from an error before it leaves the worker."""
    message = str(text)
    message = re.sub(
        r"(?i)(cookie|authorization)\s*[:=]\s*([^\r\n]+)",
        r"\1=[redacted]",
        message,
    )
    message = re.sub(r"(?i)(SAPISIDHASH\s+)[^\s\"']+", r"\1[redacted]", message)
    message = re.sub(
        r"(?i)(?:__Secure-[^=;:\s]+|SID|SSID|HSID|APISID|SAPISID)=[^;:\s]+",
        "[redacted]",
        message,
    )
    return message[:500]


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _first_thumbnail(value: Any) -> str | None:
    if not isinstance(value, list):
        return None
    # YouTube thumbnail lists are ordered from smallest to largest.
    for thumbnail in reversed(value):
        if isinstance(thumbnail, dict) and thumbnail.get("url"):
            return str(thumbnail["url"])
    return None


def _artwork(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    for field in ARTWORK_FIELDS:
        artwork = _first_thumbnail(raw.get(field))
        if artwork:
            return artwork
    return None


def _duration_seconds(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if not text:
        return None
    if ":" in text:
        try:
            parts = [int(part) for part in text.split(":")]
        except ValueError:
            return None
        seconds = 0
        for part in parts:
            seconds = seconds * 60 + part
        return seconds
    try:
        return int(float(text))
    except ValueError:
        return None


def _artists(track: dict[str, Any]) -> list[str]:
    artists = track.get("artists") or []
    names: list[str] = []
    if isinstance(artists, list):
        for artist in artists:
            if isinstance(artist, dict):
                name = _text(artist.get("name"))
            else:
                name = _text(artist)
            if name and name not in names:
                names.append(name)
    if not names:
        fallback = _text(track.get("artist"))
        if fallback:
            names.append(fallback)
    return names


def normalize_track(track: Any) -> dict[str, Any] | None:
    if not isinstance(track, dict):
        return None
    video_id = _text(track.get("videoId") or track.get("id"))
    if not video_id:
        return None
    artists = _artists(track)
    return {
        "videoId": video_id,
        "title": _text(track.get("title")) or "Unknown title",
        "artist": ", ".join(artists),
        "artists": artists,
        "artworkUrl": _artwork(track),
        "durationSeconds": _duration_seconds(track.get("duration_seconds", track.get("duration"))),
        "available": track.get("isAvailable", True) is not False,
    }


def _track_count(raw: dict[str, Any], tracks: list[dict[str, Any]] | None = None) -> int:
    candidate = raw.get("trackCount", raw.get("count"))
    if candidate is None and tracks is not None:
        return len(tracks)
    if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
        return max(0, int(candidate))
    digits = re.sub(r"\D", "", str(candidate or ""))
    return int(digits) if digits else (len(tracks) if tracks is not None else 0)


def normalize_playlist_summary(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise WorkerError("YouTube Music returned an invalid playlist.")
    playlist_id = _text(raw.get("playlistId") or raw.get("id"))
    if not playlist_id:
        raise WorkerError("YouTube Music returned a playlist without an id.")
    return {
        "playlistId": playlist_id,
        "title": _text(raw.get("title")) or "Untitled playlist",
        "artworkUrl": _artwork(raw),
        "trackCount": _track_count(raw),
    }


def normalize_playlist(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise WorkerError("YouTube Music returned an invalid playlist.")
    tracks = [
        normalized
        for item in (raw.get("tracks") or [])
        if (normalized := normalize_track(item))
    ]
    summary = normalize_playlist_summary(raw)
    summary["trackCount"] = _track_count(raw, tracks)
    summary["tracks"] = tracks
    return summary


def normalize_profile(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    return {
        "name": _text(raw.get("accountName") or raw.get("name")),
        "handle": _text(raw.get("channelHandle") or raw.get("handle")),
        "picture": _text(raw.get("accountPhotoUrl") or raw.get("accountPhoto") or raw.get("picture")),
    }


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def default_data_dir() -> Path:
    configured = os.environ.get("BSC_DATA_DIR")
    if configured:
        return Path(configured)
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "Resonance"


def _credentials_path(data_dir: Path) -> Path:
    return data_dir / CREDENTIALS_FILE


def _read_credentials(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def save_credentials(path: Path, headers: dict[str, str], profile: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        path.parent.chmod(0o700)
    payload = {"headers": validate_headers(headers), "profile": profile}
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as file:
            if os.name != "nt":
                os.chmod(temporary, 0o600)
            json.dump(payload, file, ensure_ascii=True, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(path)
        if os.name != "nt":
            path.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# ytmusicapi operations
# ---------------------------------------------------------------------------


def _ytmusic(headers: dict[str, str]):
    if YTMusic is None:
        raise WorkerError("YouTube Music support is unavailable. Reinstall the application.")
    return YTMusic(auth=validate_headers(headers))


def _status(profile: dict[str, str] | None) -> dict[str, Any]:
    result: dict[str, Any] = {"authorized": True}
    if profile:
        result["profile"] = normalize_profile(profile)
    return result


def _load_headers(credential_path: Path) -> tuple[dict[str, str], dict[str, str]]:
    credentials = _read_credentials(credential_path)
    if not credentials:
        raise WorkerError("Connect YouTube Music before loading your library.")
    try:
        headers = validate_headers(credentials.get("headers", {}))
    except WorkerError:
        credential_path.unlink(missing_ok=True)
        raise
    profile = credentials.get("profile") if isinstance(credentials.get("profile"), dict) else {}
    return headers, profile


EXCLUDED_YTMUSIC_PLAYLIST_TITLES = {
    "episodes for later",
    "sounds from shorts",
    "liked music",
}


def _collect_two_row_items(node: Any, out: list[dict[str, Any]]) -> None:
    if isinstance(node, dict):
        renderer = node.get("musicTwoRowItemRenderer")
        if isinstance(renderer, dict):
            out.append(renderer)
        for value in node.values():
            _collect_two_row_items(value, out)
    elif isinstance(node, list):
        for item in node:
            _collect_two_row_items(item, out)


def _fetch_library_playlists_via_browse(headers: dict[str, str]) -> list[dict[str, Any]]:
    data = _request_youtubei_browse("FEmusic_liked_playlists", headers)
    two_row: list[dict[str, Any]] = []
    _collect_two_row_items(data, two_row)
    playlists: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for r in two_row:
        nav_ep = r.get("navigationEndpoint") or {}
        browse_id = _text((nav_ep.get("browseEndpoint") or {}).get("browseId"))
        if not browse_id:
            continue
        playlist_id = browse_id[2:] if browse_id.startswith("VL") else browse_id
        if playlist_id in ("LM", "SE") or playlist_id.startswith("FEmusic"):
            continue
        if playlist_id in seen_ids:
            continue
        title = _runs_text((r.get("title") or {}).get("runs")) or "Untitled playlist"
        if title.strip().casefold() in EXCLUDED_YTMUSIC_PLAYLIST_TITLES:
            continue
        subtitle = _runs_text((r.get("subtitle") or {}).get("runs"))
        count_match = re.search(r"(\d+)\s*(?:song|track|трек|пес)", subtitle, re.IGNORECASE)
        track_count = int(count_match.group(1)) if count_match else 0
        art = _first_thumbnail(
            (((r.get("thumbnailRenderer") or {}).get("musicThumbnailRenderer") or {}).get("thumbnail") or {}).get("thumbnails")
        )
        seen_ids.add(playlist_id)
        playlists.append(
            {
                "playlistId": playlist_id,
                "title": title,
                "artworkUrl": art,
                "trackCount": track_count,
            }
        )
    return playlists


def sync_library(headers: dict[str, str], saved_profile: dict[str, str]) -> dict[str, Any]:
    client = _ytmusic(headers)
    session_alive = False
    try:
        raw_profile = client.get_account_info() or {}
        if raw_profile.get("accountName") or raw_profile.get("channelHandle"):
            session_alive = True
    except Exception:
        raw_profile = saved_profile
    profile = normalize_profile(raw_profile)
    if not profile.get("name"):
        profile = normalize_profile(saved_profile)

    try:
        playlists_raw = client.get_library_playlists(limit=None) or []
    except Exception:
        playlists_raw = []
    playlists = []
    for item in playlists_raw:
        if not isinstance(item, dict) or not (item.get("playlistId") or item.get("id")):
            continue
        summary = normalize_playlist_summary(item)
        if summary.get("title", "").strip().casefold() in EXCLUDED_YTMUSIC_PLAYLIST_TITLES:
            continue
        playlists.append(summary)

    if not playlists:
        try:
            playlists = _fetch_library_playlists_via_browse(headers)
        except Exception:
            playlists = []

    try:
        liked_raw = client.get_liked_songs(limit=None) or {}
    except Exception:
        liked_raw = {}
    liked_items = liked_raw.get("tracks", []) if isinstance(liked_raw, dict) else liked_raw
    liked = [
        normalized
        for item in liked_items
        if (normalized := normalize_track(item))
    ]
    if not liked:
        for browse_target in ("FEmusic_liked_videos", "VLLM"):
            try:
                fb_liked = _fetch_playlist_via_browse(browse_target, headers)
                liked = fb_liked.get("tracks") or []
                if liked:
                    break
            except Exception:
                pass

    if not session_alive and not playlists and not liked:
        raise WorkerError(
            "Сессия YouTube Music истекла. Нажмите «Переподключить» в настройках YouTube Music, чтобы обновить вход."
        )

    return {
        "profile": profile,
        "playlists": playlists,
        "likedSongs": liked,
    }


def fetch_playlist_artwork(headers: dict[str, str] | None, playlist_id: str) -> str | None:
    """Lazily resolve a playlist cover via ``get_playlist(limit=1)`` or browse fallback.

    ``get_library_playlists`` does not include thumbnail data; only a
    per-playlist fetch exposes the artwork URL.
    """
    clean_id = playlist_id[2:] if playlist_id.startswith("VL") else playlist_id
    if headers:
        try:
            client = _ytmusic(headers)
            playlist = client.get_playlist(clean_id, limit=1)
            if isinstance(playlist, dict):
                art = _artwork(playlist)
                if art:
                    return art
                artwork = playlist.get("artworkUrl")
                if artwork:
                    return str(artwork)
        except Exception:
            pass
    try:
        fallback = _fetch_playlist_via_browse(playlist_id, headers)
        art = fallback.get("artworkUrl")
        return str(art) if art else None
    except Exception:
        return None


def _ensure_browse_id(playlist_id: str) -> str:
    trimmed = playlist_id.strip()
    if trimmed.startswith(("VL", "FEmusic")):
        return trimmed
    if trimmed.startswith(("PL", "RD", "OLAK5uy_")):
        return f"VL{trimmed}"
    return f"VL{trimmed}"


def _collect_responsive_items(node: Any, out: list[dict[str, Any]]) -> None:
    if isinstance(node, dict):
        renderer = node.get("musicResponsiveListItemRenderer")
        if isinstance(renderer, dict):
            out.append(renderer)
        for value in node.values():
            _collect_responsive_items(value, out)
    elif isinstance(node, list):
        for item in node:
            _collect_responsive_items(item, out)


def _runs_text(runs: Any) -> str:
    if not isinstance(runs, list):
        return ""
    return "".join(
        str(r.get("text", "")) for r in runs if isinstance(r, dict)
    ).strip()


def _parse_responsive_renderer(renderer: dict[str, Any]) -> dict[str, Any] | None:
    video_id = _text(
        (renderer.get("playlistItemData") or {}).get("videoId")
        if isinstance(renderer.get("playlistItemData"), dict)
        else None
    )
    if not video_id:
        overlay = (
            ((renderer.get("overlay") or {}).get("musicItemThumbnailOverlayRenderer") or {})
            .get("content", {})
            .get("musicPlayButtonRenderer", {})
            .get("playNavigationEndpoint", {})
            .get("watchEndpoint", {})
        )
        if isinstance(overlay, dict):
            video_id = _text(overlay.get("videoId"))
    if not video_id:
        return None

    flex_cols = renderer.get("flexColumns")
    title = ""
    artists: list[str] = []
    duration_sec: int | None = None

    if isinstance(flex_cols, list) and len(flex_cols) > 0:
        col0 = (
            flex_cols[0].get("musicResponsiveListItemFlexColumnRenderer", {})
            if isinstance(flex_cols[0], dict)
            else {}
        )
        title = _runs_text((col0.get("text") or {}).get("runs"))

    if isinstance(flex_cols, list) and len(flex_cols) > 1:
        col1 = (
            flex_cols[1].get("musicResponsiveListItemFlexColumnRenderer", {})
            if isinstance(flex_cols[1], dict)
            else {}
        )
        runs = (col1.get("text") or {}).get("runs")
        if isinstance(runs, list):
            for r in runs:
                if not isinstance(r, dict):
                    continue
                txt = _text(r.get("text"))
                if not txt or txt in {"•", "&", ",", "Song", "Video"}:
                    continue
                nav_browse = (
                    (r.get("navigationEndpoint") or {})
                    .get("browseEndpoint", {})
                    .get("browseId", "")
                )
                if ":" in txt and _duration_seconds(txt) is not None:
                    duration_sec = _duration_seconds(txt)
                elif nav_browse.startswith("UC") or not artists:
                    if txt not in artists:
                        artists.append(txt)

    if duration_sec is None:
        fixed_cols = renderer.get("fixedColumns")
        if isinstance(fixed_cols, list):
            for col in fixed_cols:
                if not isinstance(col, dict):
                    continue
                fcol = col.get("musicResponsiveListItemFixedColumnRenderer") or {}
                txt = _runs_text((fcol.get("text") or {}).get("runs"))
                parsed_dur = _duration_seconds(txt)
                if parsed_dur is not None:
                    duration_sec = parsed_dur
                    break

    thumbs = (
        ((renderer.get("thumbnail") or {}).get("musicThumbnailRenderer") or {})
        .get("thumbnail", {})
        .get("thumbnails")
    )
    art = _first_thumbnail(thumbs)

    return {
        "videoId": video_id,
        "title": title or "Unknown title",
        "artist": ", ".join(artists),
        "artists": artists,
        "artworkUrl": art,
        "durationSeconds": duration_sec,
        "available": True,
    }


def _request_youtubei_browse(
    browse_id: str, auth_headers: dict[str, str] | None
) -> dict[str, Any]:
    payload = json.dumps(
        {
            "browseId": browse_id,
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": "1.20250101.01.00",
                    "hl": "en",
                    "gl": "US",
                }
            },
        }
    ).encode("utf-8")

    req_headers: dict[str, str] = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Origin": ORIGIN,
        "Referer": f"{ORIGIN}/",
    }
    if auth_headers:
        for k in ("Authorization", "Cookie", "X-Goog-AuthUser", "X-Goog-Visitor-Id"):
            for hk, hv in auth_headers.items():
                if hk.lower() == k.lower() and hv:
                    req_headers[k] = hv

    req = urllib.request.Request(
        f"{ORIGIN}/youtubei/v1/browse?prettyPrint=false",
        data=payload,
        headers=req_headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fetch_playlist_via_browse(
    playlist_id: str, headers: dict[str, str] | None
) -> dict[str, Any]:
    browse_id = _ensure_browse_id(playlist_id)
    clean_id = playlist_id[2:] if playlist_id.startswith("VL") else playlist_id

    data: dict[str, Any] | None = None
    if headers:
        try:
            candidate = _request_youtubei_browse(browse_id, headers)
            items_test: list[dict[str, Any]] = []
            _collect_responsive_items(candidate, items_test)
            if items_test:
                data = candidate
        except Exception:
            data = None

    if data is None:
        data = _request_youtubei_browse(browse_id, None)

    renderers: list[dict[str, Any]] = []
    _collect_responsive_items(data, renderers)

    tracks: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for r in renderers:
        parsed = _parse_responsive_renderer(r)
        if parsed and parsed["videoId"] not in seen_ids:
            seen_ids.add(parsed["videoId"])
            tracks.append(parsed)

    title = "Playlist"
    art = _artwork(data)
    if not art and tracks:
        art = tracks[0].get("artworkUrl")

    return {
        "playlistId": clean_id,
        "title": title,
        "artworkUrl": art,
        "trackCount": len(tracks),
        "tracks": tracks,
    }


def _fetch_playlist_via_ytdlp(playlist_id: str) -> dict[str, Any]:
    clean_id = playlist_id[2:] if playlist_id.startswith("VL") else playlist_id
    ytdlp_bin = shutil.which("yt-dlp") or "yt-dlp"
    url = f"{ORIGIN}/playlist?list={clean_id}"
    proc = subprocess.run(
        [ytdlp_bin, "--flat-playlist", "-J", "--no-warnings", url],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if proc.returncode != 0 and not proc.stdout.strip():
        sys.stderr.write(f"[YtPlaylist] yt-dlp failed for {clean_id}: {proc.stderr}\n")
        raise WorkerError(f"yt-dlp playlist load failed: {proc.stderr.strip()}")

    try:
        data = json.loads(proc.stdout.strip())
    except Exception as exc:
        sys.stderr.write(
            f"[YtPlaylist] yt-dlp JSON parse failed for {clean_id}: {exc} | stdout={proc.stdout[:500]}\n"
        )
        raise WorkerError(f"Failed to parse playlist JSON: {exc}") from exc

    title = _text(data.get("title")) or "Playlist"
    art = _artwork(data)
    tracks: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for entry in data.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        vid = _text(entry.get("id"))
        if not vid or len(vid) != 11 or vid in seen_ids:
            continue
        raw_title = _text(entry.get("title"))
        if not raw_title or raw_title.lower() in ("[private video]", "[deleted video]"):
            continue
        seen_ids.add(vid)
        uploader = (
            _text(entry.get("uploader"))
            or _text(entry.get("channel"))
            or _text(entry.get("artist"))
        )
        if uploader.endswith(" - Topic"):
            uploader = uploader[: -len(" - Topic")].strip()
        artist = uploader or "YouTube Music"
        dur_val = entry.get("duration")
        duration_seconds = float(dur_val) if isinstance(dur_val, (int, float)) else None
        thumb = _artwork(entry) or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        tracks.append(
            {
                "videoId": vid,
                "title": raw_title,
                "artist": artist,
                "artists": [artist],
                "artworkUrl": thumb,
                "durationSeconds": duration_seconds,
                "available": True,
            }
        )

    if not tracks:
        sys.stderr.write(
            f"[YtPlaylist] 0 tracks parsed for {clean_id}. Raw stdout: {proc.stdout[:1000]} | stderr: {proc.stderr}\n"
        )
        raise WorkerError(f"Playlist '{title}' returned 0 playable tracks.")

    if not art and tracks:
        art = tracks[0].get("artworkUrl")

    return {
        "playlistId": clean_id,
        "title": title,
        "artworkUrl": art,
        "trackCount": len(tracks),
        "tracks": tracks,
    }


def fetch_playlist_tracks_resilient(
    headers: dict[str, str] | None, playlist_id: str
) -> dict[str, Any]:
    clean_id = playlist_id[2:] if playlist_id.startswith("VL") else playlist_id
    if headers:
        try:
            client = _ytmusic(headers)
            playlist = client.get_playlist(clean_id, limit=None)
            if isinstance(playlist, dict):
                raw_tracks = playlist.get("tracks") or []
                normalized = [
                    t for item in raw_tracks if (t := normalize_track(item))
                ]
                if normalized:
                    summary = normalize_playlist_summary(
                        {"playlistId": clean_id, **playlist}
                    )
                    if not summary.get("artworkUrl"):
                        summary["artworkUrl"] = normalized[0].get("artworkUrl")
                    summary["trackCount"] = summary.get("trackCount") or len(
                        normalized
                    )
                    return {
                        **summary,
                        "tracks": normalized,
                    }
        except Exception:
            pass
    try:
        return _fetch_playlist_via_ytdlp(playlist_id)
    except Exception:
        return _fetch_playlist_via_browse(playlist_id, headers)


def handle(request: dict[str, Any], data_dir: Path) -> Any:
    method = request.get("method")
    params = request.get("params") or {}
    credential_path = _credentials_path(data_dir)

    if method == "auth.status":
        credentials = _read_credentials(credential_path)
        if not credentials:
            return {"authorized": False}
        try:
            validate_headers(credentials.get("headers", {}))
        except WorkerError:
            credential_path.unlink(missing_ok=True)
            return {"authorized": False}
        profile = credentials.get("profile") if isinstance(credentials.get("profile"), dict) else {}
        return _status(profile)

    if method == "auth.save":
        headers = validate_headers(params.get("headers"))
        try:
            profile_raw = _ytmusic(headers).get_account_info() or {}
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError(
                "YouTube Music rejected the captured session. Please sign in again."
            ) from error
        profile = normalize_profile(profile_raw)
        if not profile.get("name"):
            raise WorkerError("YouTube Music did not return an account. Please sign in again.")
        save_credentials(credential_path, headers, profile)
        return _status(profile)

    if method == "auth.logout":
        credential_path.unlink(missing_ok=True)
        return {"authorized": False}

    if method == "library.sync":
        headers, profile = _load_headers(credential_path)
        return sync_library(headers, profile)

    if method == "playlist.tracks":
        playlist_id = _text(params.get("playlistId"))
        if not playlist_id:
            raise WorkerError("Playlist ID is required.")
        try:
            headers, _profile = _load_headers(credential_path)
        except WorkerError:
            headers = None
        return fetch_playlist_tracks_resilient(headers, playlist_id)

    if method == "playlist.artwork":
        playlist_id = _text(params.get("playlistId"))
        if not playlist_id:
            raise WorkerError("Playlist ID is required.")
        try:
            headers, _profile = _load_headers(credential_path)
        except WorkerError:
            headers = {}
        return fetch_playlist_artwork(headers, playlist_id)

    raise WorkerError("Unknown YouTube Music operation.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=default_data_dir())
    args = parser.parse_args()
    for line in sys.stdin:
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            response = {"id": request.get("id"), "result": handle(request, args.data_dir)}
        except Exception as error:
            if isinstance(error, WorkerError):
                message = redact_error(error)
            else:
                message = "YouTube Music request failed. Please reconnect and try again."
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": message,
            }
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
