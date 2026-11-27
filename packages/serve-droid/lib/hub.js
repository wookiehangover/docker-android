import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { droidMiddleware } from './middleware.js';
import { listSessions } from './sessions.js';

const page = new URL('../hub/index.html', import.meta.url);
const cookieName = 'serve_droid_hub_token';
const namePattern = /^[a-zA-Z0-9_-]{1,100}$/;

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
export function createHub({ token, sessions = listSessions, cacheMs = 2000 } = {}) {
  let cached = { at: 0, list: [] };
  const proxies = new Map();

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
    return tokenMatches(token, header.startsWith('Bearer ') ? header.slice(7) : '')
      || tokenMatches(token, hubCookie(req.headers.cookie));
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
      if (req.method === 'GET' && url.pathname === '/' && tokenMatches(token, url.searchParams.get('token'))) {
        return send(res, 302, 'text/plain', '', {
          location: '/',
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
      const list = current().map(({ name, device }) => ({ name, device: device ?? null, path: `/d/${name}/` }));
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, sessions: list }));
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

/** Start the hub server. Resolves with the printed URL once it listens. */
export function startHub({ host = '127.0.0.1', port = 6089, token } = {}) {
  const hub = createHub({ token });
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
