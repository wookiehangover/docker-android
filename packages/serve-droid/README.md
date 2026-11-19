# serve-droid

Start an Android emulator for the current project and print its browser URL.
Requires Node.js 22+, a local Linux Docker engine with access to `/dev/kvm`,
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
