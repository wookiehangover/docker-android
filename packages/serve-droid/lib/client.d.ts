/** Typed client for a running serve-droid browser UI (`import { connect } from 'serve-droid/client'`). */

export interface Selector {
  /** Matches node text or content description (case-insensitive substring unless `exact`). */
  text?: string;
  /** Full resource id or the part after `:id/`. */
  id?: string;
  desc?: string;
  class?: string;
  exact?: boolean;
  /** Pick the nth match (default 0). */
  index?: number;
}

export interface UiNode {
  class: string;
  bounds: [number, number, number, number];
  center: [number, number];
  text?: string;
  description?: string;
  id?: string;
  package?: string;
  flags?: string[];
}

export interface Image {
  mimeType: string;
  /** Base64 image data. */
  data: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}

export interface DroidEvent {
  id: number;
  time: number;
  source: 'api' | 'ui';
  action: string;
  params: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface Script {
  version: 1;
  device?: unknown;
  steps: Array<{ t: number; action: string; [param: string]: unknown }>;
}

export type NetworkSpeed = 'gsm' | 'edge' | 'umts' | 'lte' | 'full';
export type NetworkDelay = 'gprs' | 'edge' | 'umts' | 'none';

export interface NetworkState {
  airplane?: boolean;
  wifi?: boolean;
  data?: boolean;
  speed?: NetworkSpeed;
  delay?: NetworkDelay;
}

export interface Accessibility {
  font_scale?: number;
  density?: number | 'reset';
  locale?: string;
  talkback?: boolean;
}

export interface Tool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  http: { method: 'GET' | 'POST'; path: string };
  result: 'json' | 'image';
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Thrown for HTTP errors and `{ok:false}` responses. `status` is 0 when the server could not be reached. */
export declare class ServeDroidError extends Error {
  status: number;
  body: unknown;
}

export interface ConnectOptions {
  /** Overrides the URL's `?token=`. */
  token?: string;
  /** Per-request timeout (default 120000 ms). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type Ok = Record<string, never>;

export interface Client {
  /** Base URL without the token. */
  url: string;
  token?: string;
  /** JSON request to any endpoint (path relative to the base URL). */
  request<T = any>(method: 'GET' | 'POST', path: string, options?: { query?: Record<string, unknown>; body?: unknown; timeoutMs?: number }): Promise<T>;
  raw(method: string, path: string, options?: { query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; timeoutMs?: number }): Promise<Response>;

  info(): Promise<{ label: string; width: number; height: number; [key: string]: unknown }>;
  deviceInfo(): Promise<{ label: string; model: string; android: string; api: number; screenWidth: number; screenHeight: number; density: number; foreground: string | null; battery: unknown; location: unknown; dark: boolean; clipboard: string; emulator: unknown }>;
  state(): Promise<{ dark: boolean | null; battery: unknown; location: unknown; clipboard: string }>;
  foreground(): Promise<{ package: string | null; pids: number[] }>;
  tools(): Promise<Tool[]>;

  find(selector: Selector): Promise<{ matches: UiNode[]; total: number; screenWidth: number; screenHeight: number }>;
  tap(x: number, y: number, options?: { duration_ms?: number }): Promise<{ x: number; y: number; node?: UiNode }>;
  tap(target: Selector & { x?: number; y?: number; duration_ms?: number }): Promise<{ x: number; y: number; node?: UiNode }>;
  longPress(x: number, y: number, durationMs?: number): Promise<{ x: number; y: number }>;
  /** Resolves `{found:false}` on timeout instead of throwing. */
  waitFor(selector: Selector, options?: { timeout_ms?: number; interval_ms?: number; gone?: boolean }): Promise<{ found: boolean; node?: UiNode; elapsed_ms: number; attempts: number }>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<Ok>;
  swipe(body: { x1: number; y1: number; x2: number; y2: number; duration_ms?: number }): Promise<Ok>;
  /** +dy scrolls content down, like a mouse wheel. */
  scroll(options: { x?: number; y?: number; dx?: number; dy?: number }): Promise<Ok>;
  /** scale 0.2–5; below 1 zooms out. */
  pinch(options: { x: number; y: number; scale: number; duration_ms?: number }): Promise<Ok>;
  type(text: string): Promise<Ok>;
  /** W3C key name: GoHome, GoBack, AppSwitch, Enter, Backspace, ArrowDown, Power, … */
  key(key: string): Promise<Ok>;
  rotate(): Promise<Ok>;
  openUrl(url: string): Promise<{ url: string }>;
  setClipboard(text: string): Promise<Ok>;
  setAppearance(dark: boolean): Promise<Ok>;
  setBattery(level: number, charging?: boolean): Promise<Ok>;

  /** Full-resolution PNG. */
  screenshot(): Promise<Buffer>;
  /** Current JPEG frame scaled to `maxEdge` (default 768). */
  frame(options?: { maxEdge?: number }): Promise<Image>;
  uiTree(): Promise<{ screenWidth: number; screenHeight: number; nodes: UiNode[] }>;
  logcat(options?: { lines?: number; level?: string; package?: string; text?: string }): Promise<{ lines: Array<{ time: string; pid: number; level: string; tag: string; message: string }> }>;

  apps(options?: { all?: boolean }): Promise<{ packages: string[] }>;
  launch(pkg: string): Promise<Ok>;
  stop(pkg: string): Promise<Ok>;
  clearData(pkg: string): Promise<Ok>;
  uninstall(pkg: string): Promise<Ok>;
  /** Install an APK from a path or bytes; launches it when the package name is known. */
  install(apk: string | Uint8Array): Promise<{ package: string | null }>;
  snapshot: {
    list(): Promise<{ snapshots: Array<{ name: string; size_bytes?: number; created?: number | string }> }>;
    save(name: string): Promise<Ok>;
    load(name: string): Promise<Ok>;
    delete(name: string): Promise<Ok>;
  };

  sms(number: string, text: string): Promise<Ok>;
  call(number: string, action?: 'call' | 'accept' | 'end' | 'hold' | 'busy'): Promise<Ok>;
  fingerprint(id?: number): Promise<Ok>;
  /** Empty options read the current state. */
  network(options?: NetworkState): Promise<NetworkState>;
  geo(lat: number, lng: number): Promise<Ok>;
  route(points: Array<[number, number]>, options?: { interval_ms?: number; loop?: boolean }): Promise<Ok>;
  stopRoute(): Promise<Ok>;
  /** Empty options read the current values. */
  accessibility(options?: Accessibility): Promise<Accessibility>;
  shell(command: string, options?: { timeout_ms?: number }): Promise<{ output: string; exit_code: number }>;
  events(options?: { limit?: number }): Promise<{ events: DroidEvent[] }>;
  script(): Promise<Script>;
}

/** Split a serve-droid URL into its base and `?token=`. */
export declare function parseUrl(url: string): { base: string; token?: string };
export declare function connect(url: string, options?: ConnectOptions): Client;
export default connect;
