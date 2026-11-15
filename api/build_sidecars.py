#!/usr/bin/env python3
"""Build Go sidecar binary for a requested Tauri target."""

import argparse
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "api"
BINARIES = ROOT / "src-tauri" / "binaries"
TARGETS = {
    "x86_64-unknown-linux-gnu": ("linux", "amd64"),
    "aarch64-unknown-linux-gnu": ("linux", "arm64"),
    "x86_64-apple-darwin": ("darwin", "amd64"),
    "aarch64-apple-darwin": ("darwin", "arm64"),
    "x86_64-pc-windows-msvc": ("windows", "amd64"),
    "aarch64-pc-windows-msvc": ("windows", "arm64"),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", choices=TARGETS)
    args = parser.parse_args()
    goos, goarch = TARGETS[args.target]
    BINARIES.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if goos == "windows" else ""
    local_api = BINARIES / f"local-api-{args.target}{suffix}"
    env = os.environ.copy()
    env.update({"GOOS": goos, "GOARCH": goarch, "CGO_ENABLED": "0"})
    subprocess.run(
        ["go", "build", "-trimpath", "-o", str(local_api), "."],
        cwd=API,
        env=env,
        check=True,
    )


if __name__ == "__main__":
    main()
