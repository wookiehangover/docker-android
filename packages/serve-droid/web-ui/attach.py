"""Start or reuse a native Android emulator and serve its browser UI."""
import argparse
from contextlib import contextmanager
import errno
import http.client
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

from android_sdk import SCRIPT, WINDOWS, adb_path, emulator_path, ensure_sdk, run_tool, sdk_manager


def state_dir():
    if os.environ.get("SERVE_DROID_HOME"):
        return Path(os.environ["SERVE_DROID_HOME"])
    if sys.platform == "darwin":
        return Path.home() / "Library/Caches/serve-droid"
    if WINDOWS:
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "serve-droid"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "serve-droid"


def detached():
    """Popen options that keep a child running after this terminal closes."""
    if WINDOWS:
        # A hidden console, so adb calls from the child do not open windows.
        return {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


@contextmanager
def exclusive(path):
    with path.open("a+") as lock:
        try:
            if WINDOWS:
                import msvcrt
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError("Another serve-droid process is setting up the emulator. "
                               "Check its terminal for an SDK license prompt or boot progress.") from None
        yield


def alive(pid):
    if WINDOWS:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        try:
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def command_line(pid):
    if WINDOWS:
        args = ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"]
    else:
        args = ["ps", "-ww", "-p", str(pid), "-o", "command="]
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def check_acceleration(emulator):
    try:
        result = subprocess.run([emulator, "-accel-check"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return
    if result.returncode == 0:
        return
    lines = [line.strip() for line in result.stdout.splitlines()]
    detail = " ".join(line for line in lines if line and line not in ("accel", "accel:") and not line.isdigit())
    if detail and not detail.endswith("."):
        detail += "."
    fix = {
        "win32": "Turn on Windows Hypervisor Platform in Windows Features, then restart Windows.",
        "linux": "Make sure /dev/kvm exists and your user can open it.",
    }.get(sys.platform, "")
    raise RuntimeError(" ".join(part for part in ["The emulator cannot use hardware acceleration.", detail, fix] if part))


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

    abi = "arm64-v8a" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
    images = list((sdk / "system-images").glob(f"android-*/*/{abi}/system.img"))
    ensure_sdk(require_manager=True)
    manager = sdk_manager(sdk)
    # avdmanager resolves the SDK relative to its own installation, even when
    # ANDROID_HOME points at the SDK that owns the selected system image.
    avdmanager = Path(manager).resolve().with_name(f"avdmanager{SCRIPT}")
    if not avdmanager.is_relative_to(sdk.resolve()):
        print(f"Installing Android command-line tools in {sdk}…", file=sys.stderr, flush=True)
        run_tool([manager, f"--sdk_root={sdk}", "cmdline-tools;latest"], check=True)
        avdmanager = sdk / f"cmdline-tools/latest/bin/avdmanager{SCRIPT}"
        if not avdmanager.is_file():
            raise ValueError(f"SDK Manager did not install command-line tools in {sdk}.")
    if images:
        image = max(images, key=lambda p: p.stat().st_mtime)
        package = ";".join(image.parent.relative_to(sdk).parts)
    else:
        package = f"system-images;android-36;google_apis;{abi}"
        print(f"Installing {package} for the first virtual device…", file=sys.stderr, flush=True)
        run_tool([manager, f"--sdk_root={sdk}", package], check=True)
        if not (sdk.joinpath(*package.split(";")) / "system.img").is_file():
            raise ValueError(f"SDK Manager did not install {package}. Check the license and download output above.")
    print(f"Creating virtual device {name}…", file=sys.stderr, flush=True)
    run_tool([avdmanager, "create", "avd", "--name", name, "--package", package],
             input="no\n", text=True, check=True)
    return name


def start_or_select(sdk, requested):
    adb = adb_path(sdk)
    state = state_dir()
    state.mkdir(parents=True, exist_ok=True)
    with exclusive(state / "startup.lock"):
        print("Checking for a running Android emulator…", file=sys.stderr, flush=True)
        online = online_emulators(adb)
        if requested:
            if requested not in online:
                raise ValueError(f"{requested} is not an online emulator.")
            return requested, None
        if len(online) == 1:
            return online[0], None
        if online:
            raise ValueError(f"Select an emulator with --serial: {', '.join(online)}")

        emulator = emulator_path(sdk)
        if sys.platform != "darwin":
            check_acceleration(emulator)
        name = choose_avd(sdk, emulator)
        print(f"Starting {name} and waiting for Android…", file=sys.stderr, flush=True)
        log = state / "emulator.log"
        with log.open("w") as output:
            child = subprocess.Popen([emulator, "-avd", name, "-no-window", "-no-audio"], **detached(),
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
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
                    return serial, name
            time.sleep(2)
        raise RuntimeError(f"Timed out waiting for {name} to boot. See {log}")


def discover(serial):
    roots = [Path.home() / "Library/Caches/TemporaryItems", Path.home() / "Library/Caches/Google/AndroidEmulator",
             Path(tempfile.gettempdir()), Path.home() / ".android"]
    for variable in ("XDG_RUNTIME_DIR", "ANDROID_EMULATOR_HOME"):
        if os.environ.get(variable):
            roots.insert(0, Path(os.environ[variable]))
    for root in roots:
        for path in (root / "avd/running").glob("pid_*.ini"):
            match = re.fullmatch(r"pid_(\d+)(?:_info)?\.ini", path.name)
            if not match:
                continue
            if not alive(int(match[1])):
                continue
            try:
                props = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
            except FileNotFoundError:
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


def serving(port, serial):
    """Return True if our UI for serial answers on port, False if nothing listens."""
    # Windows retries refused loopback connections for about two seconds.
    conn = http.client.HTTPConnection("127.0.0.1", int(port), timeout=5)
    try:
        token = os.environ.get("WEB_UI_TOKEN")
        conn.request("GET", "/info", headers={"Authorization": f"Bearer {token}"} if token else {})
        response = conn.getresponse()
        if response.status == 200:
            info = json.loads(response.read(65536))
            if isinstance(info, dict) and info.get("serve_droid_serial") == serial:
                return True
    except ConnectionRefusedError:
        return False
    except (OSError, http.client.HTTPException, ValueError):
        pass
    finally:
        conn.close()
    raise ValueError(f"Port {port} is in use by another service or emulator. Choose another --port.")


def reuse_server(port, serial):
    if serving(port, serial):
        print(f"http://127.0.0.1:{port}/", flush=True)
        return True
    return False


def serve(sdk, serial, port):
    adb = adb_path(sdk)
    props = discover(serial)
    os.environ.update(ANDROID_SERIAL=serial, PATH=f"{adb.parent}{os.pathsep}{os.environ['PATH']}")
    proto = sdk / "emulator/lib/emulator_controller.proto"
    with tempfile.TemporaryDirectory(prefix="serve-droid-proto-") as generated:
        subprocess.run([sys.executable, "-m", "grpc_tools.protoc", f"-I{proto.parent}",
                        f"--python_out={generated}", f"--grpc_python_out={generated}", str(proto)], check=True)
        sys.path.insert(0, generated)
        import server
        sys.argv = [sys.argv[0], "--host", "127.0.0.1", "--port", port,
                    "--grpc", f"localhost:{int(props['grpc.port'])}", "--label", props.get("avd.name", serial)]
        with credentials(props) as metadata:
            try:
                server.main(metadata=metadata, wait_for_frame=True, serial=serial)
            except OSError as error:
                if error.errno != errno.EADDRINUSE or not reuse_server(port, serial):
                    raise


def read_state(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def owns(pid):
    """Check that pid is still a serve-droid browser server, not a recycled PID."""
    return str(Path(__file__).resolve()) in command_line(pid)


def start(sdk, serial, booted, port, state_path):
    state = read_state(state_path)
    if state.get("pid") and owns(state["pid"]) and state.get("port") != port:
        raise ValueError(f"This project's browser UI runs on port {state.get('port')}. Stop it first to change --port.")
    if state.get("serial") == serial and not booted:
        booted = state.get("avd")
    state.update(serial=serial, port=port, avd=booted)
    state_path.write_text(json.dumps(state))
    if not serving(port, serial):
        log = state_path.with_suffix(".log")
        print("Starting the browser UI…", file=sys.stderr, flush=True)
        with log.open("w") as output:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "attach",
                                      "--serial", serial, "--port", port], **detached(),
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 120
        while not serving(port, serial):
            if child.poll() is not None:
                raise RuntimeError(f"The browser UI exited during startup. See {log}")
            if time.monotonic() > deadline:
                child.terminate()
                raise RuntimeError(f"Timed out waiting for the browser UI. See {log}")
            time.sleep(0.5)
        state["pid"] = child.pid
        state_path.write_text(json.dumps(state))
    print(f"http://127.0.0.1:{port}/", flush=True)


def stop(sdk, state_path):
    state = read_state(state_path)
    if not state:
        print("No emulator started by serve-droid for this project.", file=sys.stderr)
        return
    pid = state.get("pid")
    if pid and owns(pid):
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while owns(pid) and time.monotonic() < deadline:
            time.sleep(0.2)
        if owns(pid):
            os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
    serial, avd = state.get("serial"), state.get("avd")
    adb = adb_path(sdk)
    if avd and serial in online_emulators(adb):
        identity = subprocess.run([adb, "-s", serial, "emu", "avd", "name"],
                                  capture_output=True, text=True, timeout=10)
        if avd in identity.stdout.splitlines():
            print(f"Stopping {avd}…", file=sys.stderr, flush=True)
            # The console kill saves the Quick Boot snapshot before exiting.
            subprocess.run([adb, "-s", serial, "emu", "kill"], capture_output=True, timeout=30)
            deadline = time.monotonic() + 60
            while serial in online_emulators(adb):
                if time.monotonic() > deadline:
                    raise RuntimeError(f"{avd} did not shut down within 60 seconds.")
                time.sleep(1)
    state_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="attach", choices=["attach", "start", "stop"])
    parser.add_argument("--serial")
    parser.add_argument("--port", default="6090")
    parser.add_argument("--state", type=Path)
    args = parser.parse_args()
    if args.command != "attach" and not args.state:
        parser.error(f"{args.command} requires --state")
    sdk = ensure_sdk()
    os.environ.update(ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk))
    if args.command == "stop":
        return stop(sdk, args.state)
    serial, booted = start_or_select(sdk, args.serial)
    if args.command == "start":
        args.state.parent.mkdir(parents=True, exist_ok=True)
        return start(sdk, serial, booted, args.port, args.state)
    if not reuse_server(args.port, serial):
        serve(sdk, serial, args.port)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, ImportError, RuntimeError) as error:
        sys.exit(f"serve-droid attach: {error}")
