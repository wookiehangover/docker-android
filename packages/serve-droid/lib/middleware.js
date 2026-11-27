import http from 'node:http';
import https from 'node:https';
import { parseUrl } from './client.js';

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade']);

/**
 * Connect-style middleware that serves a serve-droid browser UI under `basePath` of your own server
 * (Express, Connect, Vite, Metro or plain node:http). Call `handleUpgrade` from the server's `upgrade` event
 * so the video and logcat WebSockets work too.
 *
 * The Host header is passed through unchanged, so serve-droid's cross-site check still compares the
 * browser's Origin with your server's host. A `?token=` in `url` is sent as a Bearer header: anyone who
 * can reach your server under basePath can then use the emulator.
 */
export function droidMiddleware({ basePath = '/.droid', url } = {}) {
  if (!url) throw new Error('droidMiddleware needs the serve-droid url.');
  const { base, token } = parseUrl(url);
  const target = new URL(base);
  const client = target.protocol === 'https:' ? https : http;
  const prefix = `/${basePath.replace(/^\/+|\/+$/g, '')}`;

  // Return the upstream path for a request under basePath, or undefined when it is not ours.
  function upstreamPath(reqUrl) {
    const [path, query = ''] = (reqUrl ?? '/').split(/\?(.*)/s, 2);
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return undefined;
    const rest = path.slice(prefix.length).replace(/^\//, '');
    return `${target.pathname}${rest}${query ? `?${query}` : ''}`;
  }

  function headers(req) {
    const out = {};
    const connection = String(req.headers.connection ?? '').toLowerCase().split(/\s*,\s*/);
    for (const [key, value] of Object.entries(req.headers)) {
      if (!hopByHop.has(key) && !connection.includes(key)) out[key] = value;
    }
    if (token) out.authorization = `Bearer ${token}`;
    out['x-forwarded-prefix'] = prefix;
    return out;
  }

  function middleware(req, res, next) {
    const path = upstreamPath(req.url);
    if (path === undefined) return next ? next() : undefined;
    // Relative URLs in the page (api/..., ws) need the trailing slash.
    if (req.url.split('?')[0] === prefix) {
      res.writeHead(308, { location: `${prefix}/${req.url.slice(prefix.length)}` });
      return res.end();
    }
    const upstream = client.request({
      protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      method: req.method, path, headers: headers(req),
    }, response => {
      const out = { ...response.headers };
      for (const key of hopByHop) delete out[key];
      // Keep redirects (like /?token= → ./) inside basePath.
      if (out.location?.startsWith('/')) out.location = `${prefix}${out.location}`;
      res.writeHead(response.statusCode, response.statusMessage, out);
      response.pipe(res);
    });
    upstream.on('error', error => {
      if (res.headersSent) return res.destroy(error);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`serve-droid is not reachable at ${base}: ${error.message}`);
    });
    req.pipe(upstream);
  }

  /** Proxy a WebSocket upgrade. Returns false when the request is not under basePath. */
  middleware.handleUpgrade = function handleUpgrade(req, socket, head) {
    const path = upstreamPath(req.url);
    if (path === undefined) return false;
    const upstream = client.request({
      protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      method: req.method, path, headers: { ...headers(req), connection: 'Upgrade', upgrade: req.headers.upgrade },
    });
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      const close = () => { socket.destroy(); upstreamSocket.destroy(); };
      socket.on('error', close);
      upstreamSocket.on('error', close);
      socket.on('close', close);
      upstreamSocket.on('close', close);
    });
    upstream.on('response', response => {
      // The upstream refused the upgrade (403 cross-site, 401 token, 404).
      socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      response.resume();
    });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'));
    socket.on('error', () => upstream.destroy());
    upstream.end();
    return true;
  };

  return middleware;
}

export default droidMiddleware;
