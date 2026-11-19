"""Serve the shared browser UI for one running Android Studio emulator."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid

from android_sdk import ensure_sdk


def select_serial(adb, requested):
    output = subprocess.check_output([adb, "devices"], text=True)
    online = re.findall(r"^(emulator-\d+)\s+device$", output, re.MULTILINE)
    if requested in online:
        return requested
    if requested:
        raise ValueError(f"{requested} is not an online emulator.")
    if len(online) == 1:
        return online[0]
    if online:
        raise ValueError(f"Select an emulator with --serial: {', '.join(online)}")
    raise ValueError("Start an Android Studio virtual device, then run attach again.")


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial")
    parser.add_argument("--port", default="6090")
    args = parser.parse_args()
    sdk = ensure_sdk()
    adb = sdk / "platform-tools/adb"
    serial = select_serial(adb, args.serial)
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
            server.main(metadata=metadata, wait_for_frame=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, ImportError, RuntimeError) as error:
        sys.exit(f"serve-droid attach: {error}")
