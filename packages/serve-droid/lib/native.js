import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const ui = fileURLToPath(new URL('../web-ui/', import.meta.url));
const packageDir = fileURLToPath(new URL('../', import.meta.url));
const uvVersion = '0.11.28';

export const nativeState = windows
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'serve-droid')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library/Caches/serve-droid')
    : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'serve-droid');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ['inherit', 2, 2], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed. See the output above.`);
}

const succeeds = (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status === 0;

function supportedPython(python) {
  return succeeds(python[0], [...python.slice(1), '-c',
    'import sys; sys.exit(not (3, 12) <= sys.version_info[:2] < (3, 15))']);
}

async function choosePythonSetup() {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error('uv was not found. Choose Python setup:\n' +
      '  1) Install uv for this project (manages Python automatically)\n' +
      '  2) Use installed Python 3.12–3.14 with venv and pip');
    const choice = (await prompt.question('Choice [1/2]: ')).trim();
    if (choice === '1' || choice === 'uv') return 'uv';
    if (choice === '2' || choice === 'system') return 'system';
  } finally {
    prompt.close();
  }
  throw new Error('Setup cancelled.');
}

function installUv(bin) {
  console.error(`Setting up uv in ${bin}…`);
  const env = { ...process.env, UV_UNMANAGED_INSTALL: bin };
  if (windows) {
    return run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `irm https://astral.sh/uv/${uvVersion}/install.ps1 | iex`], { env });
  }
  const temp = mkdtempSync(join(tmpdir(), 'serve-droid-uv-'));
  try {
    run('curl', ['-fsSL', `https://astral.sh/uv/${uvVersion}/install.sh`, '-o', join(temp, 'install.sh')]);
    run('sh', [join(temp, 'install.sh')], { env });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Create or update the browser UI's Python environment and return its interpreter.
async function pythonEnvironment() {
  const state = join(process.cwd(), '.serve-droid');
  const venv = realpathSync(process.cwd()) === realpathSync(packageDir) ? join(process.cwd(), '.venv') : join(state, '.venv');
  const python = windows ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
  const marker = join(venv, '.serve-droid-system');
  const localUv = join(state, 'bin', windows ? 'uv.exe' : 'uv');
  let uv = succeeds('uv', ['--version']) ? 'uv' : existsSync(localUv) ? localUv : null;

  let mode = process.env.SERVE_DROID_PYTHON_SETUP;
  if (!mode) {
    if (existsSync(marker)) mode = 'system';
    else if (uv) mode = 'uv';
    else if (process.stdin.isTTY) mode = await choosePythonSetup();
    else mode = 'system';
  }
  if (mode === 'system') {
    const candidates = [[python], ...(windows
      ? [['py', '-3.14'], ['py', '-3.13'], ['py', '-3.12'], ['python']]
      : [['python3'], ['python3.14'], ['python3.13'], ['python3.12']])];
    const system = candidates.find(supportedPython);
    if (!system) {
      throw new Error('System setup needs Python 3.12–3.14. To install uv instead, rerun with SERVE_DROID_PYTHON_SETUP=uv.');
    }
    if (system[0] !== python) run(system[0], [...system.slice(1), '-m', 'venv', venv]);
    if (!succeeds(python, ['-m', 'pip', '--version'])) run(python, ['-m', 'ensurepip']);
    run(python, ['-m', 'pip', '--disable-pip-version-check', 'install', '--quiet', '-r', join(ui, 'native-requirements.txt')]);
    writeFileSync(marker, '');
  } else if (mode === 'uv') {
    if (!uv) {
      installUv(join(state, 'bin'));
      uv = localUv;
    }
    run(uv, ['sync', '--project', ui, '--frozen', '--python', '3.12', '--no-install-project'],
      { env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv } });
    rmSync(marker, { force: true });
  } else {
    throw new Error('SERVE_DROID_PYTHON_SETUP must be uv or system.');
  }
  return python;
}

// Run attach.py in the browser UI's environment. Returns its last stdout line when capturing.
export async function nativeLaunch(args, capture) {
  const python = await pythonEnvironment();
  const result = spawnSync(python, [join(ui, 'attach.py'), ...args], {
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8',
    env: { ...process.env, SERVE_DROID_HOME: nativeState },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  return capture ? result.stdout.trim().split('\n').at(-1) : undefined;
}

export function commandLine(pid) {
  if (!Number.isInteger(pid)) return '';
  const result = windows
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8' })
    : spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return result.stdout ?? '';
}

function readFrom(file, start) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const buffer = Buffer.alloc(Math.max(0, size - start));
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

// Like tail: print whole files, or the last 100 lines and then follow appends and truncation.
export async function showFiles(files, follow) {
  const offsets = new Map(files.map(file => [file, 0]));
  let current;
  const print = (file, text) => {
    if (!text.length) return;
    if (files.length > 1 && current !== file) process.stdout.write(`${current ? '\n' : ''}==> ${file} <==\n`);
    current = file;
    process.stdout.write(text);
  };
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file);
    offsets.set(file, text.length);
    print(file, follow ? text.toString('utf8').split(/(?<=\n)/).slice(-100).join('') : text);
  }
  while (follow) {
    await sleep(500);
    for (const file of files) {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size < offsets.get(file)) offsets.set(file, 0);
      if (size > offsets.get(file)) {
        const chunk = readFrom(file, offsets.get(file));
        offsets.set(file, offsets.get(file) + chunk.length);
        print(file, chunk);
      }
    }
  }
}
