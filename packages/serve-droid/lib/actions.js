import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from './client.js';

export const actionHelp = `Actions on the running emulator (pick it with --name or --url; add --json for JSON output):

  screenshot [FILE]          Save a PNG (default screenshot-<time>.png; - writes to stdout)
  ui                         List the visible, actionable UI nodes
  find [TEXT]                Find nodes by --text, --id, --desc or --class
  tap X Y | tap TEXT         Tap a point or an element (--text/--id/--desc, --duration MS for a long press)
  wait [TEXT]                Wait for an element (--timeout MS, --gone); exits 1 on timeout
  swipe X1 Y1 X2 Y2          Swipe between points, or swipe up|down|left|right (--duration MS)
  type TEXT                  Type into the focused field
  key KEY                    Press a key: home, back, recents, Enter, Tab, ArrowDown, Power, …
  open URL                   Open a URL or deep link
  apps                       List installed third-party apps (--all for every package)
  launch PACKAGE             Launch an app (also: app stop|clear|uninstall PACKAGE)
  snapshot ls|save|load|delete [NAME]
  sms NUMBER TEXT            Receive an SMS
  call NUMBER [ACTION]       Incoming call, or accept|end|hold|busy
  geo LAT LNG | geo --stop   Set the GPS location or stop a route
  network                    Show or change --speed, --delay, --airplane, --wifi, --data (on|off)
  shell COMMAND…             Run an adb shell command
  events [--export FILE]     Show recent events, or save them as a replay script
  replay FILE [--speed N]    Replay an exported script (N > 1 is faster)`;

export const actionOptions = {
  url: { type: 'string' }, json: { type: 'boolean' },
  text: { type: 'string' }, id: { type: 'string' }, desc: { type: 'string' }, class: { type: 'string' },
  exact: { type: 'boolean' }, index: { type: 'string' },
  duration: { type: 'string' }, timeout: { type: 'string' }, gone: { type: 'boolean' },
  all: { type: 'boolean' }, limit: { type: 'string' }, export: { type: 'string' }, speed: { type: 'string' },
  stop: { type: 'boolean' }, delay: { type: 'string' }, airplane: { type: 'string' }, wifi: { type: 'string' },
  data: { type: 'string' },
};

export const actionVerbs = new Set(['screenshot', 'ui', 'find', 'tap', 'wait', 'swipe', 'type', 'key', 'open', 'apps',
  'launch', 'app', 'snapshot', 'sms', 'call', 'geo', 'network', 'shell', 'events', 'replay']);

const usage = message => Object.assign(new Error(message), { usage: true });

function number(value, label) {
  const parsed = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(parsed)) throw usage(`${label} must be a number.`);
  return parsed;
}

function integer(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw usage(`--${label} must be a whole number.`);
  return Number(value);
}

function onOff(value, label) {
  if (value === undefined) return undefined;
  if (/^(on|true|1|yes)$/i.test(value)) return true;
  if (/^(off|false|0|no)$/i.test(value)) return false;
  throw usage(`--${label} must be on or off.`);
}

function selector(values, positional) {
  const sel = {};
  if (positional !== undefined) sel.text = positional;
  for (const key of ['text', 'id', 'desc', 'class']) if (values[key] !== undefined) sel[key] = values[key];
  if (values.exact) sel.exact = true;
  if (values.index !== undefined) sel.index = integer(values.index, 'index');
  if (!['text', 'id', 'desc', 'class'].some(key => sel[key] !== undefined)) {
    throw usage('Give the element as TEXT or with --text, --id, --desc or --class.');
  }
  return sel;
}

function describe(node) {
  const label = [node.text && JSON.stringify(node.text), node.description && node.description !== node.text && `desc=${JSON.stringify(node.description)}`,
    node.id && `#${node.id}`].filter(Boolean).join(' ');
  return `${String(node.center).padEnd(11)} ${node.class}${label ? ` ${label}` : ''}${node.flags?.length ? ` [${node.flags.join(',')}]` : ''}`;
}

// Replay only plain API actions; the script is data, so keep it from addressing other paths.
const replayable = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;

export async function replay(api, script, { speed = 1, log = () => {} } = {}) {
  const steps = Array.isArray(script) ? script : script?.steps;
  if (!Array.isArray(steps)) throw new Error('Expected a replay script with a steps array.');
  const started = Date.now();
  for (const [i, step] of steps.entries()) {
    const { t = 0, action, ...rest } = step;
    // Steps are {t, action, ...params}; bodies with their own `action` key (api/app) come nested as {params}.
    const nested = rest.params && typeof rest.params === 'object' && Object.keys(rest).length === 1;
    const params = nested ? rest.params : rest;
    if (typeof action !== 'string' || !replayable.test(action)) throw new Error(`Step ${i + 1}: invalid action ${JSON.stringify(action)}`);
    const wait = Number(t) / speed - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    log(`${String(i + 1).padStart(3)}  ${action} ${JSON.stringify(params)}`);
    await api.request('POST', `api/${action}`, { body: params, timeoutMs: 180_000 });
  }
  return { steps: steps.length, elapsed_ms: Date.now() - started };
}

/** Run one CLI action verb. Returns the exit code. */
export async function runAction(verb, args, values, url) {
  const api = connect(url);
  const json = values.json;
  const out = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const done = (result, text) => out(json ? result ?? {} : text ?? 'ok');
  const need = (count, shape) => {
    if (args.length < count) throw usage(`Usage: serve-droid ${verb} ${shape}`);
  };
  const duration = integer(values.duration, 'duration');

  switch (verb) {
    case 'screenshot': {
      const png = await api.screenshot();
      const file = args[0] ?? `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      if (file === '-') {
        process.stdout.write(png);
        return 0;
      }
      writeFileSync(file, png);
      return done({ path: file, bytes: png.length }, file), 0;
    }
    case 'ui': {
      const tree = await api.uiTree();
      return done(tree, [`${tree.screenWidth}x${tree.screenHeight}`, ...tree.nodes.map(describe)].join('\n')), 0;
    }
    case 'find': {
      const result = await api.find(selector(values, args.join(' ') || undefined));
      return done(result, result.matches.length ? result.matches.map(describe).join('\n') : 'No match.'), result.matches.length ? 0 : 1;
    }
    case 'tap': {
      let result;
      if (args.length === 2 && args.every(arg => /^-?\d+(\.\d+)?$/.test(arg))) {
        result = await api.tap(number(args[0], 'X'), number(args[1], 'Y'), { duration_ms: duration });
      } else {
        result = await api.tap({ ...selector(values, args.join(' ') || undefined), duration_ms: duration });
      }
      return done(result, `Tapped ${result.x},${result.y}${result.node ? ` (${describe(result.node).trim()})` : ''}`), 0;
    }
    case 'wait': {
      const result = await api.waitFor(selector(values, args.join(' ') || undefined),
        { timeout_ms: integer(values.timeout, 'timeout', 10_000), gone: values.gone || undefined });
      const text = result.found
        ? `${values.gone ? 'Gone' : 'Found'} after ${result.elapsed_ms} ms${result.node ? `: ${describe(result.node)}` : ''}`
        : `Timed out after ${result.elapsed_ms} ms`;
      return done(result, text), result.found ? 0 : 1;
    }
    case 'swipe': {
      if (args.length === 1) {
        const direction = args[0];
        if (!['up', 'down', 'left', 'right'].includes(direction)) throw usage('Swipe direction must be up, down, left or right.');
        const { screenWidth: w, screenHeight: h } = await api.uiTree().catch(() => api.deviceInfo());
        const [cx, cy] = [Math.round(w / 2), Math.round(h / 2)];
        const dx = Math.round(w * 0.3);
        const dy = Math.round(h * 0.3);
        // "up" moves the finger up, which scrolls content down.
        const delta = { up: [0, dy], down: [0, -dy], left: [dx, 0], right: [-dx, 0] }[direction];
        await api.swipe(cx + delta[0], cy + delta[1], cx - delta[0], cy - delta[1], duration);
        return done({}, 'ok'), 0;
      }
      need(4, 'X1 Y1 X2 Y2 | up|down|left|right');
      await api.swipe(...args.slice(0, 4).map((arg, i) => number(arg, ['X1', 'Y1', 'X2', 'Y2'][i])), duration);
      return done({}), 0;
    }
    case 'type':
      need(1, 'TEXT');
      return done(await api.type(args.join(' '))), 0;
    case 'key': {
      need(1, 'KEY');
      // The API takes W3C key names; offer the button names people type.
      const key = { home: 'GoHome', back: 'GoBack', recents: 'AppSwitch', esc: 'GoBack' }[args[0].toLowerCase()] ?? args[0];
      return done(await api.key(key)), 0;
    }
    case 'open': {
      need(1, 'URL');
      const result = await api.openUrl(args[0]);
      return done(result, `Opened ${result.url ?? args[0]}`), 0;
    }
    case 'apps': {
      const result = await api.apps({ all: values.all });
      return done(result, result.packages.join('\n') || 'No third-party apps.'), 0;
    }
    case 'launch':
      need(1, 'PACKAGE');
      return done(await api.launch(args[0])), 0;
    case 'app': {
      const [action, pkg] = args;
      if (!['launch', 'stop', 'clear', 'uninstall'].includes(action) || !pkg) throw usage('Usage: serve-droid app launch|stop|clear|uninstall PACKAGE');
      return done(await api.request('POST', 'api/app', { body: { action, package: pkg } })), 0;
    }
    case 'snapshot': {
      const [action, name] = args;
      if (action === 'ls' || action === 'list') {
        const result = await api.snapshot.list();
        const rows = result.snapshots.map(s => [s.name, s.size_bytes ? `${(s.size_bytes / 1048576).toFixed(0)} MB` : '',
          s.created ? new Date(typeof s.created === 'number' && s.created < 1e12 ? s.created * 1000 : s.created).toLocaleString() : ''].join('  ').trimEnd());
        return done(result, rows.join('\n') || 'No snapshots.'), 0;
      }
      if (!['save', 'load', 'delete'].includes(action) || !name) throw usage('Usage: serve-droid snapshot ls|save|load|delete NAME');
      return done(await api.snapshot[action](name), `${{ save: 'Saved', load: 'Loaded', delete: 'Deleted' }[action]} ${name}`), 0;
    }
    case 'sms':
      need(2, 'NUMBER TEXT');
      return done(await api.sms(args[0], args.slice(1).join(' '))), 0;
    case 'call':
      need(1, 'NUMBER [call|accept|end|hold|busy]');
      return done(await api.call(args[0], args[1] ?? 'call')), 0;
    case 'geo':
      if (values.stop) return done(await api.stopRoute()), 0;
      need(2, 'LAT LNG | --stop');
      return done(await api.geo(number(args[0], 'LAT'), number(args[1], 'LNG'))), 0;
    case 'network': {
      const body = Object.fromEntries(Object.entries({
        speed: args[0] ?? values.speed, delay: values.delay,
        airplane: onOff(values.airplane, 'airplane'), wifi: onOff(values.wifi, 'wifi'), data: onOff(values.data, 'data'),
      }).filter(([, value]) => value !== undefined));
      const result = await api.network(body);
      return done(result, Object.entries(result).map(([key, value]) => `${key}: ${value}`).join('\n')), 0;
    }
    case 'shell': {
      need(1, 'COMMAND');
      const result = await api.shell(args.join(' '), { timeout_ms: integer(values.timeout, 'timeout') });
      if (json) return out(result), result.exit_code ? 1 : 0;
      process.stdout.write(result.output);
      return result.exit_code ? Math.min(255, result.exit_code) : 0;
    }
    case 'events': {
      if (values.export) {
        const script = await api.script();
        writeFileSync(values.export, `${JSON.stringify(script, null, 2)}\n`);
        return done({ path: values.export, steps: script.steps.length }, `Saved ${script.steps.length} steps to ${values.export}`), 0;
      }
      const result = await api.events({ limit: integer(values.limit, 'limit') });
      const text = result.events.map(e => `${new Date(e.time).toLocaleTimeString()}  ${e.source.padEnd(3)}  ${e.ok ? 'ok ' : 'ERR'}  ` +
        `${e.action} ${JSON.stringify(e.params ?? {})}${e.error ? `  ${e.error}` : ''}`).join('\n');
      return done(result, text || 'No events.'), 0;
    }
    case 'replay': {
      need(1, 'FILE [--speed N]');
      const speed = values.speed === undefined ? 1 : number(values.speed, '--speed');
      if (speed <= 0) throw usage('--speed must be above 0.');
      const script = JSON.parse(readFileSync(args[0], 'utf8'));
      const result = await replay(api, script, { speed, log: json ? undefined : line => console.error(line) });
      return done(result, `Replayed ${result.steps} steps in ${(result.elapsed_ms / 1000).toFixed(1)} s`), 0;
    }
    default:
      throw usage(`Unknown action ${verb}.`);
  }
}
