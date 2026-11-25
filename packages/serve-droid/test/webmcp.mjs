// E2E check of the browser UI's WebMCP tools against a running emulator.
// Usage: node test/webmcp.mjs http://127.0.0.1:6090/   (ARTIFACT_DIR picks the output directory)
// A stand-in document.modelContext records registrations and runs tools the way the WebMCP draft does:
// execute(input, { signal }), result serialized with JSON.stringify.
import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const url = process.argv[2] || "http://127.0.0.1:6090/";
const artifact = resolve(process.env.ARTIFACT_DIR || mkdtempSync(join(tmpdir(), "webmcp-")));
mkdirSync(artifact, { recursive: true });
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(() => {
  const tools = new Map();
  let ready = Promise.resolve();
  const mc = {
    async registerTool(tool) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || tools.has(tool.name)) throw new DOMException(tool.name, "InvalidStateError");
      if (!tool.description || typeof tool.execute !== "function") throw new TypeError(tool.name);
      tools.set(tool.name, tool);
    },
    waitForToolsUntil(p) { ready = Promise.all([ready, p]); },
  };
  Object.defineProperty(Document.prototype, "modelContext", { get: () => mc, configurable: true });
  window.__webmcp = {
    ready: () => ready,
    list: () => [...tools.values()].map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
    async run(name, input) {
      try {
        return { ok: true, json: JSON.stringify(await tools.get(name).execute(input, { signal: new AbortController().signal })) };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
  };
});

async function run(name, input = {}) {
  const t = Date.now();
  const r = await page.evaluate(([n, i]) => window.__webmcp.run(n, i), [name, input]);
  const out = r.ok ? JSON.parse(r.json) : null;
  const shown = out && out.data ? { ...out, data: `<${out.data.length} base64 chars>` } : out;
  log.push({ tool: name, input, ms: Date.now() - t, ...(r.ok ? { result: shown } : { error: r.error }) });
  console.error(`${r.ok ? "ok  " : "err "} ${name} ${JSON.stringify(input)} ${Date.now() - t}ms`);
  return r.ok ? out : Object.assign(new Error(r.error), { failed: true });
}
const must = async (name, input) => {
  const r = await run(name, input);
  if (r instanceof Error) throw r;
  return r;
};

let rotations = 0;
const findNode = (tree, re) => tree.nodes.find((n) => re.test(n.text || "") || re.test(n.description || ""));

try {
  await page.goto(url);
  await page.waitForSelector("#state.live", { timeout: 120000 });
  await page.evaluate(() => window.__webmcp.ready());

  const tools = await page.evaluate(() => window.__webmcp.list());
  writeFileSync(join(artifact, "tools.json"), JSON.stringify(tools, null, 2));
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_device_info", "get_screen", "get_ui_tree", "open_url", "press_key",
    "read_logcat", "rotate", "set_appearance", "set_battery", "set_clipboard", "set_location", "swipe", "tap", "type_text"]);
  for (const t of tools) assert.equal(t.inputSchema?.type, "object", t.name);

  let info = await must("get_device_info");
  for (let i = 0; i < 3 && info.screenWidth > info.screenHeight; i++) {
    await must("rotate");
    await sleep(2500);
    info = await must("get_device_info");
  }
  assert.ok(info.screenWidth > 0 && info.screenHeight > info.screenWidth, "portrait screen size");
  const { screenWidth: w, screenHeight: h } = info;

  await must("press_key", { key: "GoHome" });
  await sleep(1500);
  await must("swipe", { x1: w / 2, y1: h * 0.8, x2: w / 2, y2: h * 0.25, duration_ms: 300 });
  await sleep(1500);
  let tree = await must("get_ui_tree");
  assert.equal(tree.screenWidth, w);
  let settings = findNode(tree, /^Settings$/);
  for (let i = 0; !settings && i < 4; i++) {
    await must("swipe", { x1: w / 2, y1: h * 0.75, x2: w / 2, y2: h * 0.35 });
    await sleep(800);
    tree = await must("get_ui_tree");
    settings = findNode(tree, /^Settings$/);
  }
  assert.ok(settings, "Settings icon in the app drawer");
  await must("tap", { x: settings.center[0], y: settings.center[1] });
  let fg;
  for (let i = 0; i < 10 && fg !== "com.android.settings"; i++) {
    await sleep(700);
    fg = (await must("get_device_info")).foregroundPackage;
  }
  assert.equal(fg, "com.android.settings", "tap opened Settings");
  await page.screenshot({ path: join(artifact, "page-settings.png") });

  const shot = await must("get_screen", { max_edge: 640 });
  assert.equal(shot.mimeType, "image/jpeg");
  assert.ok(Math.max(shot.width, shot.height) <= 640 && shot.screenWidth === w);
  writeFileSync(join(artifact, "get_screen.jpg"), Buffer.from(shot.data, "base64"));

  const logs = await must("read_logcat", { lines: 20, package: "com.android.settings" });
  assert.ok(logs.lines.length <= 20 && logs.lines.every((l) => typeof l.message === "string"));
  const errors = await must("read_logcat", { lines: 50, level: "E" });
  assert.ok(errors.lines.every((l) => "EFA".includes(l.level)));

  const marker = `webmcp-${Date.now()}`;
  await must("set_clipboard", { text: marker });
  assert.equal((await must("get_device_info")).clipboard, marker);

  await must("set_appearance", { dark: true });
  assert.equal((await must("get_device_info")).dark, true);
  await must("set_appearance", { dark: false });

  const off = await run("tap", { x: w + 10, y: 10 });
  assert.ok(off.failed && /outside/.test(off.message), "tap outside the screen is rejected");
  const badLevel = await run("read_logcat", { level: "Q" });
  assert.ok(badLevel.failed, "bad logcat level is rejected");

  await must("press_key", { key: "GoHome" });
  await sleep(1000);
  await page.screenshot({ path: join(artifact, "page-home.png") });

  // Rotated frame with an upright launcher: tree coordinates must still land taps on the right icon.
  await must("rotate");
  rotations = 1;
  await sleep(2500);
  tree = await must("get_ui_tree");
  assert.ok(tree.screenWidth === h && tree.screenHeight === w, "landscape screen size after rotate");
  assert.ok(tree.nodes.every((n) => n.center[0] < h && n.center[1] < w), "nodes inside the landscape screen");
  const rotated = await must("get_screen", { max_edge: 640 });
  assert.ok(rotated.width > rotated.height);
  writeFileSync(join(artifact, "get_screen-rotated.jpg"), Buffer.from(rotated.data, "base64"));
  const icon = findNode(tree, /^(Chrome|Messages|Phone|Gmail|Camera)$/);
  assert.ok(icon, "a launcher icon in the rotated tree");
  await must("tap", { x: icon.center[0], y: icon.center[1] });
  fg = null;
  for (let i = 0; i < 10 && (!fg || /launcher/.test(fg)); i++) {
    await sleep(700);
    fg = (await must("get_device_info")).foregroundPackage;
  }
  assert.ok(fg && !/launcher/.test(fg), `rotated tap on ${icon.description || icon.text} opened an app`);
  await page.screenshot({ path: join(artifact, "page-rotated.png") });
  console.error("WebMCP E2E passed");
} finally {
  for (; rotations > 0 && rotations < 4; rotations++) { await run("rotate"); await sleep(2000); }
  await run("press_key", { key: "GoHome" });
  writeFileSync(join(artifact, "calls.json"), JSON.stringify(log, null, 2));
  console.log(artifact);
  await browser.close();
}
