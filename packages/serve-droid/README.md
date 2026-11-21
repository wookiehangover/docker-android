# serve-droid

Start an Android emulator for the current project and print its browser URL.
Requires Node.js 22+. On macOS, start, reuse and stop a native emulator.
Container startup requires a local Linux Docker engine with access to `/dev/kvm`
and an x86-64 host. Run from any project directory.

```sh
npx serve-droid
npx serve-droid --apk ./app-debug.apk
npx serve-droid --name tablet --device "Pixel C" --port 6081
npx serve-droid stop --name tablet
```

The default is a headless Samsung Galaxy S10 running Android 16. Docker picks
a free loopback port. Progress goes to stderr. Once Android and the browser UI
are ready, stdout contains the URL. Open it in a browser on the Docker host.

To open the UI from another device, bind to the Docker host's LAN address,
for example `serve-droid start --host 192.168.1.42 --port 6090`, then open
`http://192.168.1.42:6090/` from that device. Use `--host 0.0.0.0` for all
IPv4 interfaces or `--host ::` for all IPv6 interfaces. For these wildcard
bindings the CLI prints a loopback URL for local use. To change the binding
of a running emulator, stop it and start it again with the desired host.

The launcher uses the Git root (or the working directory outside Git) to
identify the project. Later runs reuse its emulator, including its apps and
settings. `stop` removes the container and keeps its data in two named Docker
volumes. A different device,
image or port can run alongside it under another `--name`. Removing the
two volumes (`serve-droid-<name>-data` and `serve-droid-<name>-home`) after
stopping the emulator deletes its device data.

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

## Native emulators on macOS

On macOS, `serve-droid start` and `serve-droid stop` manage a native emulator
instead of Docker. `start` runs the browser UI in the background, prints its URL
and returns. `stop` closes the browser UI and shuts down the emulator if `start`
booted it, saving its Quick Boot snapshot. An emulator that was already running
(for example from Android Studio) keeps running. Use `--name` to manage several
projects' browser UIs separately. State and logs are in `~/Library/Caches/serve-droid`.

The launcher checks for ADB and
the emulator SDK (including its controller protocol). In a terminal it offers
to install missing packages with `sdkmanager`. If needed, it offers to use
Homebrew for the SDK command-line tools and Java. If Homebrew is missing too, the prompt includes its installation. Noninteractive runs print setup instructions.
If no emulator is running, the launcher boots an existing AVD headlessly
(preferring `serve-droid`, then the first name alphabetically). If no AVD exists,
it creates `serve-droid` using an installed host-compatible image, downloading
an Android 16 Google APIs image if needed. The browser UI runs locally and uses the selected emulator's gRPC
endpoint for display and input and its ADB serial for APK installs and logs.

From your project directory, run:

```sh
npx serve-droid
```

The Mac launcher reuses `uv` when available. If it is missing, choose a
project-local uv installation or use an installed Python 3.12–3.14 with pip.
Both install the locked dependencies in `.serve-droid/.venv` (or `.venv`
in the serve-droid package directory). Subsequent runs reuse your choice.
For unattended setup, set `SERVE_DROID_PYTHON_SETUP=system` or
`SERVE_DROID_PYTHON_SETUP=uv`. Without a terminal or uv, setup tries system Python.

Open the printed loopback URL (default port 6090). Use
`--serial emulator-5554 --port 6080` to choose among running emulators
or change the browser port, and `--apk FILE` to install an APK after startup.
Set `ANDROID_HOME` for SDKs outside `~/Library/Android/sdk`.

`serve-droid attach` runs the browser UI in the foreground instead. Ctrl-C
closes it and leaves the device running.
