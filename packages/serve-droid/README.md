# serve-droid

Start an Android emulator for the current project and print its browser URL.
Requires Node.js 22+. On macOS and Windows, start, reuse and stop a native emulator.
Container startup requires a local Linux Docker engine with access to `/dev/kvm`
and an x86-64 host. Run from any project directory.

```sh
npx serve-droid
npx serve-droid --apk ./app-debug.apk
npx serve-droid --name tablet --device "Pixel C" --port 6081
npx serve-droid stop --name tablet
npx serve-droid ls
npx serve-droid doctor                  # check Docker, KVM, SDK and Python, with fixes
npx serve-droid logs -f
npx serve-droid rm --name tablet
npx serve-droid --token                 # require a token; the URL carries it
npx serve-droid mcp --start             # stdio MCP for Claude Code, Cursor, Codex
npx serve-droid hub                     # every running emulator on one page
npx serve-droid tap --text Settings     # drive the running emulator
```

The default is a headless Samsung Galaxy S10 running Android 16. Docker picks
a free loopback port. Progress goes to stderr. Once Android and the browser UI
are ready, a terminal shows every URL (preview, MJPEG stream, H.264 video,
WebSocket and the MCP command). When stdout is not a terminal it is only the
preview URL, and `--json` prints them all as JSON. Open the preview in a
browser on the Docker host.

To open the UI from another device, bind to the Docker host's LAN address,
for example `serve-droid start --host 192.168.1.42 --port 6090`, then open
`http://192.168.1.42:6090/` from that device. Use `--host 0.0.0.0` for all
IPv4 interfaces or `--host ::` for all IPv6 interfaces. For these wildcard
bindings the CLI prints a loopback URL for local use. To change the binding
of a running emulator, stop it and start it again with the desired host.
For HTTPS from anywhere on your tailnet, which WebMCP needs, keep the default
host and run `tailscale serve --bg 6090` next to `--port 6090`. See
[Access from anywhere](https://github.com/wookiehangover/serve-droid#access-from-anywhere).

The launcher uses the Git root (or the working directory outside Git) to
identify the project. Later runs reuse its emulator, including its apps and
settings. `ls` lists the running emulators with their URLs, and `logs` shows the
emulator and browser UI logs of a running one (`-f` to follow).
`stop` removes the container and keeps its data in two named Docker
volumes. A different device,
image or port can run alongside it under another `--name`. `rm` stops the
emulator and deletes both volumes (`serve-droid-<name>-data` and
`serve-droid-<name>-home`) after you confirm. Use `--yes` to skip the prompt.

## Troubleshooting

`serve-droid doctor` checks the machine without changing it: Node 22+, Git,
running emulators and optional Tailscale; on Linux the Docker CLI, daemon
access and permissions, BuildKit, `/dev/kvm`, the emulator image, free disk
and memory (about 4 GB per emulator); on macOS and Windows the Android SDK,
adb, emulator, sdkmanager, a system image and an AVD, acceleration, and the
Python setup for the browser UI. Each warning or failure prints a `Fix:` line.
It exits 1 when a required check fails. `--json` prints
`{ok, platform, checks: [{id, status, detail, fix?}]}`.

## First launch

The launcher looks for the local quick-start image
(`docker-android:emulator_16.0-webui`) or its `wookiehangover/`-prefixed tag.
If neither exists it builds the image with BuildKit. When running from this
repository it uses the checkout. The installed npm package fetches a pinned
revision with Git for the build. The first build requires network access and
can take several minutes. Subsequent projects share the cached image.

Use `--android 15` to select a different build, or `--image REGISTRY/IMAGE:TAG`
to use an existing compatible image. The image must support this fork's browser
UI on port 6090. See `serve-droid --help` for all options.

For Android 17, the launcher uses the image tag `emulator_17.0-webui-tools22`.
If you already have an Android 17 device created with older SDK tools, choose
a new name (for example, `--android 17 --name android17`) to create a fresh
virtual device while keeping the old device data.

## Try the subpackage locally

```sh
npm exec --package=./packages/serve-droid -- serve-droid --help
npm exec --package=./packages/serve-droid -- serve-droid
```

From the repository root, run `npm --prefix packages/serve-droid run test:e2e`
to pack and install the CLI, boot a disposable emulator, and check reuse,
configuration conflicts, stop, and persistence after restart. The test prints
the path to a screenshot. Set `ARTIFACT_DIR` to choose the output directory.
Append `-- 17` to run the same check on Android 17 and verify the virtual device target.

## Release

On an up-to-date `master`, run:

```sh
npm --prefix packages/serve-droid run release -- --dry-run   # preview
npm --prefix packages/serve-droid run release                # or: -- patch|minor|major|1.2.3
git push --atomic origin master serve-droid-vX.Y.Z
npm publish ./packages/serve-droid
```

The script picks the version from the commit types since the last release,
adds a section to [CHANGELOG.md](./CHANGELOG.md) (a hand-written `## Unreleased`
section becomes that release's notes), points the Linux emulator
image at the released source, then commits and tags `serve-droid-vX.Y.Z`.
Pushing the tag creates the GitHub release.

## Agent tools

The server describes its tools once, in `web-ui/tools.json` (served at
`GET tools.json`). The browser UI registers them with
[WebMCP](https://webmachinelearning.github.io/webmcp/), and `serve-droid mcp`
serves the same list over stdio. There are 28: `get_device_info`,
`get_ui_tree`, `get_screen`, `find_elements`, `tap`, `wait_for`, `swipe`,
`scroll`, `pinch`, `type_text`, `press_key`, `rotate`, `open_url`,
`set_clipboard`, `set_appearance`, `set_battery`, `set_location`,
`read_logcat`, `list_apps`, `manage_app`, `snapshot`, `send_sms`,
`phone_call`, `touch_fingerprint`, `set_network`, `set_accessibility`,
`get_events` and `run_shell`. `serve-droid mcp` adds `install_apk {path}`.
Coordinates are screen pixels in the current orientation, as returned by
`get_ui_tree` and `get_screen`. `tap`, `find_elements` and `wait_for` also take
a selector (`text`, `id`, `desc`, `class`, `exact`, `index`).

WebMCP requires a browser that supports it (Edge 147, or Chrome 149 with the
origin trial or flag) and a secure context: open the UI at a loopback address
or over HTTPS. A LAN address over plain HTTP gets no tools.

### Stdio MCP

```sh
claude mcp add android -- npx serve-droid mcp --start
```

`serve-droid mcp` speaks newline-delimited JSON-RPC (MCP 2025-06-18) on stdin
and stdout and logs to stderr. It resolves the emulator lazily: `--url`, then
`SERVE_DROID_URL`, then `--name` or the current project. `--start` boots the
project's emulator first.

### CLI actions, replay and the Node client

Run `serve-droid --help` for the action verbs (`screenshot`, `ui`, `find`,
`tap`, `wait`, `swipe`, `type`, `key`, `open`, `apps`, `launch`, `app`,
`snapshot`, `sms`, `call`, `geo`, `network`, `shell`, `events`, `replay`).
They take `--name` or `--url` and print JSON with `--json`. `wait` and `find`
exit 1 when nothing matches, so they work in shell scripts.

`serve-droid events --export flow.json` saves the event log as a script, and
`serve-droid replay flow.json --speed 2` plays it back. Steps are
`{t, action, ...params}`; steps whose body has its own `t`, `action` or
`params` field (`app`, `phone`, `snapshots`) nest it as `params`.

`import { connect } from 'serve-droid/client'` gives a typed client for every
endpoint. `import { droidMiddleware } from 'serve-droid/middleware'` proxies
the UI, API and WebSockets under a path of your own server (`/.droid` by
default) with only `node:http`.

### Token

`serve-droid start --token` sets `WEB_UI_TOKEN` in the container (or in the
native browser UI's environment) and prints a URL with `?token=`. Opening it
sets an HttpOnly, SameSite=Strict cookie. Other clients send
`Authorization: Bearer <token>`. `ls` shows the URL with its token. Each
Docker `start` makes a new token.

### Stream and WebSocket URLs

Every emulator serves these next to its preview. With a token, each takes
`?token=` (players and `<img>` tags cannot send headers); `start` and `ls`
print them with it.

| URL | What it is |
|---|---|
| `/stream.mjpeg` | `multipart/x-mixed-replace` JPEG frames, sent when the screen changes. Works in `<img>`, `ffplay` and VLC. |
| `/stream.h264` | H.264 Annex B from `screenrecord`. `ffplay -f h264 URL`. |
| `/stream.avcc` | The same video as `[len:u32 BE][tag:u8][payload]` envelopes: `1` avcC decoder config, `2` keyframe, `3` delta frame, `4` JPEG still. Same framing as serve-sim and serve-avd. |
| `/screenshot` | One PNG. |
| `/ws` | The viewer socket. `?codec=h264` for H.264 frames, `?video=none` for input only. |

`/ws` text messages are JSON. From the client:

| Message | Meaning |
|---|---|
| `{"t":"touch","x":0.5,"y":0.8,"down":true,"id":0}` | Finger `id` (0–9) down or moved; `down:false` lifts it. `x`, `y` are 0–1 across the current orientation. |
| `{"t":"wheel","x":0.5,"y":0.5,"dx":0,"dy":120}` | Scroll at a point, in CSS pixels. |
| `{"t":"key","key":"GoBack"}` | A key by its browser `KeyboardEvent.key` name (`GoHome`, `GoBack`, `AppSwitch`, `Enter`…). |
| `{"t":"text","text":"hello"}` | Type text. |
| `{"t":"rotate"}` | Switch between portrait and landscape. |

From the server: `{"t":"codec","codec":"jpeg"|"h264"|"none"}` first, then
`{"t":"frame","w","h","rotation"}` before JPEG frames of a new size,
`{"t":"clipboard","text"}` and `{"t":"event","event"}` (the event log).
Binary messages are a JPEG per frame, or `[tag][payload]` for H.264.

### Hub

`serve-droid hub [--host IP] [--port 6089] [--token]` lists every running
emulator as a live tile and proxies each one under `/d/<name>/`, so one port
(and one `tailscale serve --bg 6089`) covers all of them. The hub adds each
emulator's token itself; its own `--token` protects the hub. Anyone who can
reach the hub can use every emulator behind it.

### Tests

```sh
npm --prefix packages/serve-droid run test:webmcp -- URL
npm --prefix packages/serve-droid run test:agent -- URL --name NAME
```

`test:webmcp` loads the page in Chromium and calls every manifest tool through
WebMCP. `test:agent` covers token auth, the Node client, snapshots, every CLI
verb, record and replay, `serve-droid mcp` over stdio and (with `--name`) the
hub. Both print a directory with screenshots and a JSON log. Start the emulator
with `--token` so the token checks run.

## Native emulators on macOS and Windows

On macOS and Windows, `serve-droid start` and `serve-droid stop` manage a native emulator
instead of Docker. `start` runs the browser UI in the background, prints its URL
and returns. `stop` closes the browser UI and shuts down the emulator if `start`
booted it, saving its Quick Boot snapshot. An emulator that was already running
(for example from Android Studio) keeps running. Use `--name` to manage several
projects' browser UIs separately, and `ls` to list the running ones. `logs` shows
the browser UI log, plus the emulator log when `start` booted the emulator.
`rm` stops the session and deletes its state and log. It keeps the AVD and its
apps, which all projects share; manage them in Android Studio's Device Manager.
State and logs are in `~/Library/Caches/serve-droid` on macOS and
`%LOCALAPPDATA%\serve-droid` on Windows.

The launcher checks for ADB and
the emulator SDK (including its controller protocol). In a terminal it offers
to install missing packages with `sdkmanager`. If needed, it offers to use
Homebrew for the SDK command-line tools and Java on macOS. If Homebrew is missing too, the prompt includes its installation. On Windows, install
Android Studio (it includes the SDK and Java) and turn on Windows Hypervisor
Platform in Windows Features. Noninteractive runs print setup instructions.
If no emulator is running, the launcher boots an existing AVD headlessly
(preferring `serve-droid`, then the first name alphabetically). If no AVD exists,
it creates `serve-droid` using an installed host-compatible image, downloading
an Android 16 Google APIs image if needed. The browser UI runs locally and uses the selected emulator's gRPC
endpoint for display and input and its ADB serial for APK installs and logs.

From your project directory, run:

```sh
npx serve-droid
```

The launcher reuses `uv` when available. If it is missing, choose a
project-local uv installation or use an installed Python 3.12–3.14 with pip.
Both install the locked dependencies in `.serve-droid/.venv` (or `.venv`
in the serve-droid package directory). Subsequent runs reuse your choice.
For unattended setup, set `SERVE_DROID_PYTHON_SETUP=system` or
`SERVE_DROID_PYTHON_SETUP=uv`. Without a terminal or uv, setup tries system Python.

Open the printed loopback URL (default port 6090). Use
`--serial emulator-5554 --port 6080` to choose among running emulators
or change the browser port, and `--apk FILE` to install an APK after startup.
Set `ANDROID_HOME` for SDKs outside `~/Library/Android/sdk` (macOS) or
`%LOCALAPPDATA%\Android\Sdk` (Windows).

`serve-droid attach` runs the browser UI in the foreground instead. Ctrl-C
closes it and leaves the device running.
