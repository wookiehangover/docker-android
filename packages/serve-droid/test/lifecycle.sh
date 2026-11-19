#!/usr/bin/env bash
# Run on a Linux Docker host with KVM. Keep the screenshot as boot evidence.
set -euo pipefail
trap 'echo "Lifecycle check failed at line $LINENO." >&2' ERR
package_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
name=smoke-${work##*.}
container=serve-droid-$name
cleanup() {
  docker rm -fv "$container" >/dev/null 2>&1 || true
  docker volume rm "$container-data" "$container-home" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
artifact=${ARTIFACT_DIR:-$(mktemp -d)}
mkdir -p "$artifact"
artifact=$(cd "$artifact" && pwd)
cd "$work"
npm pack "$package_dir" --silent >/dev/null
npm install --no-audit --no-fund ./serve-droid-*.tgz >/dev/null
cli=./node_modules/.bin/serve-droid
android=${1:-16}
url=$("$cli" --name "$name" --android "$android" --device "Samsung Galaxy S10" --host 127.0.0.2)
[[ "$url" == http://127.0.0.2:* ]]
if "$cli" --name "$name" --host 127.0.0.1; then exit 1; fi
if [[ "$android" == 17 || "$android" == 17.0 ]]; then
  docker exec "$container" sh -c 'grep -Fx target=android-37.0 ~/.android/avd/*.ini'
fi
port=${url##*:}
# Build a tiny launcher activity using the SDK and JDK already in the image.
docker exec -i "$container" sh -eu -c '
  cd "$(mktemp -d)"
  cat > AndroidManifest.xml
  tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
  platform=$(ls -d "$ANDROID_HOME"/platforms/android-* | sort -V | tail -1)
  "$tools/aapt2" link -I "$platform/android.jar" --manifest AndroidManifest.xml -o base.apk
  keytool -genkeypair -alias test -keyalg RSA -keystore test.jks -storepass android \
    -keypass android -dname CN=serve-droid-smoke >/dev/null 2>&1
  "$tools/apksigner" sign --ks test.jks --ks-pass pass:android --out /tmp/smoke.apk base.apk
' <<'MANIFEST'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.servedroid.smoke">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="32"/>
  <application android:hasCode="false">
    <activity android:name="android.app.Activity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>
MANIFEST
docker cp "$container:/tmp/smoke.apk" "$work/sample app.apk"
test "$("$cli" --name "$name" --port "${port%/}" --apk "$work/sample app.apk")" = "$url"
docker exec "$container" adb shell pm path dev.servedroid.smoke
if "$cli" --name "$name" --device "Nexus 4"; then exit 1; fi
"$cli" stop --name "$name"
test -z "$(docker ps -aq --filter "name=^/${container}$")"
url=$("$cli" --name "$name")
[[ "$url" == http://127.0.0.1:* ]]
installed=$(docker exec "$container" adb shell pm path dev.servedroid.smoke || true)
if [[ "$installed" != package:* ]]; then
  echo "The installed APK is missing after restarting Android." >&2
  exit 1
fi
docker exec "$container" adb shell wm dismiss-keyguard
docker exec "$container" adb shell input keyevent KEYCODE_HOME
curl -fsS "${url}screenshot" -o "$artifact/device.png"
curl -fsS "${url}info"
echo
echo "Screenshot saved to $artifact/device.png"
