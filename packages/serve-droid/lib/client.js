import { readFile } from 'node:fs/promises';

export class ServeDroidError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ServeDroidError';
    this.status = status;
    this.body = body;
  }
}

const selectorKeys = ['text', 'id', 'desc', 'class', 'exact', 'index'];

function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
}

/** Split a serve-droid URL into its base (with a trailing slash) and the ?token= value, if any. */
export function parseUrl(url) {
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token') ?? undefined;
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return { base: parsed.href, token };
}

/**
 * Connect to a running serve-droid browser UI. The URL is the one `serve-droid start` prints;
 * a `?token=` query becomes an Authorization header on every request.
 */
export function connect(url, options = {}) {
  const parsedUrl = parseUrl(url);
  const base = parsedUrl.base;
  const token = options.token ?? parsedUrl.token;
  const timeout = options.timeoutMs ?? 120_000;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function raw(method, path, { query, body, headers = {}, timeoutMs = timeout } = {}) {
    const target = new URL(path, base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) {
      if (body instanceof Uint8Array || typeof body?.pipe === 'function') {
        init.body = body;
        init.duplex = 'half';
        init.headers['content-type'] ??= 'application/octet-stream';
      } else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    let response;
    try {
      response = await doFetch(target, init);
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : error.cause?.message ?? error.message;
      throw new ServeDroidError(`${method} ${target.pathname}: ${reason}`, { status: 0 });
    }
    return response;
  }

  async function request(method, path, options = {}) {
    const response = await raw(method, path, options);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = undefined;
    }
    if (!response.ok || data?.ok === false || data === undefined) {
      const detail = data?.error ?? (text.trim().slice(0, 300) || response.statusText);
      const hint = response.status === 401 ? ' (pass the URL with its ?token=)' : '';
      throw new ServeDroidError(`${method} ${new URL(path, base).pathname} failed (${response.status}): ${detail}${hint}`,
        { status: response.status, body: data ?? text });
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) delete data.ok;
    return data;
  }

  const get = (path, query, opts) => request('GET', path, { query, ...opts });
  const post = (path, body = {}, opts) => request('POST', path, { body, ...opts });
  const app = (action, pkg) => post('api/app', { action, package: pkg });
  const snapshots = (action, name) => post('api/snapshots', name === undefined ? { action } : { action, name });

  return {
    url: base,
    token,
    request,
    raw,
    info: () => get('info'),
    deviceInfo: () => get('api/device-info'),
    state: () => get('api/state'),
    foreground: () => get('api/foreground'),
    tools: () => get('tools.json'),

    find: selector => post('api/find', pick(selector, selectorKeys)),
    tap(target, y, opts = {}) {
      return post('api/tap', typeof target === 'number'
        ? { x: target, y, ...pick(opts, ['duration_ms']) }
        : pick(target, [...selectorKeys, 'x', 'y', 'duration_ms']));
    },
    longPress: (x, y, durationMs = 800) => post('api/tap', { x, y, duration_ms: durationMs }),
    waitFor(selector, opts = {}) {
      const all = { ...selector, ...opts };
      const timeoutMs = all.timeout_ms ?? 10_000;
      return post('api/wait', { ...pick(all, selectorKeys), ...pick(all, ['timeout_ms', 'interval_ms', 'gone']) },
        { timeoutMs: timeoutMs + 30_000 });
    },
    swipe(x1, y1, x2, y2, durationMs) {
      const body = typeof x1 === 'object' ? x1 : { x1, y1, x2, y2, duration_ms: durationMs };
      return post('api/swipe', pick(body, ['x1', 'y1', 'x2', 'y2', 'duration_ms']));
    },
    scroll: opts => post('api/scroll', pick(opts, ['x', 'y', 'dx', 'dy'])),
    pinch: opts => post('api/pinch', pick(opts, ['x', 'y', 'scale', 'duration_ms'])),
    type: text => post('api/text', { text }),
    key: key => post('api/key', { key }),
    rotate: () => post('api/rotate'),
    openUrl: url => post('api/open-url', { url }),
    setClipboard: text => post('api/clipboard', { text }),
    setAppearance: dark => post('api/appearance', { dark }),
    setBattery: (level, charging = false) => post('api/battery', { level, charging }),

    async screenshot() {
      const response = await raw('GET', 'screenshot');
      if (!response.ok) throw new ServeDroidError(`GET /screenshot failed (${response.status})`, { status: response.status });
      return Buffer.from(await response.arrayBuffer());
    },
    frame: (opts = {}) => get('api/frame', { max_edge: opts.maxEdge ?? opts.max_edge }),
    uiTree: () => get('api/ui-tree'),
    logcat: (opts = {}) => get('api/logcat', pick(opts, ['lines', 'level', 'package', 'text'])),

    apps: (opts = {}) => get('api/apps', opts.all ? { all: 'true' } : undefined),
    launch: pkg => app('launch', pkg),
    stop: pkg => app('stop', pkg),
    clearData: pkg => app('clear', pkg),
    uninstall: pkg => app('uninstall', pkg),
    async install(apk) {
      const data = typeof apk === 'string' ? await readFile(apk) : apk;
      return request('POST', 'api/install', { body: data, timeoutMs: 240_000 });
    },
    snapshot: {
      list: () => snapshots('list'),
      save: name => snapshots('save', name),
      load: name => snapshots('load', name),
      delete: name => snapshots('delete', name),
    },

    sms: (number, text) => post('api/sms', { number, text }),
    call: (number, action = 'call') => post('api/phone', { number, action }),
    fingerprint: (id = 1) => post('api/fingerprint', { id }),
    network: (opts = {}) => post('api/network', opts),
    geo: (lat, lng) => post('api/location', { lat, lng }),
    route: (points, opts = {}) => post('api/location', { route: points, ...pick(opts, ['interval_ms', 'loop']) }),
    stopRoute: () => post('api/location', { stop: true }),
    accessibility: (opts = {}) => post('api/accessibility', opts),
    shell: (command, opts = {}) => post('api/shell', { command, ...pick(opts, ['timeout_ms']) },
      { timeoutMs: (opts.timeout_ms ?? 30_000) + 30_000 }),
    events: (opts = {}) => get('api/events', pick(opts, ['limit'])),
    script: () => get('api/events/script'),
  };
}

export default connect;
