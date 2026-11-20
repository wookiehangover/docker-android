"""Start or reuse a native Android emulator and serve its browser UI."""
import argparse
from contextlib import contextmanager
import errno
import fcntl
import http.client
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time
import uuid

from android_sdk import ensure_sdk, sdk_manager


def online_emulators(adb):
    output = subprocess.check_output([adb, "devices"], text=True, timeout=15)
    return re.findall(r"^(emulator-\d+)\s+device$", output, re.MULTILINE)


def choose_avd(sdk, emulator):
    names = subprocess.check_output([emulator, "-list-avds"], text=True).splitlines()
    name = "serve-droid"
    if name in names:
        return name
    if names:
        return sorted(names)[0]

    abi = "arm64-v8a" if platform.machine() == "arm64" else "x86_64"
    images = list((sdk / "system-images").glob(f"android-*/*/{abi}/system.img"))
    ensure_sdk(require_manager=True)
    manager = sdk_manager(sdk)
    # avdmanager resolves the SDK relative to its own installation, even when
    # ANDROID_HOME points at the SDK that owns the selected system image.
    avdmanager = Path(manager).resolve().with_name("avdmanager")
    if not avdmanager.is_relative_to(sdk.resolve()):
        print(f"Installing Android command-line tools in {sdk}…", file=sys.stderr, flush=True)
        subprocess.run([manager, f"--sdk_root={sdk}", "cmdline-tools;latest"], check=True)
        avdmanager = sdk / "cmdline-tools/latest/bin/avdmanager"
        if not avdmanager.is_file():
            raise ValueError(f"SDK Manager did not install command-line tools in {sdk}.")
    if images:
        image = max(images, key=lambda p: p.stat().st_mtime)
        package = ";".join(image.parent.relative_to(sdk).parts)
    else:
        package = f"system-images;android-36;google_apis;{abi}"
        print(f"Installing {package} for the first virtual device…", file=sys.stderr, flush=True)
        subprocess.run([manager, f"--sdk_root={sdk}", package], check=True)
        if not (sdk.joinpath(*package.split(";")) / "system.img").is_file():
            raise ValueError(f"SDK Manager did not install {package}. Check the license and download output above.")
    print(f"Creating virtual device {name}…", file=sys.stderr, flush=True)
    subprocess.run([avdmanager, "create", "avd", "--name", name, "--package", package],
                   input="no\n", text=True, check=True)
    return name


def start_or_select(sdk, requested):
    adb = sdk / "platform-tools/adb"
    state = Path.home() / "Library/Caches/serve-droid"
    state.mkdir(parents=True, exist_ok=True)
    with (state / "startup.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another serve-droid process is setting up the emulator. "
                               "Check its terminal for an SDK license prompt or boot progress.") from None
        print("Checking for a running Android emulator…", file=sys.stderr, flush=True)
        online = online_emulators(adb)
        if requested:
            if requested not in online:
                raise ValueError(f"{requested} is not an online emulator.")
            return requested
        if len(online) == 1:
            return online[0]
        if online:
            raise ValueError(f"Select an emulator with --serial: {', '.join(online)}")

        emulator = sdk / "emulator/emulator"
        name = choose_avd(sdk, emulator)
        print(f"Starting {name} and waiting for Android…", file=sys.stderr, flush=True)
        log = state / "emulator.log"
        with log.open("w") as output:
            child = subprocess.Popen([emulator, "-avd", name, "-no-window", "-no-audio"],
                                     start_new_session=True, stdin=subprocess.DEVNULL,
                                     stdout=output, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(f"Emulator exited during startup. See {log}")
            for serial in online_emulators(adb):
                target = [adb, "-s", serial]
                identity = subprocess.run([*target, "emu", "avd", "name"], capture_output=True, text=True, timeout=10)
                if name not in identity.stdout.splitlines():
                    continue
                boot = subprocess.run([*target, "shell", "getprop", "sys.boot_completed"],
                                      capture_output=True, text=True, timeout=10)
                if boot.stdout.strip() == "1":
                    return serial
            time.sleep(2)
        raise RuntimeError(f"Timed out waiting for {name} to boot. See {log}")


def discover(serial):
    roots = [Path.home() / "Library/Caches/TemporaryItems", Path.home() / "Library/Caches/Google/AndroidEmulator",
             Path(tempfile.gettempdir()), Path.home() / ".android"]
    if os.environ.get("ANDROID_EMULATOR_HOME"):
        roots.insert(0, Path(os.environ["ANDROID_EMULATOR_HOME"]))
    for root in roots:
        for path in (root / "avd/running").glob("pid_*.ini"):
            match = re.fullmatch(r"pid_(\d+)(?:_info)?\.ini", path.name)
            if not match:
                continue
            try:
                os.kill(int(match[1]), 0)
                props = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            if f"emulator-{props.get('port.serial')}" == serial and props.get("grpc.port"):
                return props
    raise ValueError(f"Could not find a live emulator gRPC discovery file for {serial}.")


@contextmanager
def credentials(props):
    if props.get("grpc.token"):
        yield lambda method: [("authorization", "Bearer " + props["grpc.token"])]
        return
    if not props.get("grpc.jwks"):
        yield lambda method: []
        return

    import jwt
    from cryptography.hazmat.primitives.asymmetric import ec
    from emulator_controller_pb2 import DESCRIPTOR

    service = DESCRIPTOR.services_by_name["EmulatorController"].full_name
    key = ec.generate_private_key(ec.SECP521R1())
    kid = uuid.uuid4().hex
    public = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    public.update(kid=kid, alg="ES512", use="sig")
    path = Path(props["grpc.jwks"]) / f"{kid}.jwk"

    def metadata(method):
        now = int(time.time())
        claims = {"iss": "serve-droid", "iat": now, "exp": now + 60, "aud": [f"/{service}/{method}"]}
        token = jwt.encode(claims, key, algorithm="ES512", headers={"kid": kid})
        return [("authorization", f"Bearer {token}")]

    try:
        path.write_text(json.dumps({"keys": [public]}))
        yield metadata
    finally:
        path.unlink(missing_ok=True)


def reuse_server(port, serial):
    conn = http.client.HTTPConnection("127.0.0.1", int(port), timeout=2)
    try:
        conn.request("GET", "/info")
        response = conn.getresponse()
        if response.status == 200:
            info = json.loads(response.read(65536))
            if isinstance(info, dict) and info.get("serve_droid_serial") == serial:
                print(f"http://127.0.0.1:{port}/", flush=True)
                return True
    except ConnectionRefusedError:
        return False
    except (OSError, http.client.HTTPException, ValueError):
        pass
    finally:
        conn.close()
    raise ValueError(f"Port {port} is in use by another service or emulator. Choose another --port.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial")
    parser.add_argument("--port", default="6090")
    args = parser.parse_args()
    sdk = ensure_sdk()
    adb = sdk / "platform-tools/adb"
    os.environ.update(ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk))
    serial = start_or_select(sdk, args.serial)
    if reuse_server(args.port, serial):
        return
    props = discover(serial)
    os.environ.update(ANDROID_SERIAL=serial, ANDROID_HOME=str(sdk),
                      PATH=f"{adb.parent}{os.pathsep}{os.environ['PATH']}")
    proto = sdk / "emulator/lib/emulator_controller.proto"
    with tempfile.TemporaryDirectory(prefix="serve-droid-proto-") as generated:
        subprocess.run([sys.executable, "-m", "grpc_tools.protoc", f"-I{proto.parent}",
                        f"--python_out={generated}", f"--grpc_python_out={generated}", str(proto)], check=True)
        sys.path.insert(0, generated)
        import server
        sys.argv = [sys.argv[0], "--host", "127.0.0.1", "--port", args.port,
                    "--grpc", f"localhost:{int(props['grpc.port'])}", "--label", props.get("avd.name", serial)]
        with credentials(props) as metadata:
            try:
                server.main(metadata=metadata, wait_for_frame=True, serial=serial)
            except OSError as error:
                if error.errno != errno.EADDRINUSE or not reuse_server(args.port, serial):
                    raise


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, ImportError, RuntimeError) as error:
        sys.exit(f"serve-droid attach: {error}")
