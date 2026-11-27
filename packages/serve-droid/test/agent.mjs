// E2E check of the Node clients against a running emulator: token auth, the SDK, CLI action verbs,
// replay, `serve-droid mcp` over stdio and (with --name) the hub.
// Usage: node test/agent.mjs URL [--name NAME]   (URL may carry ?token=; ARTIFACT_DIR picks the output directory)
// Start the emulator with `serve-droid start --token` to cover token auth.
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { connect, parseUrl, ServeDroidError } from '../lib/client.js';

const args = process.argv.slice(2);
const nameAt = args.indexOf('--name');
const name = nameAt >= 0 ? args.splice(nameAt, 2)[1] : undefined;
const url = args[0] || 'http://127.0.0.1:6090/';
const cli = join(dirname(fileURLToPath(import.meta.url)), '../bin/serve-droid.js');
const artifact = resolve(process.env.ARTIFACT_DIR || mkdtempSync(join(tmpdir(), 'agent-')));
mkdirSync(artifact, { recursive: true });
const log = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { base, token } = parseUrl(url);
const api = connect(url);
let section = 'setup';

function note(entry) {
  log.push({ section, time: new Date().toISOString(), ...entry });
}

async function step(label, fn) {
  const t = Date.now();
  try {
    const result = await fn();
    note({ step: label, ms: Date.now() - t, ok: true, result: shorten(result) });
    console.error(`ok   ${section}: ${label} ${Date.now() - t}ms`);
    return result;
  } catch (error) {
    note({ step: label, ms: Date.now() - t, ok: false, error: String(error.stack || error) });
    console.error(`FAIL ${section}: ${label}: ${error.message}`);
    throw error;
  }
}

function shorten(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  return JSON.parse(JSON.stringify(value, (k, v) => (k === 'data' && typeof v === 'string' && v.length > 200 ? `<${v.length} base64 chars>` : v)));
}

/** Run a CLI verb against the emulator. Resolves {code, stdout, stderr}. */
function sd(verb, ...rest) {
  return new Promise(done => {
    execFile(process.execPath, [cli, verb, ...rest, '--url', url], { maxBuffer: 64 << 20, timeout: 240_000 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}
async function sdOk(verb, ...rest) {
  const r = await sd(verb, ...rest);
  if (r.code !== 0) throw new Error(`serve-droid ${verb} ${rest.join(' ')} exited ${r.code}: ${r.stderr.trim()}`);
  return r;
}
const sdJson = async (verb, ...rest) => JSON.parse((await sdOk(verb, ...rest, '--json')).stdout);

async function foreground(pkg, tries = 12) {
  let fg;
  for (let i = 0; i < tries && fg !== pkg; i++) {
    fg = (await api.foreground()).package;
    if (fg !== pkg) await sleep(700);
  }
  return fg;
}

async function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }).on('error', fail);
  });
}

let mcp;
let hub;
try {
  // ── Token auth (spec 6.6) ──────────────────────────────────────────────
  section = 'token';
  if (token) {
    await step('no token → 401 on page, API and tools.json', async () => {
      for (const path of ['', 'api/device-info', 'tools.json']) {
        const r = await fetch(new URL(path, base), { redirect: 'manual' });
        assert.equal(r.status, 401, `${path || '/'} without a token`);
      }
      return 'ok';
    });
    await step('bearer header → 200', async () => {
      const r = await fetch(new URL('api/device-info', base), { headers: { authorization: `Bearer ${token}` } });
      assert.equal(r.status, 200);
      return (await r.json()).label;
    });
    await step('?token= sets an HttpOnly SameSite=Strict cookie and redirects', async () => {
      const r = await fetch(new URL(`?token=${encodeURIComponent(token)}`, base), { redirect: 'manual' });
      assert.equal(r.status, 302);
      const cookie = r.headers.get('set-cookie') || '';
      assert.match(cookie, /serve_droid_token=/);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Strict/i);
      const page = await fetch(base, { headers: { cookie: cookie.split(';')[0] } });
      assert.equal(page.status, 200);
      return cookie.replace(/=[^;]+/, '=<redacted>');
    });
    await step('wrong token → 401', async () => {
      const r = await fetch(new URL('api/device-info', base), { headers: { authorization: 'Bearer nope' } });
      assert.equal(r.status, 401);
      return 'ok';
    });
    await step('cross-site POST is still refused', async () => {
      const r = await fetch(new URL('api/key', base), {
        method: 'POST', body: '{"key":"GoHome"}',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://evil.example' },
      });
      assert.equal(r.status, 403);
      return 'ok';
    });
  } else {
    note({ step: 'skipped: URL has no ?token=' });
    console.error('skip token: URL has no ?token= (start with --token to cover it)');
  }

  // ── SDK (serve-droid/client) ───────────────────────────────────────────
  section = 'sdk';
  const info = await step('deviceInfo', () => api.deviceInfo());
  assert.ok(info.screenWidth > 0 && info.screenHeight > 0);
  if (info.screenWidth > info.screenHeight) { await api.rotate(); await sleep(2500); }
  const { screenWidth: w, screenHeight: h } = await api.deviceInfo();
  assert.ok(h > w, 'portrait');
  const manifest = await step('tools', () => api.tools());
  assert.ok(manifest.length >= 28, `${manifest.length} tools`);
  await step('key GoHome', () => api.key('GoHome'));
  await sleep(1000);
  await step('launch + waitFor Settings', async () => {
    await api.stop('com.android.settings');
    await api.launch('com.android.settings');
    const r = await api.waitFor({ text: 'Network' }, { timeout_ms: 15000 });
    assert.equal(r.found, true);
    return r;
  });
  await step('find', async () => {
    const r = await api.find({ text: 'Network' });
    assert.ok(r.total >= 1 && r.matches[0].center);
    return { total: r.total };
  });
  await step('waitFor timeout resolves found:false', async () => {
    const r = await api.waitFor({ text: `nothing-${Date.now()}` }, { timeout_ms: 1000 });
    assert.equal(r.found, false);
    return r;
  });
  await step('scroll down and back', async () => {
    await api.scroll({ x: w / 2, y: h / 2, dy: h / 3 });
    await api.scroll({ x: w / 2, y: h / 2, dy: -h / 3 });
  });
  await step('frame (JPEG)', async () => {
    const f = await api.frame({ maxEdge: 640 });
    assert.equal(f.mimeType, 'image/jpeg');
    writeFileSync(join(artifact, 'sdk-frame.jpg'), Buffer.from(f.data, 'base64'));
    return f;
  });
  await step('screenshot (PNG)', async () => {
    const png = await api.screenshot();
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    writeFileSync(join(artifact, 'sdk-settings.png'), png);
    return png;
  });
  await step('uiTree', async () => {
    const t = await api.uiTree();
    assert.equal(t.screenWidth, w);
    return { nodes: t.nodes.length };
  });
  await step('shell', async () => {
    const r = await api.shell('getprop ro.build.version.sdk');
    assert.equal(r.exit_code, 0);
    assert.match(r.output.trim(), /^\d+$/);
    return r;
  });
  await step('network read', () => api.network());
  await step('accessibility read', () => api.accessibility());
  await step('apps', async () => {
    const all = await api.apps({ all: true });
    assert.ok(all.packages.includes('com.android.settings'));
    return { count: all.packages.length };
  });
  await step('fingerprint', () => api.fingerprint());
  await step('geo + route + stopRoute', async () => {
    await api.geo(48.8584, 2.2945);
    await api.route([[48.8584, 2.2945], [48.8606, 2.3376]], { interval_ms: 500 });
    await sleep(1200);
    await api.stopRoute();
  });
  await step('404 throws ServeDroidError', async () => {
    await assert.rejects(api.tap({ text: `nothing-${Date.now()}` }), e => e instanceof ServeDroidError && e.status === 404);
  });
  const smsText = `hello from serve-droid ${Date.now()}`;
  await step('sms arrives in the inbox', async () => {
    await api.sms('5551234', smsText);
    let r;
    for (let i = 0; i < 20; i++) {
      r = await api.shell('content query --uri content://sms/inbox --projection address:body');
      if (r.output.includes(smsText)) break;
      await sleep(1000);
    }
    assert.ok(r.output.includes(smsText), 'SMS in content://sms/inbox');
    await sleep(1500);
    writeFileSync(join(artifact, 'sdk-sms.png'), await api.screenshot());
    return r.output.trim().split('\n').filter(l => l.includes(smsText));
  });
  await step('incoming call rings, then ends', async () => {
    await api.call('5551234');
    let state;
    for (let i = 0; i < 15 && !/RINGING|mCallState=1/.test(state); i++) {
      await sleep(700);
      state = (await api.shell('dumpsys telephony.registry | grep -m1 mCallState')).output;
    }
    assert.match(state, /mCallState=1/, 'call state is ringing');
    writeFileSync(join(artifact, 'sdk-incoming-call.png'), await api.screenshot());
    await api.call('5551234', 'end');
    return state.trim();
  });

  // ── Snapshots: save → change → load restores ──────────────────────────
  section = 'snapshot';
  const snap = `agent-e2e-${Date.now()}`;
  await step('cli snapshot save', () => sdOk('snapshot', 'save', snap));
  await step('cli snapshot ls', async () => {
    const r = await sdJson('snapshot', 'ls');
    assert.ok(r.snapshots.some(s => s.name === snap));
    return r;
  });
  await step('change font scale', async () => {
    const r = await api.accessibility({ font_scale: 1.3 });
    assert.equal(r.font_scale, 1.3);
    return r;
  });
  await step('cli snapshot load restores font scale', async () => {
    await sdOk('snapshot', 'load', snap);
    const r = await api.accessibility();
    assert.equal(r.font_scale, 1);
    return r;
  });
  await step('cli snapshot delete', async () => {
    await sdOk('snapshot', 'delete', snap);
    const r = await sdJson('snapshot', 'ls');
    assert.ok(!r.snapshots.some(s => s.name === snap));
  });

  // ── CLI verbs ──────────────────────────────────────────────────────────
  section = 'cli';
  await step('key home', () => sdOk('key', 'home'));
  await sleep(1000);
  await step('screenshot FILE', async () => {
    const file = join(artifact, 'cli-home.png');
    await sdOk('screenshot', file);
    assert.ok(statSync(file).size > 10_000);
    return file;
  });
  await step('ui --json', async () => {
    const r = await sdJson('ui');
    assert.ok(Array.isArray(r.nodes) && r.nodes.length > 0);
    return { nodes: r.nodes.length };
  });
  await step('swipe up (app drawer) + find Settings', async () => {
    await sdOk('swipe', 'up');
    await sleep(1500);
    const r = await sdJson('find', '--text', 'Settings', '--exact');
    assert.ok(r.total >= 1);
    return { total: r.total };
  });
  await step('tap TEXT', () => sdOk('tap', '--text', 'Settings', '--exact'));
  await step('wait TEXT', () => sdOk('wait', 'Network', '--timeout', '15000'));
  assert.equal(await foreground('com.android.settings'), 'com.android.settings', 'tap opened Settings');
  await step('wait exits 1 on timeout', async () => {
    const r = await sd('wait', `nothing-${Date.now()}`, '--timeout', '1000');
    assert.equal(r.code, 1);
    return r.code;
  });
  await step('tap X Y', async () => {
    await sdOk('tap', String(Math.round(w / 2)), String(Math.round(h / 2)));
    await sdOk('key', 'back');
  });
  await step('open URL', () => sdOk('open', 'https://example.com/'));
  await sleep(2000);
  await step('type', () => sdOk('type', 'serve droid'));
  await step('key back', () => sdOk('key', 'back'));
  await step('apps --all', async () => {
    const r = await sdJson('apps', '--all');
    assert.ok(r.packages.includes('com.android.chrome') || r.packages.length > 10);
    return { count: r.packages.length };
  });
  await step('launch + app stop', async () => {
    await sdOk('launch', 'com.android.settings');
    assert.equal(await foreground('com.android.settings'), 'com.android.settings');
    await sdOk('app', 'stop', 'com.android.settings');
  });
  await step('geo LAT LNG (negative)', () => sdOk('geo', '37.422', '-122.084'));
  await step('network set + read', async () => {
    const r = await sdJson('network', '--speed', 'edge', '--delay', 'gprs');
    assert.equal(r.speed, 'edge');
    const back = await sdJson('network', '--speed', 'full', '--delay', 'none');
    assert.equal(back.speed, 'full');
    return back;
  });
  await step('shell', async () => {
    const r = await sdOk('shell', 'echo', 'cli-ok');
    assert.equal(r.stdout.trim(), 'cli-ok');
  });
  await step('sms + call verbs', async () => {
    await sdOk('sms', '5551234', 'cli hello');
    await sdOk('call', '5551234');
    await sleep(2000);
    await sdOk('call', '5551234', 'end');
  });
  await step('events', async () => {
    const r = await sdJson('events', '--limit', '50');
    assert.ok(r.events.some(e => e.action === 'tap' && e.source === 'api'));
    return { count: r.events.length };
  });

  // ── Replay: record a flow, export it, replay it ────────────────────────
  section = 'replay';
  await sdOk('key', 'home');
  await sleep(800);
  const before = (await api.events({ limit: 1 })).events.at(-1)?.id ?? 0;
  await step('record: stop, launch Settings, tap Display', async () => {
    await sdOk('app', 'stop', 'com.android.settings');
    await sdOk('launch', 'com.android.settings');
    await sdOk('wait', 'Display', '--timeout', '15000');
    await sdOk('tap', '--text', 'Display');
    await sleep(1500);
  });
  writeFileSync(join(artifact, 'replay-recorded.png'), await api.screenshot());
  const recorded = (await api.events({ limit: 1000 })).events.filter(e => e.id > before && e.source === 'api');
  const file = join(artifact, 'events-script.json');
  await step('events --export', async () => {
    await sdOk('events', '--export', file);
    const script = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(script.version, 1);
    assert.ok(script.steps.some(s => s.action === 'app' && s.params?.action === 'launch'), 'app steps nest their body under params');
    // Keep only this flow, re-based to t=0.
    const flow = script.steps.slice(-recorded.length);
    const t0 = flow[0].t;
    script.steps = flow.map(s => ({ ...s, t: s.t - t0 }));
    writeFileSync(join(artifact, 'replay-flow.json'), JSON.stringify(script, null, 2));
    return { steps: script.steps.map(s => s.action) };
  });
  await sdOk('key', 'home');
  await sleep(1000);
  await step('replay FILE --speed 2', () => sdOk('replay', join(artifact, 'replay-flow.json'), '--speed', '2'));
  await sleep(1500);
  await step('replay landed on the Display screen', async () => {
    assert.equal(await foreground('com.android.settings'), 'com.android.settings');
    const r = await api.waitFor({ text: 'Dark theme' }, { timeout_ms: 8000 });
    assert.equal(r.found, true);
    writeFileSync(join(artifact, 'replay-replayed.png'), await api.screenshot());
    return r;
  });

  // ── serve-droid mcp over stdio ─────────────────────────────────────────
  section = 'mcp';
  mcp = spawn(process.execPath, [cli, 'mcp', '--url', url], { stdio: ['pipe', 'pipe', 'pipe'] });
  const mcpErr = [];
  mcp.stderr.on('data', d => mcpErr.push(String(d)));
  const pending = new Map();
  let buf = '';
  mcp.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  const rpc = (method, params, timeout = 120_000) => new Promise((ok, fail) => {
    const id = nextId++;
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), timeout);
    pending.set(id, msg => { clearTimeout(timer); ok(msg); });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (toolName, input = {}) => {
    const msg = await rpc('tools/call', { name: toolName, arguments: input });
    if (msg.error) throw new Error(`${toolName}: ${msg.error.message}`);
    return msg.result;
  };
  await step('initialize', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-e2e', version: '1' } });
    assert.equal(r.result.protocolVersion, '2025-06-18');
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return r.result;
  });
  await step('tools/list = tools.json + install_apk', async () => {
    const r = await rpc('tools/list', {});
    const names = r.result.tools.map(t => t.name);
    for (const t of manifest) assert.ok(names.includes(t.name), t.name);
    assert.ok(names.includes('install_apk'));
    writeFileSync(join(artifact, 'mcp-tools.json'), JSON.stringify(r.result.tools, null, 2));
    return { count: names.length };
  });
  await step('press_key + tap by text', async () => {
    await call('press_key', { key: 'GoHome' });
    await call('manage_app', { action: 'stop', package: 'com.android.settings' });
    await call('manage_app', { action: 'launch', package: 'com.android.settings' });
    const seen = await call('wait_for', { text: 'Network', timeout_ms: 15000 });
    assert.equal(JSON.parse(seen.content[0].text).found, true, 'wait_for over MCP');
    const r = await call('tap', { text: 'Network' });
    assert.ok(!r.isError, JSON.stringify(r));
    return r;
  });
  await step('get_screen returns image content', async () => {
    await sleep(1500);
    const r = await call('get_screen', { max_edge: 768 });
    const img = r.content.find(c => c.type === 'image');
    assert.ok(img && img.mimeType === 'image/jpeg');
    writeFileSync(join(artifact, 'mcp-get_screen.jpg'), Buffer.from(img.data, 'base64'));
    return r;
  });
  await step('get_device_info + get_events', async () => {
    const d = await call('get_device_info');
    assert.ok(!d.isError && JSON.parse(d.content[0].text).screenWidth);
    const e = await call('get_events', { limit: 5 });
    assert.ok(!e.isError);
    return JSON.parse(d.content[0].text).foreground;
  });
  await step('tool error comes back as isError', async () => {
    const r = await call('tap', { text: `nothing-${Date.now()}` });
    assert.equal(r.isError, true);
    return r;
  });
  await step('unknown method → -32601', async () => {
    const r = await rpc('no/such', {});
    assert.equal(r.error?.code, -32601);
    return r.error;
  });
  mcp.stdin.end();
  mcp.kill();
  writeFileSync(join(artifact, 'mcp-stderr.log'), mcpErr.join(''));
  mcp = undefined;

  // ── Hub (needs --name so the hub can find this emulator) ───────────────
  section = 'hub';
  if (name) {
    const port = await freePort();
    hub = spawn(process.execPath, [cli, 'hub', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const hubOut = [];
    hub.stdout.on('data', d => hubOut.push(String(d)));
    hub.stderr.on('data', d => hubOut.push(String(d)));
    const hubUrl = `http://127.0.0.1:${port}/`;
    await step('hub lists this emulator', async () => {
      let sessions;
      for (let i = 0; i < 40; i++) {
        try { sessions = await (await fetch(new URL('api/sessions', hubUrl))).json(); break; } catch { await sleep(250); }
      }
      const list = sessions?.sessions ?? sessions;
      assert.ok(Array.isArray(list) && list.some(s => s.name === name), JSON.stringify(sessions));
      assert.ok(!JSON.stringify(sessions).includes(token || '\0'), 'hub never leaks the emulator token');
      return list;
    });
    await step('hub proxies /d/NAME/ with the emulator token added', async () => {
      const r = await fetch(new URL(`d/${name}/api/device-info`, hubUrl));
      assert.equal(r.status, 200);
      const page = await fetch(new URL(`d/${name}/`, hubUrl));
      assert.equal(page.status, 200);
      return (await r.json()).label;
    });
    writeFileSync(join(artifact, 'hub.log'), hubOut.join(''));
  } else {
    note({ step: 'skipped: pass --name to cover the hub' });
  }

  await api.key('GoHome');
  console.error('Agent E2E passed');
} finally {
  mcp?.kill();
  hub?.kill();
  writeFileSync(join(artifact, 'log.json'), JSON.stringify(log, null, 2));
  console.log(artifact);
}
