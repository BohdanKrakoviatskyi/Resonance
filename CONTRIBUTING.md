# Contributing to Resonance

Thanks for wanting to help. This file covers how to get a change from your machine into `main`.

Resonance is licensed under the GPLv3, so everything here is aiming at a patch that can ship under that license.

## Before you write code

- Open an issue first for anything bigger than a bug fix or a small polish. Say what is broken or missing and how you would fix it. It saves you from building something that lands on a different path than the one the maintainers want.
- One logical change per pull request. If you touched a bug and also refactored three files on the way, split it: the fix in one PR, the cleanup in another.
- Bugs and small features never need permission. Just open the PR with a clear description.

## Set up

You need Node 22 or newer, Rust 1.90 or newer, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run dev        # renderer only, in a browser
npm run tauri dev  # the real app, Rust core included
npm test           # unit tests in src/lib
```

The app has a desktop side (`src/`, `src-tauri/`) and a mobile side (`mobile/`). They are built by different workflows and shipped separately.

## Branch naming

Branch off `main` and name the branch after the work:

- `feat/<short-name>` for a feature
- `fix/<short-name>` for a bug
- `chore/<short-name>` for tooling, CI, dependencies, docs

Mobile changes have one extra rule: put them on a `feat/mobile*` branch, because that prefix is what triggers the APK build workflow. Do not mix desktop and mobile changes in one PR. The mobile workflow asserts that a mobile push leaves desktop sources alone, so a mixed PR fails it.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/), matching what is already in `git log`:

```
fix(playback): keep the volume on the media element in WebKit
feat(mobile): bring the Android and iOS app onto main
perf: cut idle, playback and mobile energy use across the app
```

- Types in use: `feat`, `fix`, `perf`, `ci`, `chore`, `docs`, `refactor`, `test`. Add a scope in parentheses when the change lives in one area: `player`, `playback`, `appearance`, `mobile`, `android`, `soundcloud`, `ytmusic`, `embed`.
- Lowercase summary, no trailing period, describe the effect rather than the files touched.
- `release:` commits and `v*` / `mobile-v*` tags belong to the maintainers. Do not bump versions by hand: releases are cut with `npm run release`.

Pull requests are squash merged, so **your PR title becomes the commit message on `main`**. Format it exactly like a commit subject.

## Checks to run before you open the PR

There is no CI on pull requests, so nothing will catch a broken branch for you. Run the checks yourself and say in the PR what you ran:

| Touched | Run |
| --- | --- |
| Desktop TypeScript, React | `npx tsc --noEmit && npm test && npm run build` |
| Rust core (`src-tauri/`) | `cargo check` and `cargo test` in `src-tauri/`, plus `npm run tauri dev` to confirm the app still runs |
| Mobile (`mobile/`) | `cd mobile && npm run typecheck && npm test && npm run build` |

If a check fails because of something that was already broken on `main`, say so in the PR rather than fixing it in the same branch.

## The pull request

Use the template. In short:

- **Title**: conventional format, the same as a commit subject.
- **What changed**: the behaviour after your patch, not a file list.
- **Why**: the problem it solves, with the issue number when there is one (`Fixes #12`).
- **How you tested it**: the checks you ran, plus what you clicked through by hand. For anything visual, attach a screenshot or a short recording of the change in the app.
- **Scope**: call out anything a reviewer should look at hard: a new dependency, a manifest or permission change, a migration, a behaviour change users will notice.

Keep a PR reviewable. If a change is genuinely large, say where the reviewer should start.

## Code expectations

- Match the code around you: same structure, naming and formatting. No drive-by reformatting of files you did not need to touch.
- Keep network, streaming and session work in the Rust core (`src-tauri/`). The renderer calls into it over commands and events. Do not move that logic into React.
- Do not add a dependency without a reason in the PR description. Prefer the standard library or what is already installed.
- Never commit tokens, keys, `.env` files, signing material or anything that came out of a user's keychain. Never log them either.
- Do not edit version fields by hand (`package.json`, `Cargo.toml`, `tauri.conf.json`). The release script owns them.

## Licensing

Resonance is free software under the [GNU General Public License v3.0 or later](LICENSE). By opening a pull request you agree to license your contribution under those same terms. There is no CLA and no copyright assignment: you keep the copyright on what you write.

Do not paste code in from a project under an incompatible license. If you adapted something, say where it came from and what its license is.

## Review

A maintainer reviews every PR. Expect comments about scope and about the parts that touch playback, signing or user data, since those break in ways tests do not catch.

- Push follow-up commits to the same branch instead of opening a new PR. They get squashed on merge anyway.
- Rebase or merge `main` into your branch when it conflicts.
- If a PR goes quiet for a couple of weeks, ping it with a comment. It is not being ignored on purpose.
