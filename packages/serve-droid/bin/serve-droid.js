#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { apiLevels, docker, emulatorImage, ensureCustomImage, inspectContainer } from '../lib/docker.js';

const help = `Usage: serve-droid [start|stop|attach] [options]

Start or reuse the project's Android emulator and print its browser URL.
Stop shuts the emulator down and keeps its Android data for the next start.

  start (default)   Launch natively on macOS or with Docker/KVM on Linux
  stop              Stop the project's emulator and browser UI
  attach            Start or reuse a native Android emulator in the foreground
  --serial SERIAL   Native emulator to use on macOS (example: emulator-5554)
  --name NAME       Select a named emulator (default: current project)
  --device PROFILE  Device profile (default: Samsung Galaxy S10)
  --android VERSION Android version 9–17 (default: 16)
  --host IP         Bind the browser UI to this IP address (default: 127.0.0.1)
  --port PORT       Local browser port (default: Docker picks a free port)
  --apk FILE        Install an APK after boot
  --image IMAGE     Use a compatible Docker image instead of the default build
  -h, --help        Show this help`;

const owner = 'serve-droid.name';
const mac = process.platform === 'darwin';
const profiles = new Set([
  'Nexus 4', 'Nexus 5', 'Nexus 7', 'Nexus One', 'Nexus S', 'Pixel C', 'Pixel 8', 'Pixel 9',
  'Samsung Galaxy S6', 'Samsung Galaxy S7', 'Samsung Galaxy S7 Edge',
  'Samsung Galaxy S8', 'Samsung Galaxy S9', 'Samsung Galaxy S10',
]);

function projectName() {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const path = git.status === 0 ? git.stdout.trim() : process.cwd();
  const slug = basename(path).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
  return `${slug || 'project'}-${createHash('sha256').update(path).digest('hex').slice(0, 10)}`;
}

function checkConfig(settings, options) {
  for (const key of ['device', 'android', 'image', 'host', 'port']) {
    if (options[key] !== undefined && options[key] !== settings[key]) {
      throw new Error(`This emulator uses a different --${key}. Choose another --name for the new configuration.`);
    }
  }
}

function checkOwner(labels, name) {
  if (labels?.[owner] !== name) {
    throw new Error(`A Docker resource for ${name} belongs to another launcher. Choose a different --name.`);
  }
}

function deviceVolumes(name, options) {
  const home = `serve-droid-${name}-home`;
  const data = `serve-droid-${name}-data`;
  const defaults = {
    device: options.device ?? 'Samsung Galaxy S10',
    android: options.image ? undefined : options.android ?? '16.0',
    image: options.image, port: options.port,
  };
  // Volume creation is idempotent. Docker keeps the first creator's labels.
  docker('volume', 'create', '--label', `${owner}=${name}`,
    '--label', `serve-droid.config=${JSON.stringify(defaults)}`, home);
  const labels = JSON.parse(docker('volume', 'inspect', home))[0].Labels;
  checkOwner(labels, name);
  const settings = JSON.parse(labels['serve-droid.config']);
  checkConfig(settings, { device: options.device, android: options.android, image: options.image });
  docker('volume', 'create', '--label', `${owner}=${name}`, data);
  checkOwner(JSON.parse(docker('volume', 'inspect', data))[0].Labels, name);
  const mounts = ['--volume', `${home}:/home/androidusr/.android`,
    '--volume', `${data}:/home/androidusr/emulator`];
  return { settings, mounts };
}

function checkContainer(container, name, options) {
  checkOwner(container.Config.Labels, name);
  const settings = JSON.parse(container.Config.Labels['serve-droid.config']);
  const binding = container.NetworkSettings.Ports['6090/tcp']?.[0];
  settings.port = binding?.HostPort ?? settings.port;
  settings.host = binding?.HostIp ?? settings.host ?? '127.0.0.1';
  checkConfig(settings, options);
}

function createContainer(name, options) {
  if (options.image) ensureCustomImage(options.image);
  const { settings, mounts } = deviceVolumes(name, options);
  const image = settings.image ?? emulatorImage(settings.android);
  const port = options.port ?? settings.port;
  const host = options.host ?? '127.0.0.1';
  const publishHost = isIP(host) === 6 ? `[${host}]` : host;
  docker('run', '--rm', '--user', '0', '--entrypoint', 'chown', ...mounts, image,
    '1300:1301', '/home/androidusr/emulator', '/home/androidusr/.android');
  const args = [
    'create', '--rm', '--name', `serve-droid-${name}`, '--device', '/dev/kvm',
    '--publish', `${publishHost}:${port ?? ''}:6090`,
    '--label', `${owner}=${name}`, '--label', `serve-droid.config=${JSON.stringify({ ...settings, host, port })}`,
    '--env', `EMULATOR_DEVICE=${settings.device}`, '--env', 'WEB_UI=true', '--env', 'EMULATOR_HEADLESS=true',
    ...mounts,
  ];
  try {
    return docker(...args, image);
  } catch (error) {
    if (!error.message.includes('already in use')) throw error;
    const existing = inspectContainer(`serve-droid-${name}`);
    if (!existing) throw error;
    checkContainer(existing, name, options);
    return existing.Id;
  }
}

async function waitForBoot(id, name, url) {
  const deadline = Date.now() + 600_000;
  console.error(`Waiting for ${name} to boot…`);
  while (Date.now() < deadline) {
    if (!inspectContainer(id)?.State.Running) throw new Error(`${name} stopped during boot.`);
    try {
      const boot = docker('exec', id, 'adb', 'shell',
        'getprop sys.boot_completed; getprop init.svc.bootanim; pm path android');
      if (/^1\r?\nstopped\r?\npackage:/.test(boot)) {
        const response = await fetch(`${url}info`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) return;
      }
    } catch {
      // adb and the HTTP listener come up separately during boot.
    }
    await sleep(2000);
  }
  throw new Error(`Boot timed out. Run docker exec ${name} cat logs/device.stdout.log for details.`);
}

function parseCommand() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      serial: { type: 'string' },
      name: { type: 'string' }, device: { type: 'string' }, android: { type: 'string' },
      host: { type: 'string' }, port: { type: 'string' }, apk: { type: 'string' }, image: { type: 'string' },
    },
  });
  if (values.help) return { command: 'help' };
  const [command = 'start'] = positionals;
  if (positionals.length > 1 || !['start', 'stop', 'attach'].includes(command)) throw new Error(help);
  if (command === 'attach' && Object.keys(values).some(key => !['serial', 'port'].includes(key))) {
    throw new Error('Native emulator startup accepts --serial and --port.');
  }
  if (mac && command === 'start' && Object.keys(values).some(key => !['serial', 'port', 'name', 'apk'].includes(key))) {
    throw new Error('Native emulator startup on macOS accepts --serial, --port, --name and --apk.');
  }
  if (!mac && command !== 'attach' && values.serial !== undefined) throw new Error('--serial requires attach.');
  if (command === 'stop' && Object.keys(values).some(key => key !== 'name')) {
    throw new Error('Only --name applies to stop.');
  }
  const name = values.name ?? projectName();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name)) {
    throw new Error('--name must be 1–100 letters, digits, hyphens or underscores.');
  }
  if (values.host !== undefined) {
    if (!isIP(values.host) || values.host.includes('%')) throw new Error('--host must be an IPv4 or IPv6 address.');
    if (isIP(values.host) === 6) values.host = new URL(`http://[${values.host}]`).hostname.slice(1, -1);
  }
  if (values.port !== undefined && (!/^[1-9]\d{0,4}$/.test(values.port) || Number(values.port) > 65535)) {
    throw new Error('--port must be between 1 and 65535.');
  }
  if (values.device !== undefined && !profiles.has(values.device)) {
    throw new Error(`Choose a supported --device: ${[...profiles].join(', ')}`);
  }
  if (values.android !== undefined) {
    values.android = values.android.replace(/^(\d+)$/, '$1.0');
    if (!apiLevels.has(values.android)) throw new Error('--android must be a supported version from 9 to 17.');
    if (values.image !== undefined) throw new Error('The custom image determines its Android version. Use --image by itself.');
  }
  if (values.image !== undefined && !/^[a-zA-Z0-9][^\s]*$/.test(values.image)) {
    throw new Error('Expected a Docker image reference for --image.');
  }
  if (values.apk !== undefined && !statSync(values.apk, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`APK file not found: ${values.apk}`);
  }
  return { command, name, values };
}

function nativeLaunch(command, name, values) {
  const script = fileURLToPath(new URL('../lib/mac-launch.sh', import.meta.url));
  const args = [script, command, '--port', values.port ?? '6090'];
  if (values.serial) args.push('--serial', values.serial);
  if (command !== 'attach') args.push('--state', join(homedir(), 'Library/Caches/serve-droid', `${name}.json`));
  const capture = command === 'start';
  const result = spawnSync('/bin/sh', args, { stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  return capture ? result.stdout.trim().split('\n').at(-1) : undefined;
}

async function installApk(url, apk) {
  console.error(`Installing ${basename(apk)}…`);
  const response = await fetch(`${url}api/install`, {
    method: 'POST', body: createReadStream(apk), duplex: 'half',
    headers: { 'content-type': 'application/octet-stream' },
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new Error(`APK install failed (${response.status}): ${await response.text()}`);
}

async function main() {
  const { command, name, values } = parseCommand();
  if (command === 'help') return console.log(help);
  if (command === 'attach' || mac) {
    const url = nativeLaunch(command, name, values);
    if (!url) return;
    if (values.apk) await installApk(url, values.apk);
    return console.log(url);
  }
  if (command === 'start' && !existsSync('/dev/kvm')) {
    throw new Error('Starting the emulator requires a local Linux Docker host with /dev/kvm.');
  }
  const containerName = `serve-droid-${name}`;
  const container = inspectContainer(containerName);
  if (container) checkContainer(container, name, values);
  if (command === 'stop') {
    if (container?.State.Running) {
      // Let Android flush its package database and userdata before Docker stops QEMU.
      docker('exec', container.Id, 'sh', '-c',
        'if timeout 3 adb get-state >/dev/null 2>&1; then ' +
        'timeout 15 adb shell svc power shutdown; timeout 25 adb wait-for-disconnect; fi; exit 0');
      if (inspectContainer(container.Id)?.State.Running) docker('stop', container.Id);
    }
    if (container?.State.Status === 'created') docker('rm', container.Id);
    // Docker can return from stop before automatic removal releases the name.
    const deadline = Date.now() + 15_000;
    while (container && inspectContainer(container.Id)) {
      if (Date.now() >= deadline) throw new Error(`Docker is still removing ${containerName}.`);
      await sleep(100);
    }
    return;
  }
  const id = container?.Id ?? createContainer(name, values);
  if (!container?.State.Running) {
    try {
      docker('start', id);
    } catch (error) {
      // A failed port bind should not claim the project name on a first launch.
      if (!container && inspectContainer(id)?.State.Status === 'created') docker('rm', id);
      throw error;
    }
  }
  const binding = inspectContainer(id).NetworkSettings.Ports['6090/tcp'][0];
  let host = binding.HostIp;
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  const url = `http://${isIP(host) === 6 ? `[${host}]` : host}:${binding.HostPort}/`;
  await waitForBoot(id, containerName, url);
  if (values.apk) await installApk(url, values.apk);
  console.log(url);
}

main().catch(error => {
  console.error(`serve-droid: ${error.message}`);
  process.exitCode = 1;
});
