import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error('Install the Docker CLI to start the emulator.');
    throw result.error;
  }
  if (result.status !== 0) throw new Error(result.stderr.trim() || `docker ${args[0]} failed`);
  return result.stdout.trim();
}

export function inspectContainer(name) {
  try {
    return JSON.parse(docker('container', 'inspect', name))[0];
  } catch (error) {
    if (/No such (container|object):/i.test(error.message)) return null;
    throw error;
  }
}

function runProgress(command, args, options) {
  const result = spawnSync(command, args, { stdio: ['ignore', 2, 2], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed. See the output above.`);
}

export function ensureCustomImage(image) {
  try {
    docker('image', 'inspect', '--format', '{{.Id}}', image);
  } catch (error) {
    if (!/No such (image|object):/i.test(error.message)) throw error;
    runProgress('docker', ['pull', image]);
  }
}

// Match the Dockerfile, CLI installer and device profiles from one revision.
const revision = 'da5b53b9cbdc229f240e167de0feb061d5ef5f04';
const repository = 'https://github.com/wookiehangover/serve-droid.git';
export const apiLevels = new Map(Object.entries({
  '9.0': '28', '10.0': '29', '11.0': '30', '12.0': '32', '13.0': '33',
  '14.0': '34', '15.0': '35', '16.0': '36', '17.0': '37.0',
}));

// The local build tag first, then the published image with the same tag.
// SERVE_DROID_IMAGE_NAME swaps in a different local image name (and skips the published one), for testing.
export function imageTags(android) {
  const suffix = android === '17.0' ? '-tools22' : '';
  const name = process.env.SERVE_DROID_IMAGE_NAME;
  if (name) return [`${name}:emulator_${android}-webui${suffix}`];
  const tag = `docker-android:emulator_${android}-webui${suffix}`;
  return [tag, `wookiehangover/${tag}`];
}

// Every emulator image carries the revision of the sources it was built from.
export const revisionLabel = 'serve-droid.revision';
const dockerAndroidVersion = 'v3.9.0-p1';
// Keep in step with imageInputs in scripts/release.mjs.
const imageInputs = ['docker/emulator', 'mixins', 'cli', 'packages/serve-droid/web-ui'];
const checkoutRoot = fileURLToPath(new URL('../../../', import.meta.url));

function isCheckout() {
  return basename(fileURLToPath(new URL('../../', import.meta.url))) === 'packages' &&
    existsSync(join(checkoutRoot, 'docker/emulator/Dockerfile')) &&
    existsSync(join(checkoutRoot, 'mixins/scripts/install-cli.sh'));
}

function inputFiles() {
  const listed = spawnSync('git', ['ls-files', '-coz', '--exclude-standard', '--', ...imageInputs],
    { cwd: checkoutRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!listed.error && listed.status === 0) return listed.stdout.split('\0').filter(Boolean);
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(checkoutRoot, path));
    }
  };
  for (const input of imageInputs) if (existsSync(join(checkoutRoot, input))) walk(join(checkoutRoot, input));
  return files;
}

let currentRevision;
// The pinned revision for an installed package; a hash of the image sources for a checkout.
export function imageRevision() {
  if (currentRevision) return currentRevision;
  if (!isCheckout()) return (currentRevision = revision);
  const hash = createHash('sha256').update(`${dockerAndroidVersion}\0`);
  for (const file of inputFiles().sort()) {
    const path = join(checkoutRoot, file);
    if (!existsSync(path)) continue;
    hash.update(`${file}\0`).update(readFileSync(path)).update('\0');
  }
  return (currentRevision = `inputs-${hash.digest('hex').slice(0, 16)}`);
}

function inspectImage(image) {
  try {
    return JSON.parse(docker('image', 'inspect', image))[0];
  } catch (error) {
    if (/No such (image|object):/i.test(error.message)) return null;
    throw error;
  }
}

export function imageId(image) {
  return inspectImage(image)?.Id;
}

export function emulatorImage(android) {
  const tags = imageTags(android);
  const [tag] = tags;
  const wanted = imageRevision();
  let stale = false;
  for (const image of tags) {
    const info = inspectImage(image);
    if (info?.Config?.Labels?.[revisionLabel] === wanted) return image;
    stale ||= Boolean(info);
  }

  let source = checkoutRoot;
  let temp;
  try {
    if (!isCheckout()) {
      temp = mkdtempSync(join(tmpdir(), 'serve-droid-'));
      source = temp;
      console.error('Fetching the source for the emulator image…');
      runProgress('git', ['init', '-q', source]);
      runProgress('git', ['fetch', '--depth=1', repository, revision], { cwd: source });
      runProgress('git', ['checkout', '-q', '--detach', revision], { cwd: source });
    }
    console.error(stale ? 'The emulator image is out of date. Rebuilding…'
      : `Building Android ${android}. The first build can take several minutes.`);
    runProgress('docker', [
      'build', '-t', tag, '-f', 'docker/emulator/Dockerfile',
      '--label', `${revisionLabel}=${wanted}`,
      '--build-arg', `DOCKER_ANDROID_VERSION=${dockerAndroidVersion}`,
      '--build-arg', `EMULATOR_ANDROID_VERSION=${android}`,
      '--build-arg', `EMULATOR_API_LEVEL=${apiLevels.get(android)}`,
      '--secret', 'id=extension,src=mixins/scripts/install-cli.sh', '.',
    ], { cwd: source, env: { ...process.env, DOCKER_BUILDKIT: '1' } });
    return tag;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
