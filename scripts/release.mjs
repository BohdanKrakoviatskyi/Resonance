#!/usr/bin/env node
// Usage: npm run release -- [patch|minor|major|x.y.z]
// Bumps the version everywhere, commits, tags vX.Y.Z and pushes -> GitHub Actions builds all OSes.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const arg = process.argv[2] ?? 'patch';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
const next = /^\d+\.\d+\.\d+$/.test(arg)
  ? arg
  : { major: `${maj + 1}.0.0`, minor: `${maj}.${min + 1}.0`, patch: `${maj}.${min}.${pat + 1}` }[arg];
if (!next) {
  console.error('Usage: npm run release -- [patch|minor|major|x.y.z]');
  process.exit(1);
}
const tag = `v${next}`;

if (out('git status --porcelain --untracked-files=no')) {
  console.error('Working tree has uncommitted changes. Commit or stash them first.');
  process.exit(1);
}
if (out(`git tag -l ${tag}`)) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));
edit('package.json', (s) => s.replace(/"version": "[^"]+"/, `"version": "${next}"`));
edit('src-tauri/tauri.conf.json', (s) => s.replace(/"version": "[^"]+"/, `"version": "${next}"`));
edit('src-tauri/Cargo.toml', (s) => s.replace(/^version = "[^"]+"/m, `version = "${next}"`));
edit('api/main.go', (s) => s.replace(/appVersion = "[^"]+"/, `appVersion = "${next}"`));
try {
  run('cargo update -p app --offline --manifest-path src-tauri/Cargo.toml');
} catch {
  /* Cargo.lock is refreshed by the build anyway */
}

run('git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock api/main.go');
run(`git commit -m "release: ${tag}"`);
run(`git tag ${tag}`);
run('git push');
run(`git push origin ${tag}`);
console.log(`\nPushed ${tag}. Watch the build in GitHub -> Actions.`);
