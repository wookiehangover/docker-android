import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isIP } from 'node:net';
import { docker } from './docker.js';
import { commandLine, nativeState } from './native.js';

export const owner = 'serve-droid.name';
export const native = process.platform === 'darwin' || process.platform === 'win32';

// One emulator per Git root: the name is the folder slug plus a short hash of the path.
export function projectName(cwd = process.cwd()) {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd });
  const path = git.status === 0 ? git.stdout.trim() : cwd;
  const slug = basename(path).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
  return `${slug || 'project'}-${createHash('sha256').update(path).digest('hex').slice(0, 10)}`;
}

export function withToken(url, token) {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.href;
}

export function containerUrl(container) {
  const binding = container.NetworkSettings.Ports['6090/tcp'][0];
  let host = binding.HostIp;
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${binding.HostPort}/`;
}

export function containerToken(container) {
  const env = container.Config.Env?.find(entry => entry.startsWith('WEB_UI_TOKEN='));
  return container.Config.Labels?.['serve-droid.token'] || env?.slice('WEB_UI_TOKEN='.length) || undefined;
}

export function readNativeState(name) {
  try {
    return JSON.parse(readFileSync(join(nativeState, `${name}.json`), 'utf8'));
  } catch {
    return {};
  }
}

// Running native sessions. A stopped or crashed browser UI leaves its state file behind; skip it and any reused PID.
export function nativeSessions() {
  const files = existsSync(nativeState) ? readdirSync(nativeState).filter(file => file.endsWith('.json')) : [];
  return files.flatMap(file => {
    const name = basename(file, '.json');
    const state = readNativeState(name);
    if (!commandLine(state.pid).includes('attach.py')) return [];
    const url = `http://127.0.0.1:${state.port}/`;
    return [{ name, url: withToken(url, state.token), device: state.serial, token: state.token }];
  });
}

export function dockerSessions() {
  const ids = docker('ps', '--quiet', '--filter', `label=${owner}`).split('\n').filter(Boolean);
  if (!ids.length) return [];
  return JSON.parse(docker('container', 'inspect', ...ids)).map(container => {
    let settings = {};
    try {
      settings = JSON.parse(container.Config.Labels['serve-droid.config'] ?? '{}');
    } catch {
      // A hand-labelled container may carry no config; show what we can.
    }
    const device = [settings.device, settings.android && `Android ${settings.android.replace(/\.0$/, '')}`]
      .filter(Boolean).join(', ') || settings.image;
    const bound = container.NetworkSettings.Ports['6090/tcp']?.length;
    const token = containerToken(container);
    return {
      name: container.Config.Labels[owner],
      url: bound ? withToken(containerUrl(container), token) : undefined,
      device, token,
    };
  });
}

export function listSessions() {
  return native ? nativeSessions() : dockerSessions();
}

/**
 * Return the browser URL (with ?token= when the emulator has one) of a running emulator.
 * An explicit url wins; otherwise SERVE_DROID_URL, then the named or current project's emulator.
 */
export function resolveUrl({ name, url } = {}) {
  const explicit = url ?? (name ? undefined : process.env.SERVE_DROID_URL);
  if (explicit) {
    const parsed = new URL(explicit);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('--url must be an http or https URL.');
    return parsed.href;
  }
  const wanted = name ?? projectName();
  const session = listSessions().find(entry => entry.name === wanted);
  if (!session?.url) {
    throw new Error(`No running emulator named ${wanted}. Start it with serve-droid start${name ? ` --name ${name}` : ''}, or pass --url.`);
  }
  return session.url;
}
