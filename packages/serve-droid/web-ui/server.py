#!/usr/bin/env python3
"""Browser UI for the Android emulator, driven by the emulator's gRPC API."""
import argparse
import asyncio
import base64
import glob
import io
import json
import logging
import os
import re
import shlex
import sys
import tempfile
import uuid
from collections import deque
from urllib.parse import urlsplit
from xml.etree import ElementTree

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
        "adb", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"adb {args[0]} timed out")
    text = out.decode(errors="replace").strip()
    if proc.returncode != 0:
        raise RuntimeError((text + "\n" + err.decode(errors="replace")).strip() or f"adb {args[0]} failed")
    return text


async def adb_shell(command: str, timeout: float = 30) -> str:
    return await adb("shell", command, timeout=timeout)


LOGCAT_LEVELS = "VDIWEFA"
LOGCAT_LINE = re.compile(
    r"^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*: (.*)$")


def parse_logcat(line: str):
    """Parse one `logcat -v threadtime` line into [time, pid, tid, level, tag, message]."""
    m = LOGCAT_LINE.match(line)
    if not m:
        return None
    time, pid, tid, level, tag, msg = m.groups()
    return [time[6:], int(pid), int(tid), level, tag, msg]


class Logcat:
    """One shared `adb logcat` follower with a ring buffer, active while anyone watches."""

    def __init__(self, size: int = 2000) -> None:
        self.ring = deque(maxlen=size)
        self.sockets = set()
        self.task = None
        self.proc = None

    async def subscribe(self, ws: web.WebSocketResponse) -> None:
        self.sockets.add(ws)
        if self.ring and self.task and not self.task.done():
            await ws.send_str(json.dumps({"t": "lines", "lines": list(self.ring)}))
        if not self.task or self.task.done():
            self.task = asyncio.create_task(self.run())

    def unsubscribe(self, ws: web.WebSocketResponse) -> None:
        self.sockets.discard(ws)
        if not self.sockets and self.task:
            self.task.cancel()

    async def run(self) -> None:
        self.ring.clear()
        tail = "500"
        try:
            while self.sockets:
                self.proc = await asyncio.create_subprocess_exec(
                    "adb", "logcat", "-v", "threadtime", "-T", tail,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                batch = []
                flush = asyncio.create_task(self.flush_loop(batch))
                try:
                    async for raw in self.proc.stdout:
                        entry = parse_logcat(raw.decode(errors="replace").rstrip("\r\n"))
                        if entry:
                            batch.append(entry)
                finally:
                    flush.cancel()
                    await self.send(batch)
                tail = "1"
                await asyncio.sleep(1)
        finally:
            if self.proc and self.proc.returncode is None:
                self.proc.kill()

    async def flush_loop(self, batch: list) -> None:
        while True:
            await asyncio.sleep(0.1)
            if batch:
                lines = batch[:]
                batch.clear()
                await self.send(lines)

    async def send(self, lines: list) -> None:
        if not lines:
            return
        self.ring.extend(lines)
        data = json.dumps({"t": "lines", "lines": lines})
        for ws in list(self.sockets):
            try:
                await ws.send_str(data)
            except (ConnectionResetError, RuntimeError):
                self.sockets.discard(ws)


class Emulator:
    def __init__(self, address: str, label: str, metadata=None) -> None:
        self.address = address
        self.label = label or "Android Emulator"
        self.channel = None
        self.stub = None
        self.native_metadata = metadata
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

    def metadata(self, method):
        return self.native_metadata(method) if self.native_metadata else self.md

    async def connect(self) -> None:
        self.connected.clear()
        while True:
            token = "" if self.native_metadata else discover_token()
            if self.channel:
                await self.channel.close()
            self.channel = grpc.aio.insecure_channel(
                self.address, options=[("grpc.max_receive_message_length", 64 << 20)])
            self.stub = rpc.EmulatorControllerStub(self.channel)
            self.md = [("authorization", f"Bearer {token}")] if token else []
            try:
                status = await self.stub.getStatus(empty_pb2.Empty(), metadata=self.metadata("getStatus"), timeout=5)
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
                async for img in self.stub.streamScreenshot(fmt, metadata=self.metadata("streamScreenshot")):
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
                async for clip in self.stub.streamClipboard(empty_pb2.Empty(), metadata=self.metadata("streamClipboard")):
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
        return await getattr(self.stub, method)(request, metadata=self.metadata(method), timeout=timeout)

    async def try_call(self, method: str, request) -> None:
        try:
            await self.call(method, request)
        except (grpc.aio.AioRpcError, RuntimeError) as e:
            logger.warning(f"{method} failed: {e}")

    async def send(self, method: str, request, strict: bool) -> None:
        """Strict callers (the HTTP API) get errors; the live socket logs them and carries on."""
        await (self.call(method, request) if strict else self.try_call(method, request))

    async def touch(self, x: float, y: float, down: bool, strict: bool = False) -> None:
        w, h = self.lcd
        px, py = to_panel(x, y, self.rotation)
        touch = pb.Touch(x=round(px * (w - 1)), y=round(py * (h - 1)), identifier=1, pressure=1 if down else 0)
        await self.send("sendTouch", pb.TouchEvent(touches=[touch]), strict)

    def display_size(self, rotation=None):
        w, h = self.lcd
        return (h, w) if (self.rotation if rotation is None else rotation) % 2 else (w, h)

    async def key(self, key: str, strict: bool = False) -> None:
        await self.send("sendKey", pb.KeyboardEvent(eventType=pb.KeyboardEvent.keypress, key=key), strict)

    async def text(self, text: str, strict: bool = False) -> None:
        await self.send("sendKey", pb.KeyboardEvent(text=text), strict)

    async def rotate(self, strict: bool = False) -> None:
        angle = {0: 90, 1: 180, 2: 270, 3: 0}[self.rotation]
        await self.send("setPhysicalModel", pb.PhysicalModelValue(
            target=pb.PhysicalModelValue.ROTATION, value=pb.ParameterValue(data=[0, 0, angle])), strict)

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
    info = {"label": emu.label, "width": w, "height": h, **emu.details}
    if request.app.get("serial"):
        info["serve_droid_serial"] = request.app["serial"]
    return web.json_response(info)


async def screenshot(request: web.Request) -> web.Response:
    try:
        png = await request.app["emu"].screenshot()
    except (grpc.aio.AioRpcError, RuntimeError):
        raise web.HTTPServiceUnavailable()
    return web.Response(body=png, content_type="image/png")


def cross_site(request: web.Request) -> bool:
    """True for browser requests from another site. Non-browser clients send neither header."""
    site = request.headers.get("Sec-Fetch-Site")
    if site:
        return site not in ("same-origin", "none")
    origin = request.headers.get("Origin")
    return bool(origin) and urlsplit(origin).netloc != request.host


def api(handler):
    async def wrapped(request: web.Request) -> web.Response:
        if request.method != "GET" and cross_site(request):
            return web.json_response({"ok": False, "error": "cross-site request refused"}, status=403)
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
        aapt = sorted(glob.glob(os.path.join(os.environ.get("ANDROID_HOME", "/opt/android"), "build-tools", "*",
                                    "aapt2.exe" if sys.platform == "win32" else "aapt2")))
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


@api
async def get_foreground(emu: Emulator, body: dict, request: web.Request):
    out = await adb_shell(
        "set -- $(dumpsys activity activities 2>/dev/null "
        "| sed -nE 's/.*(mResumedActivity|topResumedActivity).* ([A-Za-z0-9_.]+)\\/.*/\\2/p'); "
        "echo \"$1\"; [ -n \"$1\" ] && pidof \"$1\"; true", timeout=10)
    lines = out.splitlines()
    package = lines[0].strip() if lines else ""
    pids = [int(p) for p in (lines[1].split() if len(lines) > 1 else []) if p.isdigit()]
    return {"package": package or None, "pids": pids}


def device_point(emu: Emulator, x, y):
    """Normalize a pixel point in the current orientation, as used by screenshots and the UI tree."""
    w, h = emu.display_size()
    x, y = float(x), float(y)
    if not (0 <= x < w and 0 <= y < h):
        raise ValueError(f"point ({x:g}, {y:g}) is outside the {w}x{h} screen")
    return x / (w - 1), y / (h - 1)


@api
async def post_tap(emu: Emulator, body: dict, request: web.Request):
    x, y = device_point(emu, body["x"], body["y"])
    hold = max(40, min(5000, int(body.get("duration_ms", 60))))
    await emu.touch(x, y, True, strict=True)
    await asyncio.sleep(hold / 1000)
    await emu.touch(x, y, False, strict=True)


@api
async def post_swipe(emu: Emulator, body: dict, request: web.Request):
    x1, y1 = device_point(emu, body["x1"], body["y1"])
    x2, y2 = device_point(emu, body["x2"], body["y2"])
    duration = max(50, min(5000, int(body.get("duration_ms", 300))))
    steps = max(2, duration // 16)
    for i in range(steps + 1):
        t = i / steps
        await emu.touch(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, True, strict=True)
        await asyncio.sleep(duration / 1000 / steps)
    await emu.touch(x2, y2, False, strict=True)


@api
async def post_key(emu: Emulator, body: dict, request: web.Request):
    key = str(body["key"])
    if not key:
        raise ValueError("key is empty")
    await emu.key(key, strict=True)


@api
async def post_text(emu: Emulator, body: dict, request: web.Request):
    await emu.text(str(body["text"]), strict=True)


@api
async def post_rotate(emu: Emulator, body: dict, request: web.Request):
    await emu.rotate(strict=True)


@api
async def get_frame(emu: Emulator, body: dict, request: web.Request):
    if not emu.frame:
        raise RuntimeError("no frame yet")
    jpeg, w, h, rotation = emu.frame
    edge = max(160, min(MAX_EDGE, int(request.query.get("max_edge", 768))))
    if max(w, h) > edge:
        def shrink():
            im = Image.open(io.BytesIO(jpeg))
            im.thumbnail((edge, edge))
            out = io.BytesIO()
            im.save(out, "JPEG", quality=70)
            return out.getvalue(), im.width, im.height
        jpeg, w, h = await asyncio.get_running_loop().run_in_executor(None, shrink)
    dw, dh = emu.display_size(rotation)
    return {"mimeType": "image/jpeg", "width": w, "height": h, "screenWidth": dw, "screenHeight": dh,
            "data": base64.b64encode(jpeg).decode()}


UI_DUMP_LOCK = asyncio.Lock()
BOUNDS = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")
UI_FLAGS = ("clickable", "long-clickable", "scrollable", "checkable", "checked", "focused", "selected")


def compact_ui_tree(xml: str, panel, frame_rotation: int, frame_size) -> list:
    """Keep only nodes an agent can read or act on, with bounds and center in screen pixels.

    uiautomator reports Android's logical orientation, which differs from the frame when the device
    is rotated but the app stays upright, so map bounds into frame pixels to match screenshots and taps.
    """
    root = ElementTree.fromstring(xml)
    rotation = int(root.get("rotation", 0)) % 4
    lw, lh = (panel[1], panel[0]) if rotation % 2 else panel
    fw, fh = frame_size
    turn = (rotation - frame_rotation) % 4

    def to_frame(x, y):
        fx, fy = to_panel(x / lw, y / lh, turn)
        return round(fx * fw), round(fy * fh)

    nodes = []
    for el in root.iter("node"):
        a = el.attrib
        flags = [f for f in UI_FLAGS if a.get(f) == "true"]
        if a.get("class", "").endswith("EditText"):
            flags.append("editable")
        if a.get("enabled") == "false":
            flags.append("disabled")
        text, desc = a.get("text", "")[:200], a.get("content-desc", "")[:200]
        rid = a.get("resource-id", "").split(":id/")[-1]
        m = BOUNDS.match(a.get("bounds", ""))
        if not m or not (text or desc or rid or set(flags) & {"clickable", "long-clickable", "scrollable", "editable"}):
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        if x2 <= x1 or y2 <= y1:
            continue
        (ax, ay), (bx, by) = to_frame(x1, y1), to_frame(x2, y2)
        x1, y1, x2, y2 = min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)
        node = {"class": a.get("class", "").rsplit(".", 1)[-1], "bounds": [x1, y1, x2, y2],
                "center": [(x1 + x2) // 2, (y1 + y2) // 2]}
        for k, v in (("text", text), ("description", desc), ("id", rid), ("package", a.get("package"))):
            if v:
                node[k] = v
        if flags:
            node["flags"] = flags
        nodes.append(node)
    return nodes


@api
async def get_ui_tree(emu: Emulator, body: dict, request: web.Request):
    path = f"/data/local/tmp/serve-droid-ui-{uuid.uuid4().hex}.xml"
    out = ""
    for _ in range(3):
        async with UI_DUMP_LOCK:
            out = await adb_shell(f"uiautomator dump {path} >/dev/null 2>&1; cat {path}; rm -f {path}", timeout=20)
        if "<hierarchy" in out:
            break
        await asyncio.sleep(0.5)
    else:
        raise RuntimeError("uiautomator could not dump the screen; try again when it is idle")
    rotation = emu.rotation
    size = emu.display_size(rotation)
    nodes = compact_ui_tree(out[out.index("<?xml") if "<?xml" in out else 0:], emu.lcd, rotation, size)
    return {"screenWidth": size[0], "screenHeight": size[1], "nodes": nodes}


@api
async def get_logcat(emu: Emulator, body: dict, request: web.Request):
    q = request.query
    count = max(1, min(2000, int(q.get("lines", 200))))
    level = q.get("level", "V").upper()[:1]
    if level not in LOGCAT_LEVELS:
        raise ValueError(f"level must be one of {LOGCAT_LEVELS}")
    pids = None
    if q.get("package"):
        pids = {int(p) for p in (await adb_shell(f"pidof {shlex.quote(q['package'])}; true", timeout=10)).split()
                if p.isdigit()}
    text = q.get("text", "").lower()
    out = await adb("logcat", "-d", "-v", "threadtime", "-t", str(count if pids is None and not text else 5000),
                    timeout=20)
    lines = []
    for raw in out.splitlines():
        e = parse_logcat(raw)
        if not e or LOGCAT_LEVELS.index(e[3]) < LOGCAT_LEVELS.index(level):
            continue
        if pids is not None and e[1] not in pids:
            continue
        if text and text not in e[4].lower() and text not in e[5].lower():
            continue
        lines.append({"time": e[0], "pid": e[1], "level": e[3], "tag": e[4], "message": e[5]})
    return {"lines": lines[-count:]}


async def logcat_socket(request: web.Request) -> web.WebSocketResponse:
    if cross_site(request):
        raise web.HTTPForbidden()
    hub: Logcat = request.app["logcat"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    await hub.subscribe(ws)
    try:
        async for _ in ws:
            pass
    finally:
        hub.unsubscribe(ws)
    return ws


async def socket(request: web.Request) -> web.WebSocketResponse:
    if cross_site(request):
        raise web.HTTPForbidden()
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
    emu = Emulator(*app["emu_args"], metadata=app["metadata"])
    app["emu"] = emu
    app["logcat"] = Logcat()
    app["tasks"] = [asyncio.create_task(emu.pump_frames()), asyncio.create_task(emu.pump_clipboard())]


def main(metadata=None, wait_for_frame=False, serial=None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grpc", default=os.environ.get("EMULATOR_GRPC", "localhost:8554"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEB_UI_PORT", "6090")))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--label", default=os.environ.get("EMULATOR_DEVICE", ""))
    args = parser.parse_args()

    app = web.Application(client_max_size=MAX_APK_BYTES)
    app["emu_args"] = (args.grpc, args.label)
    app["metadata"] = metadata
    app["serial"] = serial
    app.on_startup.append(start_background)
    if wait_for_frame:
        async def ready(app):
            emu = app["emu"]
            async with emu.frame_ready:
                try:
                    await asyncio.wait_for(emu.frame_ready.wait_for(lambda: emu.frame is not None), 45)
                except asyncio.TimeoutError:
                    raise RuntimeError("Timed out waiting for the first emulator frame.")
        app.on_startup.append(ready)
    app.add_routes([
        web.get("/", index), web.get("/info", info), web.get("/screenshot", screenshot), web.get("/ws", socket),
        web.get("/api/state", get_state), web.get("/api/foreground", get_foreground),
        web.get("/logcat", logcat_socket),
        web.post("/api/clipboard", post_clipboard), web.post("/api/open-url", post_open_url),
        web.post("/api/appearance", post_appearance), web.post("/api/battery", post_battery),
        web.post("/api/location", post_location), web.post("/api/install", post_install),
        web.get("/api/frame", get_frame), web.get("/api/ui-tree", get_ui_tree), web.get("/api/logcat", get_logcat),
        web.post("/api/tap", post_tap), web.post("/api/swipe", post_swipe), web.post("/api/key", post_key),
        web.post("/api/text", post_text), web.post("/api/rotate", post_rotate),
    ])
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
