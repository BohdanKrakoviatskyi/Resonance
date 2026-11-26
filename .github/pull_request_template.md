## What changed

<!-- The behaviour after this patch, in a sentence or two. Not a file list. -->

## Why

<!-- The problem it fixes or the gap it fills. Link the issue: Fixes #12 -->

## How you tested it

<!-- The checks you ran, and what you clicked through by hand. Screenshots or a short recording for anything visual. -->

- [ ] `npx tsc --noEmit && npm test && npm run build` (desktop)
- [ ] `cargo check` and `cargo test` in `src-tauri/` (Rust core touched)
- [ ] `npm run typecheck && npm test && npm run build` in `mobile/` (mobile touched)

## Scope and risk

<!-- Anything a reviewer should look at hard: new dependency, manifest or permission change, migration, user-visible behaviour change. Mobile PRs must come from a feat/mobile* branch and leave desktop sources alone. -->

- [ ] One logical change, no unrelated reformatting
- [ ] No secrets, tokens or keychain material in the diff
- [ ] No hand-edited version fields
