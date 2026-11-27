#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const usage = `Usage: npm run release -- [patch|minor|major|VERSION] [--dry-run]
       node scripts/release.mjs --notes VERSION

Bump the serve-droid version, add a CHANGELOG.md section, point the emulator
image at the released source, then commit and tag serve-droid-vVERSION.
Without a bump type, the commits decide: feat or breaking → minor
(breaking → major after 1.0), anything else → patch.

  --dry-run      Print the release without changing files
  --notes VER    Print the CHANGELOG.md section for VER (used by CI)`;

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pkgPath = 'packages/serve-droid';
// Sources the emulator image is built from (see docker/emulator/Dockerfile).
const imageInputs = ['docker/emulator', 'mixins', 'cli', `${pkgPath}/web-ui`];
const repoUrl = 'https://github.com/wookiehangover/serve-droid';
const hiddenTypes = new Set(['build', 'chore', 'ci', 'docs', 'refactor', 'release', 'style', 'test']);
const sections = [
  ['breaking', 'Breaking changes'], ['feat', 'Features'], ['fix', 'Fixes'],
  ['perf', 'Performance'], ['other', 'Other changes'],
];
const files = {
  package: join(root, pkgPath, 'package.json'),
  changelog: join(root, pkgPath, 'CHANGELOG.md'),
  docker: join(root, pkgPath, 'lib/docker.js'),
};

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

const gitOk = (...args) => spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0;
const tagFor = version => `serve-droid-v${version}`;
const parseVersion = version => /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null;

function isNewer(next, current) {
  const [a, b] = [parseVersion(next), parseVersion(current)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function baseRef(version) {
  const tag = tagFor(version);
  if (gitOk('rev-parse', '-q', '--verify', `refs/tags/${tag}`)) return tag;
  // Releases before tags existed: the last commit that changed the version.
  return git('log', '-1', '--format=%H', '-G"version":', '--', `${pkgPath}/package.json`) || fail('No earlier release found.');
}

function changes(base) {
  const log = git('log', '--no-merges', '--format=%H%x1f%an%x1f%s%x1f%b%x1e', `${base}..HEAD`, '--', pkgPath, ...imageInputs);
  return log.split('\x1e').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [hash, author, subject, body] = entry.split('\x1f');
    if (author.endsWith('[bot]')) return null;
    const match = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/);
    const type = match?.[1].toLowerCase();
    const breaking = Boolean(match?.[2]) || /^BREAKING[ -]CHANGE:/m.test(body);
    if (!breaking && hiddenTypes.has(type)) return null;
    const kind = breaking ? 'breaking' : ['feat', 'fix', 'perf'].includes(type) ? type : 'other';
    let text = match ? match[3] : subject;
    text = text[0].toUpperCase() + text.slice(1);
    const pr = text.match(/\s*\(#(\d+)\)$/);
    text = pr
      ? `${text.slice(0, pr.index)} ([#${pr[1]}](${repoUrl}/pull/${pr[1]}))`
      : `${text} ([${hash.slice(0, 7)}](${repoUrl}/commit/${hash}))`;
    return { kind, text };
  }).filter(Boolean);
}

function nextVersion(current, request, entries) {
  if (parseVersion(request ?? '')) {
    if (!isNewer(request, current)) fail(`${request} must be newer than ${current}.`);
    return request;
  }
  const [major, minor, patch] = parseVersion(current);
  const kinds = new Set(entries.map(entry => entry.kind));
  const level = request ?? (kinds.has('breaking') ? (major ? 'major' : 'minor') : kinds.has('feat') ? 'minor' : 'patch');
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  fail(`Unknown bump "${level}".\n\n${usage}`);
}

function sectionBody(entries) {
  if (!entries.length) return 'No user-facing changes.\n';
  return sections.map(([kind, title]) => {
    const items = entries.filter(entry => entry.kind === kind).map(entry => `- ${entry.text}`);
    return items.length ? `### ${title}\n\n${items.join('\n')}\n` : '';
  }).filter(Boolean).join('\n');
}

function notes(version) {
  const text = existsSync(files.changelog) ? readFileSync(files.changelog, 'utf8') : '';
  const heading = text.match(new RegExp(`^## ${version.replaceAll('.', '\\.')} \\(.*\\)$`, 'm'));
  if (!heading) fail(`CHANGELOG.md has no section for ${version}.`);
  const rest = text.slice(heading.index + heading[0].length);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim() + '\n';
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, notes: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return console.log(usage);
  if (values.notes) return process.stdout.write(notes(values.notes));
  if (positionals.length > 1) fail(usage);
  const dryRun = values['dry-run'];

  if (!dryRun) {
    if (git('status', '--porcelain')) fail('Commit or stash your changes first.');
    if (git('branch', '--show-current') !== 'master') fail('Release from master.');
    git('fetch', '--quiet', '--tags', 'origin', 'master');
    if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/master')) {
      fail('master must match origin/master. Pull or push first.');
    }
  }

  const pkg = readFileSync(files.package, 'utf8');
  const current = JSON.parse(pkg).version;
  if (!parseVersion(current)) fail(`Unsupported version ${current} in package.json.`);
  const base = baseRef(current);
  const entries = changes(base);
  if (!entries.length && !positionals[0]) fail(`No user-facing changes since ${current}. Pass a bump type to release anyway.`);
  const version = nextVersion(current, positionals[0], entries);
  const tag = tagFor(version);
  if (gitOk('rev-parse', '-q', '--verify', `refs/tags/${tag}`)) fail(`Tag ${tag} already exists.`);

  // Linux users build the image from this revision, so it must contain the released image sources.
  const docker = readFileSync(files.docker, 'utf8');
  const pinned = docker.match(/const revision = '([0-9a-f]{40})';/)?.[1] ?? fail('No image revision in lib/docker.js.');
  const head = git('rev-parse', 'HEAD');
  const stale = !gitOk('merge-base', '--is-ancestor', pinned, 'HEAD') ||
    !gitOk('diff', '--quiet', pinned, 'HEAD', '--', ...imageInputs);
  const date = new Date().toISOString().slice(0, 10);
  const changelog = existsSync(files.changelog) ? readFileSync(files.changelog, 'utf8') : '# Changelog\n';
  // A hand-written "## Unreleased" section becomes the release notes instead of the commit list.
  const unreleased = changelog.match(/^## Unreleased[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  const body = unreleased ? `${unreleased[1].trim()}\n` : sectionBody(entries);
  const section = `## ${version} (${date})\n\n${body}`;

  console.log(`serve-droid ${current} → ${version} (changes since ${base.startsWith('serve-droid-v') ? base : base.slice(0, 7)})`);
  console.log(stale ? `Image source: ${pinned.slice(0, 7)} → ${head.slice(0, 7)}` : `Image source: ${pinned.slice(0, 7)} (unchanged)`);
  console.log(`\n${section}`);
  if (dryRun) return;

  writeFileSync(files.package, pkg.replace(/"version": "[^"]+"/, `"version": "${version}"`));
  const rest = unreleased ? changelog.replace(unreleased[0], '') : changelog;
  const at = rest.search(/^## /m);
  writeFileSync(files.changelog, at < 0
    ? `${rest.trimEnd()}\n\n${section}`
    : `${rest.slice(0, at)}${section}\n${rest.slice(at)}`);
  if (stale) writeFileSync(files.docker, docker.replace(pinned, head));

  git('add', '--', files.package, files.changelog, files.docker);
  git('commit', '--quiet', '-m', `release: serve-droid v${version}`);
  git('tag', '-a', tag, '--cleanup=verbatim', '-m', `serve-droid v${version}\n\n${body}`);
  console.log(`Committed and tagged ${tag}. To publish:

  git push --atomic origin master ${tag}
  npm publish ./${pkgPath}

Pushing the tag creates the GitHub release from CHANGELOG.md.`);
}

main();
