// Every URL an emulator serves, and the block `start` and `ls` print in a terminal.

/** Preview, stream, video and WebSocket URLs for a browser URL (its ?token= carries over). */
export function endpoints(url) {
  const base = new URL(url);
  const token = base.searchParams.get('token');
  const at = (path, protocol = base.protocol) => {
    const out = new URL(path, base);
    out.protocol = protocol;
    out.search = token ? `?token=${encodeURIComponent(token)}` : '';
    return out.href;
  };
  const ws = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    preview: base.href,
    stream: at('stream.mjpeg'),
    video: at('stream.h264'),
    avcc: at('stream.avcc'),
    ws: at('ws', ws),
    input: `${at('ws', ws)}${token ? '&' : '?'}video=none`,
  };
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = text => paint('1', text);
const dim = text => paint('2', text);

/** The terminal block for one emulator. */
export function formatSession({ name, device, url }) {
  const lines = [`  ${paint('32', '▸')} ${bold(name)}${device ? `  ${dim(device.replace(/, /g, ' · '))}` : ''}`];
  if (!url) return [...lines, `    ${dim('Not reachable: its port is not published.')}`].join('\n');
  const e = endpoints(url);
  const rows = [
    ['Preview', e.preview],
    ['Stream', e.stream, 'MJPEG'],
    ['Video', e.video, 'H.264, ffplay -f h264'],
    ['WS', e.ws, 'JSON input; ?video=none for input only'],
    ['MCP', `npx serve-droid mcp --name ${name}`],
  ];
  for (const [label, value, note] of rows) lines.push(`    ${dim(label.padEnd(8))} ${value}${note ? `  ${dim(`(${note})`)}` : ''}`);
  return lines.join('\n');
}

export function formatStart(session, version) {
  return [`\n  ${bold('serve-droid')} ${dim(`v${version}`)}\n`, formatSession(session),
    `\n  ${dim(`Stop with: npx serve-droid stop${session.named ? ` --name ${session.name}` : ''}`)}\n`].join('\n');
}

/** JSON for --json: the session plus every URL. */
export function sessionJson({ name, device, url }) {
  return { name, device: device ?? null, ...(url ? endpoints(url) : {}) };
}
