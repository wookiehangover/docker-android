import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
const revision = 'ff975cb2786dd4a7e411f09c0dc8ac010f1c8473';
const repository = 'https://github.com/wookiehangover/docker-android.git';
export const apiLevels = new Map(Object.entries({
  '9.0': '28', '10.0': '29', '11.0': '30', '12.0': '32', '13.0': '33',
  '14.0': '34', '15.0': '35', '16.0': '36', '17.0': '37.0',
}));

export function emulatorImage(android) {
  const tag = `docker-android:emulator_${android}-webui`;
  for (const image of [tag, `wookiehangover/${tag}`]) {
    if (docker('image', 'ls', '-q', image)) return image;
  }

  let source = fileURLToPath(new URL('../../../', import.meta.url));
  let temp;
  try {
    const parent = fileURLToPath(new URL('../../', import.meta.url));
    if (basename(parent) !== 'packages' || !existsSync(join(source, 'docker/emulator/Dockerfile')) ||
        !existsSync(join(source, 'mixins/scripts/install-cli.sh'))) {
      temp = mkdtempSync(join(tmpdir(), 'serve-droid-'));
      source = temp;
      console.error('Fetching the source for the emulator image…');
      runProgress('git', ['init', '-q', source]);
      runProgress('git', ['fetch', '--depth=1', repository, revision], { cwd: source });
      runProgress('git', ['checkout', '-q', '--detach', revision], { cwd: source });
    }
    console.error(`Building Android ${android}. The first build can take several minutes.`);
    runProgress('docker', [
      'build', '-t', tag, '-f', 'docker/emulator/Dockerfile',
      '--build-arg', 'DOCKER_ANDROID_VERSION=v3.9.0-p1',
      '--build-arg', `EMULATOR_ANDROID_VERSION=${android}`,
      '--build-arg', `EMULATOR_API_LEVEL=${apiLevels.get(android)}`,
      '--secret', 'id=extension,src=mixins/scripts/install-cli.sh', '.',
    ], { cwd: source, env: { ...process.env, DOCKER_BUILDKIT: '1' } });
    return tag;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
