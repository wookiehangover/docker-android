# Changelog

## Unreleased

### Features

- **Agent tools from one manifest.** `web-ui/tools.json` describes 28 tools; WebMCP and the new stdio MCP both build from it. New tools: `find_elements`, `tap` by text/id/description, `wait_for`, `scroll`, `pinch`, `list_apps`, `manage_app`, `snapshot`, `send_sms`, `phone_call`, `touch_fingerprint`, `set_network`, `set_accessibility`, `get_events`, `run_shell`, and GPS routes in `set_location`.
- **`serve-droid mcp`**: stdio MCP server for Claude Code, Cursor and Codex, with `install_apk` and `--start`.
- **CLI actions**: `screenshot`, `ui`, `find`, `tap`, `wait`, `swipe`, `type`, `key`, `open`, `apps`, `launch`, `app`, `snapshot`, `sms`, `call`, `geo`, `network`, `shell`, `events` and `replay`, with `--json`.
- **Event log and replay**: every API call and browser gesture is recorded, shown live in a new Events tab, and exported as a script that `serve-droid replay` plays back.
- **Node client and middleware**: `serve-droid/client` (typed) and `serve-droid/middleware` (mount the UI under your dev server).
- **Image updates**: `serve-droid start` rebuilds the emulator image when it is out of date for this serve-droid version and moves the existing emulator onto it, keeping its apps, data, port and token. `--image` skips this; `doctor` warns when the image is out of date.
- **`serve-droid doctor`**: checks Docker, KVM, the Android SDK, Python and more, and prints a fix for each problem (`--json` for scripts).
- **`serve-droid hub`**: every running emulator as a live tile on one page and one port, each proxied under `/d/<name>/`.
- **Optional token**: `serve-droid start --token` (or `WEB_UI_TOKEN`) requires a token for the page, API and WebSocket.
- **H.264 video** over WebCodecs, about 7× less bandwidth than JPEG on a scroll; JPEG stays as the fallback (`?codec=jpeg|h264`).
- **Input**: multi-touch, Alt-drag and trackpad pinch, mouse wheel scroll, long press, and Esc for Back.
- **Device panel**: Apps, Snapshots, Phone (SMS and calls), Network and Accessibility sections.
- **Lower CPU**: frames are encoded only while someone watches.
- Pull requests run CI: `node --check`, Python compile, `ruff` and a `tools.json` check.

### Fixes

- SMS and incoming calls work in the Docker image: the emulator's cellular radio now powers on. Images built before this release must be rebuilt, which `serve-droid start` now does by itself (see below).
- Rotate switches between portrait and landscape instead of stepping through 180°, which the images ignore and which left the device and video out of step.

### Other changes

- Removed the old upstream MCP server (`mcp/`, `docker/mcp/`) and its examples; `serve-droid mcp` replaces it.

### Known limits

- Locale changes need a rootable (Google APIs) image.

## 0.5.1 (2026-11-26)

### Other changes

- Renamed to serve-droid: new README focused on remote access and WebMCP, repository links, and the browser UI header ([#9](https://github.com/wookiehangover/serve-droid/pull/9))

### Fixes

- Show the full tag in the release summary ([0dd5fff](https://github.com/wookiehangover/serve-droid/commit/0dd5fffb993ca0e8e6f883d91f508dd2b83b9b98))

## 0.5.0 (2026-11-25)

### Features

- Native emulators on Windows ([#8](https://github.com/wookiehangover/docker-android/pull/8))

## 0.4.0 (2026-11-25)

### Features

- Explain how to fix a missing /dev/kvm ([#6](https://github.com/wookiehangover/docker-android/pull/6))
- Register WebMCP tools for in-browser agents ([#5](https://github.com/wookiehangover/docker-android/pull/5))
- Add ls, logs and rm commands ([#4](https://github.com/wookiehangover/docker-android/pull/4))

## 0.3.1 (2026-11-23)

### Features

- Native start and stop on macOS ([#3](https://github.com/wookiehangover/docker-android/pull/3))

## 0.3.0 (2026-11-19)

### Features

- Start native Android emulators with serve-droid on macOS ([#2](https://github.com/wookiehangover/docker-android/pull/2))

## 0.2.0 (2026-11-19)

### Features

- Add --host for browser UI binding ([cea096f](https://github.com/wookiehangover/docker-android/commit/cea096fc57dd3670f0e781207ba4868accb743f3))

## 0.1.0 (2026-11-19)

- First release ([#1](https://github.com/wookiehangover/docker-android/pull/1))
