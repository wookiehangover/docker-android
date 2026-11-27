#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { apiLevels, docker, emulatorImage, ensureCustomImage, inspectContainer } from '../lib/docker.js';
import { kvmHelp } from '../lib/kvm.js';
import { nativeLaunch, nativeState, showFiles } from '../lib/native.js';
import { containerToken, containerUrl, listSessions, native, owner, projectName, readNativeState, resolveUrl, withToken } from '../lib/sessions.js';
import { actionHelp, actionOptions, actionVerbs, runAction } from '../lib/actions.js';
import { runMcp } from '../lib/mcp.js';

const help = `Usage: serve-droid [start|stop|ls|logs|rm|attach|mcp|ACTION] [options]

Start or reuse the project's Android emulator and print its browser URL.
Stop shuts the emulator down and keeps its Android data for the next start.

  start (default)   Launch natively on macOS and Windows, or with Docker/KVM on Linux
  stop              Stop the project's emulator and browser UI
  ls                List running emulators and their browser URLs
  logs              Show the emulator and browser UI logs (-f to follow)
  rm                Stop the emulator and delete its saved data (-y to skip the prompt)
  attach            Start or reuse a native Android emulator in the foreground
  mcp               Serve MCP over stdio for agents (--name, --url, --start boots the emulator first)
  --serial SERIAL   Native emulator to use on macOS and Windows (example: emulator-5554)
  --name NAME       Select a named emulator (default: current project)
  --device PROFILE  Device profile (default: Samsung Galaxy S10)
  --android VERSION Android version 9–17 (default: 16)
  --host IP         Bind the browser UI to this IP address (default: 127.0.0.1)
  --port PORT       Local browser port (default: Docker picks a free port)
  --apk FILE        Install an APK after boot
  --image IMAGE     Use a compatible Docker image instead of the default build
  --token           Require a token for the browser UI and API; the printed URL carries it
  --url URL         Use a running serve-droid at this URL (mcp and actions; or set SERVE_DROID_URL)
  -h, --help        Show this help

${actionHelp}`;

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const profiles = new Set([
  'Nexus 4', 'Nexus 5', 'Nexus 7', 'Nexus One', 'Nexus S', 'Pixel C', 'Pixel 8', 'Pixel 9',
  'Samsung Galaxy S6', 'Samsung Galaxy S7', 'Samsung Galaxy S7 Edge',
  'Samsung Galaxy S8', 'Samsung Galaxy S9', 'Samsung Galaxy S10',
]);

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
  if (options.token && !containerToken(container)) {
    throw new Error(`${name} is running without a token. Stop it first to restart it with --token.`);
  }
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
  // A new token per container: stopping the emulator revokes the old URL.
  const token = options.token ? randomBytes(24).toString('base64url') : undefined;
  const args = [
    'create', '--rm', '--name', `serve-droid-${name}`, '--device', '/dev/kvm',
    ...(token ? ['--label', `serve-droid.token=${token}`, '--env', `WEB_UI_TOKEN=${token}`] : []),
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

async function waitForBoot(id, name, url, token) {
  const deadline = Date.now() + 600_000;
  console.error(`Waiting for ${name} to boot…`);
  while (Date.now() < deadline) {
    if (!inspectContainer(id)?.State.Running) throw new Error(`${name} stopped during boot.`);
    try {
      const boot = docker('exec', id, 'adb', 'shell',
        'getprop sys.boot_completed; getprop init.svc.bootanim; pm path android');
      if (/^1\r?\nstopped\r?\npackage:/.test(boot)) {
        const response = await fetch(`${url}info`, {
          signal: AbortSignal.timeout(3000), headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (response.ok) return;
      }
    } catch {
      // adb and the HTTP listener come up separately during boot.
    }
    await sleep(2000);
  }
  throw new Error(`Boot timed out. Run serve-droid logs --name ${name.replace(/^serve-droid-/, '')} for details.`);
}

const lifecycleOptions = {
  help: { type: 'boolean', short: 'h' },
  serial: { type: 'string' }, follow: { type: 'boolean', short: 'f' }, yes: { type: 'boolean', short: 'y' },
  name: { type: 'string' }, device: { type: 'string' }, android: { type: 'string' },
  host: { type: 'string' }, port: { type: 'string' }, apk: { type: 'string' }, image: { type: 'string' },
  token: { type: 'boolean' },
};

function checkName(name) {
  if (name !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(name)) {
    throw new Error('--name must be 1–100 letters, digits, hyphens or underscores.');
  }
}

// Action verbs and mcp talk to a running emulator and take their own options.
function parseClientCommand(verb) {
  const options = verb === 'mcp'
    ? { help: lifecycleOptions.help, name: { type: 'string' }, url: { type: 'string' }, start: { type: 'boolean' } }
    : { help: lifecycleOptions.help, name: { type: 'string' }, ...actionOptions };
  // Negative numbers (geo -122.4, swipe offsets) are arguments, not options.
  const negative = /^-\d+(\.\d+)?$/;
  const argv = process.argv.slice(2).map(arg => negative.test(arg) ? `\0${arg}` : arg);
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options });
  if (values.help) return { command: 'help' };
  const args = positionals.slice(positionals.indexOf(verb) + 1).map(arg => arg.replace(/^\0/, ''));
  if (verb === 'mcp' && args.length) throw new Error('mcp takes no arguments.');
  if (values.name !== undefined && values.url !== undefined) throw new Error('Use --name or --url, not both.');
  if (values.start && values.url !== undefined) throw new Error('--start manages a local emulator; it cannot be used with --url.');
  checkName(values.name);
  return { command: verb, args, values };
}

function parseCommand() {
  const [verb] = parseArgs({ allowPositionals: true, strict: false, options: { ...lifecycleOptions, ...actionOptions } }).positionals;
  if (verb === 'mcp' || actionVerbs.has(verb)) return parseClientCommand(verb);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: lifecycleOptions });
  if (values.help) return { command: 'help' };
  const [command = 'start'] = positionals;
  if (positionals.length > 1 || !['start', 'stop', 'ls', 'logs', 'rm', 'attach'].includes(command)) throw new Error(help);
  if (command === 'ls') {
    if (Object.keys(values).length) throw new Error('ls takes no options.');
    return { command };
  }
  if (command === 'attach' && Object.keys(values).some(key => !['serial', 'port'].includes(key))) {
    throw new Error('Native emulator startup accepts --serial and --port.');
  }
  if (native && command === 'start' && Object.keys(values).some(key => !['serial', 'port', 'name', 'apk', 'token'].includes(key))) {
    throw new Error('Native emulator startup accepts --serial, --port, --name, --apk and --token.');
  }
  if (!native && command !== 'attach' && values.serial !== undefined) throw new Error('--serial requires attach.');
  const only = { stop: ['name'], logs: ['name', 'follow'], rm: ['name', 'yes'] }[command];
  const extra = Object.keys(values).filter(key => !(only ?? ['name', 'serial', 'port', 'device', 'android', 'host', 'apk', 'image', 'token']).includes(key));
  if (extra.length) throw new Error(`--${extra[0]} does not apply to ${command}.`);
  const name = values.name ?? projectName();
  checkName(name);
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

// Keep the token in the session state so a running browser UI and its URL keep matching.
function nativeToken(name, values) {
  const statePath = join(nativeState, `${name}.json`);
  const state = readNativeState(name);
  const running = listSessions().some(session => session.name === name);
  let token = running ? state.token : undefined;
  if (running && values.token && !token) {
    throw new Error(`${name} is running without a token. Stop it first to restart it with --token.`);
  }
  if (!running) token = values.token ? randomBytes(24).toString('base64url') : undefined;
  if (token !== state.token && (token || existsSync(statePath))) {
    mkdirSync(nativeState, { recursive: true });
    const { token: _, ...rest } = state;
    writeFileSync(statePath, JSON.stringify(token ? { ...rest, token } : rest));
  }
  return token;
}

async function launchNative(command, name, values) {
  const args = [command, '--port', values.port ?? '6090'];
  if (values.serial) args.push('--serial', values.serial);
  if (command !== 'attach') args.push('--state', join(nativeState, `${name}.json`));
  if (command === 'start') {
    const token = nativeToken(name, values);
    if (token) process.env.WEB_UI_TOKEN = token;
    else delete process.env.WEB_UI_TOKEN;
  }
  const url = await nativeLaunch(args, command === 'start');
  return url && withToken(url, process.env.WEB_UI_TOKEN);
}

async function installApk(url, apk) {
  console.error(`Installing ${basename(apk)}…`);
  const token = new URL(url).searchParams.get('token');
  const response = await fetch(new URL('api/install', url), {
    method: 'POST', body: createReadStream(apk), duplex: 'half',
    headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new Error(`APK install failed (${response.status}): ${await response.text()}`);
}

function printSessions() {
  const rows = listSessions().map(session => [session.name, session.url ?? '-', session.device]);
  if (!rows.length) return console.error('No running emulators.');
  rows.unshift(['NAME', 'URL', 'DEVICE']);
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => String(row[i] ?? '').length)));
  for (const row of rows) console.log(row.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd());
}

async function stopContainer(container) {
  if (!container) return;
  if (container.State.Running) {
    // Let Android flush its package database and userdata before Docker stops QEMU.
    docker('exec', container.Id, 'sh', '-c',
      'if timeout 3 adb get-state >/dev/null 2>&1; then ' +
      'timeout 15 adb shell svc power shutdown; timeout 25 adb wait-for-disconnect; fi; exit 0');
    if (inspectContainer(container.Id)?.State.Running) docker('stop', container.Id);
  }
  if (container.State.Status === 'created') docker('rm', container.Id);
  // Docker can return from stop before automatic removal releases the name.
  const deadline = Date.now() + 15_000;
  while (inspectContainer(container.Id)) {
    if (Date.now() >= deadline) throw new Error(`Docker is still removing ${container.Name.slice(1)}.`);
    await sleep(100);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  // tail exits on Ctrl-C while following; that is a normal way to finish.
  if (result.status && result.signal !== 'SIGINT') process.exitCode = result.status;
}

async function showLogs(name, follow) {
  if (native) {
    const state = existsSync(join(nativeState, `${name}.json`))
      ? JSON.parse(readFileSync(join(nativeState, `${name}.json`), 'utf8')) : {};
    const files = [join(nativeState, `${name}.log`)];
    // The emulator log is shared, so it only belongs to this session when serve-droid booted the emulator for it.
    if (state.avd) files.unshift(join(nativeState, 'emulator.log'));
    if (!files.some(file => existsSync(file))) throw new Error(`No logs for ${name}. Start it with serve-droid start.`);
    return showFiles(files.filter(file => follow || existsSync(file)), follow);
  }
  const tail = follow ? ['-n', '100', '-F'] : ['-n', '+1'];
  const container = inspectContainer(`serve-droid-${name}`);
  if (!container?.State.Running) throw new Error(`${name} is not running. Its logs are removed when it stops.`);
  checkOwner(container.Config.Labels, name);
  // Images without the browser UI have no web_ui log.
  run('docker', ['exec', container.Id, 'sh', '-c',
    'cd logs && exec tail "$@" $(ls device.stdout.log web_ui.stdout.log 2>/dev/null)', 'sh', ...tail]);
}

async function confirm(question) {
  if (!process.stdin.isTTY) throw new Error('Run rm with --yes to confirm without a terminal.');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } catch (error) {
    if (error.name === 'AbortError') return false;
    throw error;
  } finally {
    prompt.close();
  }
}

function existingVolumes(name) {
  return [`serve-droid-${name}-home`, `serve-droid-${name}-data`].filter(volume => {
    try {
      checkOwner(JSON.parse(docker('volume', 'inspect', volume))[0].Labels, name);
      return true;
    } catch (error) {
      if (/No such volume/i.test(error.message)) return false;
      throw error;
    }
  });
}

async function remove(name, yes) {
  if (native) {
    const files = [`${name}.json`, `${name}.log`].map(file => join(nativeState, file)).filter(existsSync);
    if (!files.length) return console.error(`Nothing to remove for ${name}.`);
    if (!yes && !await confirm(`Stop ${name} and forget its session?`)) return console.error('Cancelled.');
    await launchNative('stop', name, {});
    if (process.exitCode) return;
    for (const file of files) rmSync(file, { force: true });
    return console.error(`Removed ${name}. The AVD and its apps are kept; manage them in Android Studio's Device Manager.`);
  }
  const container = inspectContainer(`serve-droid-${name}`);
  if (container) checkOwner(container.Config.Labels, name);
  const volumes = existingVolumes(name);
  if (!container && !volumes.length) return console.error(`Nothing to remove for ${name}.`);
  if (!yes && !await confirm(`Stop ${name} and delete its apps, settings and data?`)) return console.error('Cancelled.');
  await stopContainer(container);
  if (volumes.length) docker('volume', 'rm', ...volumes);
  console.error(`Removed ${name}.`);
}

// Start or reuse the emulator and return its URL (with ?token= when it has one). Progress goes to stderr.
async function startEmulator(name, values) {
  if (native) return launchNative('start', name, values);
  if (!existsSync('/dev/kvm')) throw new Error(kvmHelp());
  const containerName = `serve-droid-${name}`;
  const container = inspectContainer(containerName);
  if (container) checkContainer(container, name, values);
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
  const running = inspectContainer(id);
  const url = containerUrl(running);
  const token = containerToken(running);
  await waitForBoot(id, containerName, url, token);
  return withToken(url, token);
}

async function main() {
  const { command, name, values, args } = parseCommand();
  if (command === 'help') return console.log(help);
  if (command === 'ls') return printSessions();
  if (command === 'mcp') {
    // stdout is the JSON-RPC channel: everything else goes to stderr.
    console.log = console.error;
    let started;
    const resolve = async () => values.start
      ? started ??= startEmulator(values.name ?? projectName(), {}).catch(error => {
        started = undefined; // let the next tool call retry
        throw error;
      })
      : resolveUrl({ name: values.name, url: values.url });
    if (values.start) resolve().catch(error => console.error(`serve-droid mcp: ${error.message}`));
    return runMcp({ resolve, version });
  }
  if (actionVerbs.has(command)) {
    const url = resolveUrl({ name: values.name, url: values.url });
    process.exitCode = await runAction(command, args, values, url);
    return;
  }
  if (command === 'logs') return showLogs(name, values.follow);
  if (command === 'rm') return remove(name, values.yes);
  if (command === 'attach' || (native && command === 'stop')) {
    const url = await launchNative(command, name, values);
    if (url) console.log(url);
    return;
  }
  if (command === 'stop') {
    const container = inspectContainer(`serve-droid-${name}`);
    if (container) checkOwner(container.Config.Labels, name);
    return stopContainer(container);
  }
  const url = await startEmulator(name, values);
  if (!url) return;
  if (values.apk) await installApk(url, values.apk);
  console.log(url);
}

main().catch(error => {
  console.error(`serve-droid: ${error.message}`);
  if (error.usage) console.error('Run serve-droid --help for usage.');
  process.exitCode = 1;
});
