import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { droidMiddleware } from './middleware.js';
import { listSessions } from './sessions.js';
import { endpoints } from './banner.js';

const page = new URL('../hub/index.html', import.meta.url);
const cookieName = 'serve_droid_hub_token';
const namePattern = /^[a-zA-Z0-9_-]{1,100}$/;
const cli = new URL('../bin/serve-droid.js', import.meta.url);
// Players and <img> tags cannot send headers, so these emulator URLs also take the hub's ?token=.
const mediaPath = /^\/d\/[^/]+\/(ws|stream\.(mjpeg|h264|avcc)|screenshot)$/;

function tokenMatches(expected, given) {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

function hubCookie(header = '') {
  const pair = header.split(/;\s*/).find(entry => entry.startsWith(`${cookieName}=`));
  if (!pair) return undefined;
  try {
    return decodeURIComponent(pair.slice(cookieName.length + 1));
  } catch {
    return undefined;
  }
}

// The hub's own credentials stay at the hub; the emulators never see them.
function dropHubCredentials(req) {
  delete req.headers.authorization;
  const url = new URL(req.url, 'http://hub');
  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    req.url = url.pathname + url.search;
  }
  if (!req.headers.cookie) return;
  const rest = req.headers.cookie.split(/;\s*/).filter(pair => !pair.startsWith(`${cookieName}=`));
  if (rest.length) req.headers.cookie = rest.join('; ');
  else delete req.headers.cookie;
}

/**
 * One page and one port for every running serve-droid emulator. Each emulator's browser UI is proxied
 * under `/d/<name>/`, so a single `tailscale serve` (or SSH tunnel) covers all of them.
 *
 * The hub adds each emulator's token itself, so anyone who can reach the hub can use every emulator:
 * pass `token` (or `serve-droid hub --token`) to require one for the hub too.
 */
export function createHub({ token, sessions = listSessions, cacheMs = 2000, choices = {}, launch = launchEmulator } = {}) {
  let cached = { at: 0, list: [] };
  const proxies = new Map();
  // Emulators started from the page, until they show up as running (or fail).
  const starting = new Map();

  function current() {
    if (Date.now() - cached.at > cacheMs) {
      let list;
      try {
        list = sessions().filter(session => session.url && namePattern.test(session.name ?? ''));
      } catch (error) {
        list = cached.list;
        console.error(`serve-droid hub: listing emulators failed: ${error.message}`);
      }
      cached = { at: Date.now(), list: list.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    return cached.list;
  }

  // A proxy per emulator, rebuilt when its URL changes (a restart picks a new port or token).
  function proxyFor(name) {
    const session = current().find(entry => entry.name === name);
    if (!session) return undefined;
    const known = proxies.get(name);
    if (known?.url === session.url) return known.proxy;
    const proxy = droidMiddleware({ basePath: `/d/${name}`, url: session.url });
    proxies.set(name, { url: session.url, proxy });
    return proxy;
  }

  function authorized(req) {
    if (!token) return true;
    const header = req.headers.authorization ?? '';
    if (tokenMatches(token, header.startsWith('Bearer ') ? header.slice(7) : '')
      || tokenMatches(token, hubCookie(req.headers.cookie))) return true;
    const url = new URL(req.url ?? '/', 'http://hub');
    return req.method === 'GET' && mediaPath.test(url.pathname) && tokenMatches(token, url.searchParams.get('token'));
  }

  // Browser requests from another site may not start emulators. Non-browser clients send neither header.
  function crossSite(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) return site !== 'same-origin' && site !== 'none';
    const origin = req.headers.origin;
    try {
      return Boolean(origin) && new URL(origin).host !== req.headers.host;
    } catch {
      return true;
    }
  }

  function sessionUrls(req, name) {
    const proto = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? 'https' : 'http';
    const base = new URL(`d/${name}/`, `${proto}://${req.headers.host ?? 'localhost'}/`);
    if (token) base.searchParams.set('token', token);
    const { preview, ...rest } = endpoints(base.href);
    return rest;
  }

  function sessionList(req) {
    const running = current();
    for (const name of starting.keys()) {
      if (running.some(entry => entry.name === name) && starting.get(name).state === 'starting') starting.delete(name);
    }
    const list = running.map(({ name, device }) => ({
      name, device: device ?? null, path: `/d/${name}/`, state: 'running', urls: sessionUrls(req, name),
    }));
    for (const [name, job] of starting) {
      if (!running.some(entry => entry.name === name)) list.push({ name, device: job.device, path: null, ...job });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  function readBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > limit) reject(new Error('body too large'));
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  async function startSession(req, res) {
    if (crossSite(req)) return send(res, 403, 'application/json', JSON.stringify({ ok: false, error: 'cross-site request refused' }));
    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'expected a JSON body' }));
    }
    const { name, device, android } = body;
    const fail = error => send(res, 400, 'application/json', JSON.stringify({ ok: false, error }));
    if (typeof name !== 'string' || !namePattern.test(name)) return fail('Use 1–100 letters, digits, hyphens or underscores for the name.');
    if (device !== undefined && !(choices.devices ?? []).includes(device)) return fail('Choose a listed device.');
    if (android !== undefined && !(choices.android ?? []).includes(android)) return fail('Choose a listed Android version.');
    if (current().some(entry => entry.name === name) || starting.get(name)?.state === 'starting') {
      return fail(`${name} is already running or starting.`);
    }
    const job = { state: 'starting', progress: 'Starting…', device: [device, android && `Android ${android.replace(/\.0$/, '')}`].filter(Boolean).join(', ') || null };
    starting.set(name, job);
    launch({ name, device, android }, {
      progress: line => { job.progress = line; },
      done: (code, lastLine) => {
        cached.at = 0;
        if (code === 0) job.progress = 'Ready';
        else Object.assign(job, { state: 'failed', progress: lastLine || `serve-droid start exited with ${code}` });
      },
    });
    return send(res, 202, 'application/json', JSON.stringify({ ok: true, name }));
  }

  function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  }

  function emulatorName(url) {
    const match = /^\/d\/([^/?]+)(?:[/?]|$)/.exec(url ?? '');
    return match && namePattern.test(match[1]) ? match[1] : undefined;
  }

  function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://hub');
    if (!authorized(req)) {
      if (req.method === 'GET' && tokenMatches(token, url.searchParams.get('token'))) {
        // Any page link with ?token= sets the cookie, then drops the token from the address bar.
        url.searchParams.delete('token');
        return send(res, 302, 'text/plain', '', {
          location: url.pathname + url.search,
          'set-cookie': `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      return send(res, 401, 'text/plain', 'Unauthorized. Open the hub with ?token=<token>, as printed by serve-droid hub.');
    }
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Re-read so edits show up without a restart; the file is small.
      return send(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : readFileSync(page));
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, sessions: sessionList(req), choices }));
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      startSession(req, res).catch(error => send(res, 400, 'application/json', JSON.stringify({ ok: false, error: error.message })));
      return;
    }
    if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      // Dismiss a failed start.
      if (crossSite(req)) return send(res, 403, 'application/json', JSON.stringify({ ok: false, error: 'cross-site request refused' }));
      const name = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      if (starting.get(name)?.state === 'failed') starting.delete(name);
      return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    }
    const name = emulatorName(req.url);
    if (name) {
      const proxy = proxyFor(name);
      if (!proxy) return send(res, 404, 'text/plain', `No running emulator named ${name}. Run serve-droid ls.`);
      dropHubCredentials(req);
      return proxy(req, res, () => send(res, 404, 'text/plain', 'Not found.'));
    }
    return send(res, 404, 'text/plain', 'Not found.');
  }

  function upgrade(req, socket, head) {
    if (!authorized(req)) {
      return socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    }
    const name = emulatorName(req.url);
    const proxy = name ? proxyFor(name) : undefined;
    if (proxy) {
      dropHubCredentials(req);
      if (proxy.handleUpgrade(req, socket, head)) return;
    }
    socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  }

  return { handle, upgrade };
}

/** Run `serve-droid start` for the page. Progress lines come from its stderr. */
function launchEmulator({ name, device, android }, { progress, done }) {
  const args = [fileURLToPath(cli), 'start', '--name', name];
  if (device) args.push('--device', device);
  if (android) args.push('--android', android);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let last = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    const lines = chunk.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return;
    last = lines.at(-1).replace(/^serve-droid: /, '');
    // BuildKit's step lines ("#17 3.9 Installing…") are noise on a tile.
    progress(/^#\d+ /.test(last) ? 'Building the emulator image…' : last);
  });
  child.on('error', error => done(1, error.message));
  child.on('close', code => done(code ?? 1, last));
}

/** Start the hub server. Resolves with the printed URL once it listens. */
export function startHub({ host = '127.0.0.1', port = 6089, token, choices } = {}) {
  const hub = createHub({ token, choices });
  const server = http.createServer(hub.handle);
  server.on('upgrade', hub.upgrade);
  return new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is in use on ${host}. Choose another --port.`) : error));
    server.listen(Number(port), host, () => {
      server.off('error', reject);
      const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      const url = new URL(`http://${isIP(shown) === 6 ? `[${shown}]` : shown}:${server.address().port}/`);
      if (token) url.searchParams.set('token', token);
      resolve({ server, url: url.href });
    });
  });
}

export function hubToken() {
  return randomBytes(24).toString('base64url');
}
