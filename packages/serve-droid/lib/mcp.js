import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { connect, ServeDroidError } from './client.js';

const protocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05'];

const installApk = {
  name: 'install_apk',
  title: 'Install APK',
  description: 'Install an APK file from this computer onto the emulator and launch it. Pass an absolute path.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to the .apk file on the machine running serve-droid mcp' } },
    required: ['path'],
  },
  annotations: { destructiveHint: false },
  local: true,
};

// Older servers (before tools.json) still have these endpoints.
const legacyTools = [
  ['get_ui_tree', 'Read the screen as a compact list of visible, actionable UI nodes with bounds and centers in screen pixels.', 'GET', 'api/ui-tree', {}, 'json', true],
  ['get_screen', 'Capture the current screen as a JPEG image.', 'GET', 'api/frame', { max_edge: { type: 'integer' } }, 'image', true],
  ['tap', 'Tap at screen pixel x,y. duration_ms makes it a long press.', 'POST', 'api/tap',
    { x: { type: 'number' }, y: { type: 'number' }, duration_ms: { type: 'integer' } }, 'json'],
  ['swipe', 'Swipe between two screen pixel points.', 'POST', 'api/swipe',
    { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, duration_ms: { type: 'integer' } }, 'json'],
  ['type_text', 'Type text into the focused field.', 'POST', 'api/text', { text: { type: 'string' } }, 'json'],
  ['press_key', 'Press a key: GoHome, GoBack, AppSwitch, Enter, Backspace, arrows or Power.', 'POST', 'api/key', { key: { type: 'string' } }, 'json'],
  ['rotate', 'Rotate the device.', 'POST', 'api/rotate', {}, 'json'],
  ['open_url', 'Open a URL or deep link on the device.', 'POST', 'api/open-url', { url: { type: 'string' } }, 'json'],
  ['read_logcat', 'Read recent logcat lines.', 'GET', 'api/logcat',
    { lines: { type: 'integer' }, level: { type: 'string' }, package: { type: 'string' }, text: { type: 'string' } }, 'json', true],
].map(([name, description, method, path, properties, result, readOnlyHint]) => ({
  name, description, http: { method, path }, result,
  inputSchema: { type: 'object', properties },
  ...(readOnlyHint ? { annotations: { readOnlyHint } } : {}),
}));

const log = message => process.stderr.write(`serve-droid mcp: ${message}\n`);

/**
 * Serve MCP over stdio (newline-delimited JSON-RPC). `resolve()` returns the serve-droid URL and is
 * called lazily, so the client can start before the emulator and pick it up once it runs.
 */
export function runMcp({ resolve, version, input = process.stdin, output = process.stdout }) {
  let droid;
  let tools;

  async function client() {
    if (!droid) {
      droid = connect(await resolve());
      log(`using ${droid.url}`);
    }
    return droid;
  }

  async function manifest() {
    if (tools) return tools;
    const api = await client();
    let list;
    try {
      list = await api.tools();
    } catch (error) {
      if (error.status !== 404) throw error;
      log('this server has no tools.json; using the basic tool set');
      list = legacyTools;
    }
    tools = [...list.filter(tool => tool.name !== installApk.name), installApk];
    return tools;
  }

  async function call(name, args = {}) {
    const tool = (await manifest()).find(entry => entry.name === name);
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
    const api = await client();
    if (tool.local) {
      if (typeof args.path !== 'string' || !args.path) throw new ServeDroidError('path is required');
      const result = await api.install(await readFile(args.path));
      return [{ type: 'text', text: JSON.stringify(result) }];
    }
    const { method, path } = tool.http;
    const data = method === 'GET'
      ? await api.request('GET', path.replace(/^\//, ''), { query: flatten(args) })
      : await api.request('POST', path.replace(/^\//, ''), { body: args, timeoutMs: 180_000 });
    if (tool.result === 'image' && data?.data) {
      const { data: image, mimeType, ...meta } = data;
      return [{ type: 'image', data: image, mimeType: mimeType ?? 'image/jpeg' }, { type: 'text', text: JSON.stringify(meta) }];
    }
    return [{ type: 'text', text: JSON.stringify(data) }];
  }

  async function handle(message) {
    const { method, params } = message;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return {
          protocolVersion: protocolVersions.includes(asked) ? asked : protocolVersions[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'serve-droid', title: 'serve-droid Android emulator', version },
          instructions: 'Control an Android emulator. Prefer find_elements / tap with text, id or desc over raw ' +
            'coordinates; coordinates are screen pixels as reported by get_ui_tree and get_screen.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: (await manifest()).map(tool => ({
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        };
      case 'tools/call':
        try {
          return { content: await call(params?.name, params?.arguments) };
        } catch (error) {
          if (error.code === -32602) throw error;
          // Tool failures are results the model can read, not protocol errors.
          if (error.status === 0) droid = undefined;
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  const send = message => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    for (const item of Array.isArray(message) ? message : [message]) {
      if (item.id === undefined || item.id === null) continue; // notifications need no reply
      const task = handle(item)
        .then(result => send({ id: item.id, result }))
        .catch(error => send({ id: item.id, error: { code: error.code ?? -32603, message: error.message } }))
        .finally(() => pending.delete(task));
      pending.add(task);
    }
  });
  return new Promise(resolveDone => lines.on('close', async () => {
    await Promise.allSettled([...pending]);
    resolveDone();
  }));
}

function flatten(args) {
  return Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) =>
    [key, typeof value === 'object' && value !== null ? JSON.stringify(value) : value]));
}
