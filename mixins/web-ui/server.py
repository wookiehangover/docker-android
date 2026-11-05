#!/usr/bin/env python3
"""Browser UI for the Android emulator, driven by the emulator's gRPC API."""
import argparse
import asyncio
import glob
import io
import json
import logging
import os
import shlex
import sys
import tempfile

import grpc
from aiohttp import web, WSMsgType
from google.protobuf import empty_pb2
from PIL import Image

sys.path.insert(0, os.environ.get("EMULATOR_PROTO_PATH", os.path.dirname(__file__)))
import emulator_controller_pb2 as pb  # noqa: E402
import emulator_controller_pb2_grpc as rpc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_EDGE = int(os.environ.get("WEB_UI_MAX_EDGE", "1280"))
JPEG_QUALITY = int(os.environ.get("WEB_UI_JPEG_QUALITY", "80"))
MAX_APK_BYTES = 512 << 20

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("web_ui")


def discover_token() -> str:
    token = os.environ.get("EMULATOR_GRPC_TOKEN")
    if token:
        return token
    pattern = os.path.expanduser("~/.android/avd/running/pid_*.ini")
    for path in sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True):
        with open(path) as f:
            for line in f:
                if line.startswith("grpc.token="):
                    return line.split("=", 1)[1].strip()
    return ""


def to_panel(x: float, y: float, rotation: int):
    """Map a point on the rotated frame to the unrotated panel, both normalized to 0..1."""
    return {0: (x, y), 1: (1 - y, x), 2: (1 - x, 1 - y), 3: (y, 1 - x)}[rotation]


async def adb(*args: str, timeout: float = 30) -> str:
    proc = await asyncio.create_subprocess_exec(
        "adb", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"adb {args[0]} timed out")
    text = out.decode(errors="replace").strip()
    if proc.returncode != 0:
        raise RuntimeError(text or f"adb {args[0]} failed")
    return text


async def adb_shell(command: str, timeout: float = 30) -> str:
    return await adb("shell", command, timeout=timeout)


class Emulator:
    def __init__(self, address: str, label: str) -> None:
        self.address = address
        self.label = label or "Android Emulator"
        self.channel = None
        self.stub = None
        self.md = []
        self.lcd = (1080, 1920)
        self.details = {}
        self.rotation = 0
        self.frame = None
        self.frame_seq = 0
        self.frame_ready = asyncio.Condition()
        self.connected = asyncio.Event()
        self.clipboard = None
        self.sockets = set()

    async def connect(self) -> None:
        self.connected.clear()
        while True:
            token = discover_token()
            if self.channel:
                await self.channel.close()
            self.channel = grpc.aio.insecure_channel(
                self.address, options=[("grpc.max_receive_message_length", 64 << 20)])
            self.stub = rpc.EmulatorControllerStub(self.channel)
            self.md = [("authorization", f"Bearer {token}")] if token else []
            try:
                status = await self.stub.getStatus(empty_pb2.Empty(), metadata=self.md, timeout=5)
            except grpc.aio.AioRpcError as e:
                logger.info(f"waiting for emulator gRPC ({e.code().name})")
                await asyncio.sleep(2)
                continue
            cfg = {e.key: e.value for e in status.hardwareConfig.entry}
            self.lcd = (int(cfg.get("hw.lcd.width", 1080)), int(cfg.get("hw.lcd.height", 1920)))
            self.details = {
                "emulator": status.version.split(" ")[0],
                "density": cfg.get("hw.lcd.density"),
                "ram": cfg.get("hw.ramSize"),
                "cores": cfg.get("hw.cpu.ncore"),
                "avd": cfg.get("avd.name"),
            }
            logger.info(f"connected to emulator at {self.address}, panel {self.lcd[0]}x{self.lcd[1]}")
            self.connected.set()
            asyncio.create_task(self.load_build_props())
            return

    async def load_build_props(self) -> None:
        try:
            release, sdk = (await adb_shell("getprop ro.build.version.release; getprop ro.build.version.sdk",
                                            timeout=10)).splitlines()[:2]
            self.details.update({"android": release.strip(), "api": sdk.strip()})
        except (RuntimeError, ValueError, FileNotFoundError) as e:
            logger.info(f"build props unavailable: {e}")
            self.details.update({"android": os.environ.get("EMULATOR_ANDROID_VERSION"),
                                 "api": os.environ.get("EMULATOR_API_LEVEL")})

    @staticmethod
    def encode(img: "pb.Image") -> bytes:
        im = Image.frombuffer("RGB", (img.format.width, img.format.height), img.image, "raw", "RGB", 0, 1)
        out = io.BytesIO()
        im.save(out, "JPEG", quality=JPEG_QUALITY)
        return out.getvalue()

    async def pump_frames(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await self.connect()
            edge = min(MAX_EDGE, max(self.lcd))
            fmt = pb.ImageFormat(format=pb.ImageFormat.RGB888, width=edge, height=edge)
            try:
                async for img in self.stub.streamScreenshot(fmt, metadata=self.md):
                    jpeg = await loop.run_in_executor(None, self.encode, img)
                    async with self.frame_ready:
                        self.rotation = int(img.format.rotation.rotation)
                        self.frame = (jpeg, img.format.width, img.format.height, self.rotation)
                        self.frame_seq += 1
                        self.frame_ready.notify_all()
            except grpc.aio.AioRpcError as e:
                logger.warning(f"screen stream interrupted: {e.code().name}")
            await asyncio.sleep(1)

    async def pump_clipboard(self) -> None:
        while True:
            await self.connected.wait()
            try:
                async for clip in self.stub.streamClipboard(empty_pb2.Empty(), metadata=self.md):
                    if clip.text != self.clipboard:
                        self.clipboard = clip.text
                        await self.broadcast({"t": "clipboard", "text": clip.text})
            except grpc.aio.AioRpcError as e:
                logger.warning(f"clipboard stream interrupted: {e.code().name}")
            await asyncio.sleep(1)

    async def broadcast(self, message: dict) -> None:
        data = json.dumps(message)
        for ws in list(self.sockets):
            try:
                await ws.send_str(data)
            except (ConnectionResetError, RuntimeError):
                self.sockets.discard(ws)

    async def call(self, method: str, request, timeout: float = 5):
        if not self.connected.is_set():
            raise RuntimeError("emulator is not connected")
        return await getattr(self.stub, method)(request, metadata=self.md, timeout=timeout)

    async def try_call(self, method: str, request) -> None:
        try:
            await self.call(method, request)
        except (grpc.aio.AioRpcError, RuntimeError) as e:
            logger.warning(f"{method} failed: {e}")

    async def touch(self, x: float, y: float, down: bool) -> None:
        w, h = self.lcd
        px, py = to_panel(x, y, self.rotation)
        touch = pb.Touch(x=round(px * (w - 1)), y=round(py * (h - 1)), identifier=1, pressure=1 if down else 0)
        await self.try_call("sendTouch", pb.TouchEvent(touches=[touch]))

    async def key(self, key: str) -> None:
        await self.try_call("sendKey", pb.KeyboardEvent(eventType=pb.KeyboardEvent.keypress, key=key))

    async def text(self, text: str) -> None:
        await self.try_call("sendKey", pb.KeyboardEvent(text=text))

    async def rotate(self) -> None:
        angle = {0: 90, 1: 180, 2: 270, 3: 0}[self.rotation]
        await self.try_call("setPhysicalModel", pb.PhysicalModelValue(
            target=pb.PhysicalModelValue.ROTATION, value=pb.ParameterValue(data=[0, 0, angle])))

    async def screenshot(self) -> bytes:
        img = await self.call("getScreenshot", pb.ImageFormat(format=pb.ImageFormat.PNG), timeout=10)
        return img.image

    async def set_clipboard(self, text: str) -> None:
        self.clipboard = text
        await self.call("setClipboard", pb.ClipData(text=text))

    async def battery(self) -> dict:
        b = await self.call("getBattery", empty_pb2.Empty())
        return {"level": b.chargeLevel, "charging": b.charger != pb.BatteryState.NONE}

    async def set_battery(self, level: int, charging: bool) -> None:
        if level >= 100 and charging:
            status = pb.BatteryState.FULL
        else:
            status = pb.BatteryState.CHARGING if charging else pb.BatteryState.DISCHARGING
        await self.call("setBattery", pb.BatteryState(
            hasBattery=True, isPresent=True, chargeLevel=level, health=pb.BatteryState.GOOD, status=status,
            charger=pb.BatteryState.AC if charging else pb.BatteryState.NONE))

    async def location(self) -> dict:
        g = await self.call("getGps", empty_pb2.Empty())
        return {"lat": g.latitude, "lng": g.longitude}

    async def set_location(self, lat: float, lng: float) -> None:
        await self.call("setGps", pb.GpsState(passiveUpdate=False, latitude=lat, longitude=lng, satellites=12))


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(os.path.join(HERE, "index.html"))


async def info(request: web.Request) -> web.Response:
    emu: Emulator = request.app["emu"]
    w, h = emu.lcd
    return web.json_response({"label": emu.label, "width": w, "height": h, **emu.details})


async def screenshot(request: web.Request) -> web.Response:
    try:
        png = await request.app["emu"].screenshot()
    except (grpc.aio.AioRpcError, RuntimeError):
        raise web.HTTPServiceUnavailable()
    return web.Response(body=png, content_type="image/png")


def api(handler):
    async def wrapped(request: web.Request) -> web.Response:
        try:
            body = await request.json() if request.method == "POST" and request.can_read_body \
                and request.content_type == "application/json" else {}
            result = await handler(request.app["emu"], body, request)
            return web.json_response({"ok": True, **(result or {})})
        except (ValueError, KeyError, TypeError) as e:
            return web.json_response({"ok": False, "error": f"bad request: {e}"}, status=400)
        except (grpc.aio.AioRpcError, RuntimeError, FileNotFoundError) as e:
            detail = e.details() if isinstance(e, grpc.aio.AioRpcError) else str(e)
            return web.json_response({"ok": False, "error": detail}, status=502)
    return wrapped


@api
async def get_state(emu: Emulator, body: dict, request: web.Request):
    async def dark():
        return (await adb_shell("cmd uimode night", timeout=10)).strip().endswith("yes")

    names = ("dark", "battery", "location")
    results = await asyncio.gather(dark(), emu.battery(), emu.location(), return_exceptions=True)
    state = {n: (None if isinstance(r, Exception) else r) for n, r in zip(names, results)}
    return {**state, "clipboard": emu.clipboard or ""}


@api
async def post_clipboard(emu: Emulator, body: dict, request: web.Request):
    await emu.set_clipboard(str(body["text"]))


@api
async def post_open_url(emu: Emulator, body: dict, request: web.Request):
    url = str(body["url"]).strip()
    if not url:
        raise ValueError("url is empty")
    if "://" not in url:
        url = f"https://{url}"
    await adb_shell(f"am start -a android.intent.action.VIEW -d {shlex.quote(url)}")
    return {"url": url}


@api
async def post_appearance(emu: Emulator, body: dict, request: web.Request):
    await adb_shell(f"cmd uimode night {'yes' if body['dark'] else 'no'}")


@api
async def post_battery(emu: Emulator, body: dict, request: web.Request):
    level = max(0, min(100, int(body["level"])))
    await emu.set_battery(level, bool(body["charging"]))


@api
async def post_location(emu: Emulator, body: dict, request: web.Request):
    lat, lng = float(body["lat"]), float(body["lng"])
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError("latitude or longitude out of range")
    await emu.set_location(lat, lng)


@api
async def post_install(emu: Emulator, body: dict, request: web.Request):
    data = await request.read()
    if not data.startswith(b"PK"):
        raise ValueError("not an APK file")
    with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        await adb("install", "-r", "-g", path, timeout=180)
        package = None
        aapt = sorted(glob.glob(os.path.join(os.environ.get("ANDROID_HOME", "/opt/android"), "build-tools", "*", "aapt2")))
        if aapt:
            proc = await asyncio.create_subprocess_exec(aapt[-1], "dump", "packagename", path,
                                                        stdout=asyncio.subprocess.PIPE)
            out, _ = await proc.communicate()
            package = out.decode().strip() or None
        if package:
            await adb_shell(f"monkey -p {shlex.quote(package)} -c android.intent.category.LAUNCHER 1")
    finally:
        os.unlink(path)
    return {"package": package}


async def socket(request: web.Request) -> web.WebSocketResponse:
    emu: Emulator = request.app["emu"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    emu.sockets.add(ws)

    async def send_frames():
        seq, meta = -1, None
        while not ws.closed:
            async with emu.frame_ready:
                await emu.frame_ready.wait_for(lambda: emu.frame_seq != seq)
                seq, (jpeg, w, h, rot) = emu.frame_seq, emu.frame
            if meta != (w, h, rot):
                meta = (w, h, rot)
                await ws.send_str(json.dumps({"t": "frame", "w": w, "h": h, "rotation": rot}))
            await ws.send_bytes(jpeg)

    if emu.clipboard is not None:
        await ws.send_str(json.dumps({"t": "clipboard", "text": emu.clipboard}))
    sender = asyncio.create_task(send_frames())
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                m = json.loads(msg.data)
                kind = m.get("t")
                if kind == "touch":
                    await emu.touch(float(m["x"]), float(m["y"]), bool(m["down"]))
                elif kind == "key":
                    await emu.key(str(m["key"]))
                elif kind == "text":
                    await emu.text(str(m["text"]))
                elif kind == "rotate":
                    await emu.rotate()
            except (ValueError, KeyError, TypeError, AttributeError) as e:
                logger.warning(f"ignored malformed message: {e}")
    finally:
        emu.sockets.discard(ws)
        sender.cancel()
    return ws


async def start_background(app: web.Application) -> None:
    emu = Emulator(*app["emu_args"])
    app["emu"] = emu
    app["tasks"] = [asyncio.create_task(emu.pump_frames()), asyncio.create_task(emu.pump_clipboard())]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grpc", default=os.environ.get("EMULATOR_GRPC", "localhost:8554"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEB_UI_PORT", "6090")))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--label", default=os.environ.get("EMULATOR_DEVICE", ""))
    args = parser.parse_args()

    app = web.Application(client_max_size=MAX_APK_BYTES)
    app["emu_args"] = (args.grpc, args.label)
    app.on_startup.append(start_background)
    app.add_routes([
        web.get("/", index), web.get("/info", info), web.get("/screenshot", screenshot), web.get("/ws", socket),
        web.get("/api/state", get_state),
        web.post("/api/clipboard", post_clipboard), web.post("/api/open-url", post_open_url),
        web.post("/api/appearance", post_appearance), web.post("/api/battery", post_battery),
        web.post("/api/location", post_location), web.post("/api/install", post_install),
    ])
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
