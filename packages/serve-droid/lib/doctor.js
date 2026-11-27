import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { freemem, homedir } from 'node:os';
import { delimiter, dirname, join, parse } from 'node:path';
import { imageTags } from './docker.js';
import { kvmHelp } from './kvm.js';
import { pythonCandidates, pythonPaths } from './native.js';
import { listSessions } from './sessions.js';

// Read-only: every check only looks. Each external command gets a short timeout and no network.
const GB = 1024 ** 3;
const defaultAndroid = '16.0';
const rootless = 'https://docs.docker.com/engine/security/rootless/';

function probe(command, args, timeout = 5000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, shell: /\.(bat|cmd)$/i.test(command) });
  const missing = result.error?.code === 'ENOENT';
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return { ok: !result.error && result.status === 0, missing, timedOut,
    out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function which(name, platform) {
  const exts = platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, name + ext.toLowerCase());
      if (executable(file, platform)) return file;
    }
  }
}

function executable(file, platform) {
  try {
    accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
const gb = bytes => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

function memAvailable() {
  try {
    return Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m)[1]) * 1024;
  } catch {
    return freemem();
  }
}

function freeDisk(path) {
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      const fs = statfsSync(dir);
      return { dir, free: fs.bavail * fs.bsize };
    } catch {
      if (dir === parse(dir).root) return;
    }
  }
}

function commonChecks(add) {
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22 ? 'ok' : 'fail', `Node.js ${process.versions.node}`,
    'Install Node.js 22 or newer: https://nodejs.org/en/download');
  const git = probe('git', ['--version']);
  add('git', git.ok ? 'ok' : 'fail', git.ok ? git.out.replace(/^git version /, 'Git ') : 'Git not found (used to name each project\'s emulator)',
    'Install Git: https://git-scm.com/downloads');
}

function sessionCheck(add) {
  let sessions;
  try {
    sessions = listSessions();
  } catch (error) {
    return add('sessions', 'warn', `Could not list running emulators: ${error.message.split('\n')[0]}`, 'serve-droid ls');
  }
  if (!sessions.length) return add('sessions', 'ok', 'No emulators running');
  add('sessions', 'ok', `${sessions.length} running: ${sessions.map(s => `${s.name} ${s.url ?? '(no browser UI)'}`).join(', ')}`);
}

function tailscaleCheck(add, platform) {
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  let ts = probe('tailscale', ['version']);
  if (ts.missing && platform === 'darwin' && existsSync(app)) ts = probe(app, ['version']);
  if (ts.ok) return add('tailscale', 'ok', `Tailscale ${ts.out.split('\n')[0]} (for remote access)`);
  add('tailscale', 'warn', 'Tailscale not found (optional, for opening emulators from other devices)',
    'https://tailscale.com/download');
}

function dockerChecks(add, { kvmPath }) {
  if (process.arch !== 'x64') {
    add('arch', 'fail', `This host is ${process.arch}; the emulator image needs x86_64 Linux`,
      'Use an x86_64 Linux host, or run serve-droid on macOS');
  }

  const version = probe('docker', ['version', '--format', '{{.Server.Version}}']);
  let daemon = false;
  if (version.missing) {
    add('docker', 'fail', 'Docker CLI not found', 'Install Docker Engine: https://docs.docker.com/engine/install/');
  } else {
    const client = probe('docker', ['version', '--format', '{{.Client.Version}}']).out;
    add('docker', 'ok', `Docker CLI ${client || 'found'}`);
    if (version.ok) {
      daemon = true;
      add('docker-daemon', 'ok', `Docker daemon ${version.out} is reachable`);
    } else if (/permission denied/i.test(version.err)) {
      add('docker-daemon', 'ok', 'Docker daemon is running');
      const listed = /^docker:[^:]*:\d+:(.*)$/m.exec(readGroups())?.[1].split(',').includes(process.env.USER ?? '');
      add('docker-permission', 'fail', listed
        ? 'Permission denied: you are in the docker group, but this login session started before you were added'
        : 'Permission denied: your user cannot use the Docker socket',
      listed
        ? 'Log out and back in (or run: newgrp docker)'
        : `sudo usermod -aG docker $USER, then log out and back in. Or use rootless Docker: ${rootless}`);
    } else if (version.timedOut) {
      add('docker-daemon', 'fail', 'Docker did not answer within 5 seconds', 'sudo systemctl restart docker');
    } else {
      add('docker-daemon', 'fail', 'Docker daemon is not running', 'sudo systemctl enable --now docker');
    }
  }

  let info = {};
  if (daemon) {
    const raw = probe('docker', ['info', '--format', '{{json .}}']);
    try { info = JSON.parse(raw.out); } catch { /* older engines: keep defaults */ }
    const how = String(info.SecurityOptions ?? '').includes('rootless') ? 'rootless Docker'
      : process.getuid?.() === 0 ? 'root'
        : process.env.DOCKER_HOST ? `DOCKER_HOST ${process.env.DOCKER_HOST}`
          : inDockerGroup() ? 'docker group' : 'socket access';
    add('docker-permission', 'ok', `Your user can use Docker (${how})`);
  }

  let image;
  if (daemon) {
    image = imageTags(defaultAndroid).find(tag => probe('docker', ['image', 'ls', '-q', tag]).out);
    add('image', image ? 'ok' : 'warn',
      image ? `Android ${defaultAndroid.replace('.0', '')} image ${image}`
        : `No Android ${defaultAndroid.replace('.0', '')} image yet; the first start builds it and takes several minutes`,
      'serve-droid start (builds the image once)');
  }

  if (!version.missing) {
    const buildx = probe('docker', ['buildx', 'version']);
    const needed = daemon && !image;
    add('buildx', buildx.ok ? 'ok' : needed ? 'fail' : 'warn',
      buildx.ok ? `BuildKit (buildx ${buildx.out.split(' ')[1] ?? ''})`.replace(' )', ')')
        : `BuildKit (docker buildx) not found; ${needed ? 'needed to build the emulator image' : 'needed only to build an emulator image'}`,
      'Install the docker-buildx plugin: https://docs.docker.com/go/buildx/');
  }

  if (!existsSync(kvmPath)) {
    const reason = kvmHelp().split('\n')[1] ?? '';
    const run = /^(.*?)\s*Run: (.*)$/.exec(reason);
    add('kvm', 'fail', `${kvmPath} is missing${run ? `. ${run[1]}` : ''}`,
      run?.[2] ?? (reason || 'https://www.linux-kvm.org/page/FAQ'));
  } else {
    let access = true;
    try { accessSync(kvmPath, constants.R_OK | constants.W_OK); } catch { access = false; }
    add('kvm', access ? 'ok' : 'fail', access ? `${kvmPath} is available` : `${kvmPath} exists, but your user cannot open it`,
      'sudo usermod -aG kvm $USER, then log out and back in');
  }

  const root = info.DockerRootDir ?? '/var/lib/docker';
  const disk = freeDisk(root);
  if (disk) {
    const build = daemon && !image;
    const need = build ? 25 * GB : 5 * GB;
    add('disk', disk.free >= need ? 'ok' : 'warn',
      `${gb(disk.free)} free for Docker (${disk.dir})${build ? '; building the image needs about 25 GB' : ''}`,
      `Free space on ${disk.dir}, for example: docker system prune`);
  }

  const mem = memAvailable();
  add('memory', mem >= 4 * GB ? 'ok' : 'warn',
    `${gb(mem)} memory available; each emulator uses about 4 GB`,
    'Close other apps or stop an emulator: serve-droid stop --name NAME');
  return daemon;
}

function readGroups() {
  try { return readFileSync('/etc/group', 'utf8'); } catch { return ''; }
}

function inDockerGroup() {
  const gid = /^docker:[^:]*:(\d+):/m.exec(readGroups())?.[1];
  return gid !== undefined && (process.getgroups?.() ?? []).includes(Number(gid));
}

// Mirrors web-ui/android_sdk.py: sdk_root, missing_packages and sdk_manager.
function sdkFacts(platform) {
  const exe = platform === 'win32' ? '.exe' : '';
  const adb = root => join(root, 'platform-tools', `adb${exe}`);
  const emulator = root => join(root, 'emulator', `emulator${exe}`);
  const missing = root => [
    !executable(adb(root), platform) && 'platform-tools',
    (!executable(emulator(root), platform) || !existsSync(join(root, 'emulator/lib/emulator_controller.proto'))) && 'emulator',
  ].filter(Boolean);
  const configured = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  let root;
  if (configured) {
    root = configured.replace(/^~(?=$|[/\\])/, homedir());
  } else {
    const roots = [platform === 'darwin' ? join(homedir(), 'Library/Android/sdk')
      : join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'Android/Sdk')];
    for (const [binary, dir] of [['adb', 'platform-tools'], ['emulator', 'emulator']]) {
      const found = which(binary, platform);
      if (found && parse(dirname(found)).base === dir) roots.push(dirname(dirname(found)));
    }
    root = roots.reduce((best, r) => missing(r).length < missing(best).length ? r : best);
  }
  const script = platform === 'win32' ? '.bat' : '';
  let manager = join(root, 'cmdline-tools/latest/bin', `sdkmanager${script}`);
  if (!executable(manager, platform)) {
    const versions = existsSync(join(root, 'cmdline-tools')) ? readdirSync(join(root, 'cmdline-tools')).sort().reverse() : [];
    manager = versions.map(v => join(root, 'cmdline-tools', v, 'bin', `sdkmanager${script}`)).find(f => executable(f, platform))
      ?? which('sdkmanager', platform);
  }
  return { root, configured: Boolean(configured), missing: missing(root), adb: adb(root), emulator: emulator(root), manager };
}

function systemImages(root, abi) {
  const base = join(root, 'system-images');
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(api => api.startsWith('android-')).flatMap(api =>
    readdirSync(join(base, api)).filter(tag => existsSync(join(base, api, tag, abi, 'system.img')))
      .map(tag => `${api};${tag}`));
}

function nativeChecks(add, { platform }) {
  const studio = 'https://developer.android.com/studio';
  const sdk = sdkFacts(platform);
  const where = sdk.configured ? `${sdk.root} (from ${process.env.ANDROID_HOME ? 'ANDROID_HOME' : 'ANDROID_SDK_ROOT'})` : sdk.root;
  const found = existsSync(sdk.root);
  add('sdk', found ? 'ok' : 'fail', found ? `Android SDK at ${where}` : `No Android SDK at ${where}`,
    sdk.configured ? 'Point ANDROID_HOME at your Android SDK folder' : `Install Android Studio (${studio}) or set ANDROID_HOME to your SDK`);
  const fixPackage = pkg => platform === 'darwin'
    ? `serve-droid start installs it (needs a terminal), or add ${pkg} in Android Studio's SDK Manager`
    : `Add ${pkg} in Android Studio's SDK Manager (SDK Tools tab)`;
  add('adb', sdk.missing.includes('platform-tools') ? 'fail' : 'ok',
    sdk.missing.includes('platform-tools') ? 'adb not found (Android SDK Platform-Tools)' : `adb at ${sdk.adb}`,
    fixPackage('Android SDK Platform-Tools'));
  const emulatorOk = !sdk.missing.includes('emulator');
  add('emulator', emulatorOk ? 'ok' : 'fail',
    emulatorOk ? `Android Emulator at ${sdk.emulator}` : 'Android Emulator not found or incomplete', fixPackage('Android Emulator'));
  add('sdkmanager', sdk.manager ? 'ok' : 'warn',
    sdk.manager ? `sdkmanager at ${sdk.manager}` : 'sdkmanager not found; needed only to create the first virtual device',
    fixPackage('Android SDK Command-line Tools (latest)'));

  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  let avds = [];
  if (emulatorOk) {
    const list = probe(sdk.emulator, ['-list-avds']);
    avds = list.out.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('INFO'));
  }
  const images = found ? systemImages(sdk.root, abi) : [];
  const avd = avds.includes('serve-droid') ? 'serve-droid' : [...avds].sort()[0];
  if (avd) {
    add('avd', 'ok', `Virtual device ${avd}${avds.length > 1 ? ` (${avds.length} found)` : ''}`);
  } else if (images.length) {
    add('avd', 'warn', `No virtual device yet; the first start creates "serve-droid" from ${images.at(-1)}`,
      'serve-droid start');
  } else {
    const pkg = `system-images;android-36;google_apis;${abi}`;
    add('avd', 'warn', `No virtual device or ${abi} system image yet; the first start downloads one`,
      sdk.manager ? `"${sdk.manager}" "${pkg}"` : `serve-droid start, or install ${pkg} in Android Studio's SDK Manager`);
  }

  if (emulatorOk) {
    const accel = probe(sdk.emulator, ['-accel-check'], 15000);
    const detail = accel.out.split(/\r?\n/).map(l => l.trim())
      .filter(l => l && !['accel', 'accel:'].includes(l) && !/^\d+$/.test(l)).join(' ');
    add('acceleration', accel.ok ? 'ok' : 'fail',
      accel.ok ? `Hardware acceleration: ${detail || 'available'}`
        : `The emulator cannot use hardware acceleration${detail ? `: ${detail}` : accel.timedOut ? ' (check timed out)' : ''}`,
      platform === 'win32'
        ? 'Turn on Windows Hypervisor Platform: Settings > System > Optional features > More Windows features, then restart Windows'
        : 'https://developer.android.com/studio/run/emulator-acceleration');
  }

  const paths = pythonPaths();
  const uv = probe('uv', ['--version']).ok ? 'uv' : existsSync(paths.localUv) ? paths.localUv : null;
  const system = !uv && pythonCandidates.map(c => ({ c, r: probe(c[0], [...c.slice(1), '-c',
    'import sys; print(sys.version.split()[0]); sys.exit(not (3, 12) <= sys.version_info[:2] < (3, 15))']) }))
    .find(({ r }) => r.ok);
  const ready = existsSync(paths.python) &&
    probe(paths.python, ['-c', 'import aiohttp, grpc, PIL, jwt'], 10000).ok;
  add('python', uv || system || ready ? 'ok' : 'warn',
    uv ? `uv found (${uv === 'uv' ? 'on PATH' : uv}); it manages Python for the browser UI`
      : system ? `Python ${system.r.out} (${system.c.join(' ')})`
        : ready ? 'No uv or Python 3.12–3.14 on PATH; the existing browser UI environment is used'
          : 'Neither uv nor Python 3.12–3.14 found; serve-droid start offers to install uv',
    'Install uv: https://docs.astral.sh/uv/getting-started/installation/');
  add('venv', ready ? 'ok' : 'warn',
    ready ? `Browser UI environment ready (${paths.venv})`
      : `Browser UI environment not set up in this folder yet; the first start creates ${paths.venv}`,
    'serve-droid start');
}

export function runDoctor({ platform = process.platform, kvmPath = '/dev/kvm' } = {}) {
  const checks = [];
  const add = (id, status, detail, fix) => checks.push({ id, status, detail, ...(status !== 'ok' && fix ? { fix } : {}) });
  commonChecks(add);
  let sessions = true;
  if (platform === 'darwin' || platform === 'win32') nativeChecks(add, { platform });
  else if (platform === 'linux') sessions = dockerChecks(add, { kvmPath });
  else add('platform', 'fail', `${platform} is not supported`, 'Use macOS, Windows, or x86_64 Linux');
  if (sessions) sessionCheck(add);
  tailscaleCheck(add, platform);
  return { ok: !checks.some(c => c.status === 'fail'), platform, checks };
}

const marks = { ok: '✓', warn: '!', fail: '✗' };
const names = {
  node: 'Node.js', git: 'Git', arch: 'CPU', docker: 'Docker', 'docker-daemon': 'Docker daemon',
  'docker-permission': 'Docker access', image: 'Emulator image', buildx: 'BuildKit', kvm: 'KVM', disk: 'Disk',
  memory: 'Memory', sdk: 'Android SDK', adb: 'adb', emulator: 'Emulator', sdkmanager: 'sdkmanager', avd: 'Virtual device',
  acceleration: 'Acceleration', python: 'Python', venv: 'Browser UI env', sessions: 'Running', tailscale: 'Tailscale',
  platform: 'Platform',
};

export function formatDoctor(report) {
  const width = Math.max(...report.checks.map(c => (names[c.id] ?? c.id).length));
  return report.checks.flatMap(c => [
    `${marks[c.status]} ${(names[c.id] ?? c.id).padEnd(width)}  ${c.detail}`,
    ...(c.fix ? [`  ${' '.repeat(width)}  Fix: ${c.fix}`] : []),
  ]).join('\n');
}
