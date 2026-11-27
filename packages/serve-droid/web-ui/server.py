#!/usr/bin/env python3
"""Browser UI for the Android emulator, driven by the emulator's gRPC API."""
import argparse
import asyncio
import base64
import glob
import hmac
import io
import json
import logging
import os
import re
import shlex
import sys
import tempfile
import time
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
import video  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_EDGE = int(os.environ.get("WEB_UI_MAX_EDGE", "1280"))
JPEG_QUALITY = int(os.environ.get("WEB_UI_JPEG_QUALITY", "80"))
IDLE_EDGE = 64
MAX_APK_BYTES = 512 << 20
WEB_UI_TOKEN = os.environ.get("WEB_UI_TOKEN", "")
TOKEN_COOKIE = "serve_droid_token"

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


MAX_SHELL_OUTPUT = 1 << 20


async def adb_shell_status(command: str, timeout: float = 30):
    """Run a shell command and return its combined output and exit code instead of raising on failure."""
    proc = await asyncio.create_subprocess_exec(
        "adb", "shell", command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"shell command timed out after {timeout:g} s")
    return out[:MAX_SHELL_OUTPUT].decode(errors="replace"), proc.returncode


class EventLog:
    """Ring buffer of agent and viewer actions, pushed to every viewer as it happens."""

    def __init__(self, emu: "Emulator", size: int = 1000) -> None:
        self.emu = emu
        self.ring = deque(maxlen=size)
        self.next_id = 1

    def add(self, source: str, action: str, params: dict, ok: bool = True, error: str = None) -> dict:
        event = {"id": self.next_id, "time": int(time.time() * 1000), "source": source, "action": action,
                 "params": params, "ok": ok}
        if error:
            event["error"] = error
        self.next_id += 1
        self.ring.append(event)
        if self.emu.sockets:
            asyncio.get_running_loop().create_task(self.emu.broadcast({"t": "event", "event": event}))
        return event

    def recent(self, limit: int) -> list:
        return list(self.ring)[-limit:] if limit else []


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
        self.frame_full = False
        self.stream_full = False
        self.restream = asyncio.Event()
        self.frame_ready = asyncio.Condition()
        self.jpeg = None
        self.jpeg_lock = asyncio.Lock()
        self.connected = asyncio.Event()
        self.clipboard = None
        self.sockets = set()
        self.jpeg_viewers = set()
        self.video = video.VideoCapture(self.display_size)
        self.events = EventLog(self)

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
            release, sdk, model = (await adb_shell(
                "getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.model",
                timeout=10)).splitlines()[:3]
            self.details.update({"android": release.strip(), "api": sdk.strip(), "model": model.strip() or None})
        except (RuntimeError, ValueError, FileNotFoundError) as e:
            logger.info(f"build props unavailable: {e}")
            self.details.update({"android": os.environ.get("EMULATOR_ANDROID_VERSION"),
                                 "api": os.environ.get("EMULATOR_API_LEVEL")})

    @staticmethod
    def encode(img: "pb.Image", edge: int = 0, quality: int = JPEG_QUALITY):
        """JPEG-encode a raw RGB frame, shrunk so its longest side is at most `edge` when given."""
        im = Image.frombuffer("RGB", (img.format.width, img.format.height), img.image, "raw", "RGB", 0, 1)
        if edge and max(im.size) > edge:
            im = im.copy()
            im.thumbnail((edge, edge))
        out = io.BytesIO()
        im.save(out, "JPEG", quality=quality)
        return out.getvalue(), im.width, im.height

    async def viewer_frame(self):
        """The latest frame as (jpeg, width, height, rotation), encoded at most once per frame for all viewers."""
        async with self.jpeg_lock:
            seq, (img, rotation) = self.frame_seq, self.frame
            if not self.jpeg or self.jpeg[0] != seq:
                jpeg, w, h = await asyncio.get_running_loop().run_in_executor(None, self.encode, img)
                self.jpeg = (seq, (jpeg, w, h, rotation))
            return self.jpeg[1]

    def viewers_changed(self) -> None:
        """Call after adding or removing a viewer socket, so the screen stream can switch size."""
        if bool(self.jpeg_viewers) != self.stream_full:
            self.restream.set()

    async def stream(self, full: bool) -> None:
        edge = min(MAX_EDGE, max(self.lcd)) if full else IDLE_EDGE
        fmt = pb.ImageFormat(format=pb.ImageFormat.RGB888, width=edge, height=edge)
        async for img in self.stub.streamScreenshot(fmt, metadata=self.metadata("streamScreenshot")):
            async with self.frame_ready:
                rotation = int(img.format.rotation.rotation)
                if rotation != self.rotation:
                    self.rotation = rotation
                    self.video.restart()
                self.frame = (img, self.rotation)
                self.frame_full = full
                self.frame_seq += 1
                self.frame_ready.notify_all()

    async def pump_frames(self) -> None:
        """Keep the latest raw frame; encode only when a viewer or an API call asks for it.

        With no JPEG viewer the stream is a tiny thumbnail that only tracks rotation, so a changing
        screen costs almost nothing. The first JPEG viewer switches it to full size. H.264 viewers
        get their frames from screenrecord (video.py) and leave the stream at thumbnail size.
        """
        while True:
            await self.connect()
            try:
                while True:
                    self.restream.clear()
                    self.stream_full = bool(self.jpeg_viewers)
                    reader = asyncio.create_task(self.stream(self.stream_full))
                    switch = asyncio.create_task(self.restream.wait())
                    await asyncio.wait({reader, switch}, return_when=asyncio.FIRST_COMPLETED)
                    switch.cancel()
                    if reader.done():
                        reader.result()
                        logger.warning("screen stream ended")
                        break
                    reader.cancel()
                    await asyncio.gather(reader, return_exceptions=True)
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
                self.viewers_changed()

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

    def panel_touch(self, x: float, y: float, down: bool, pointer: int = 0) -> "pb.Touch":
        """A gRPC touch for a normalized point on the current frame. Pointer 0–9 maps to identifier 1–10."""
        w, h = self.lcd
        px, py = to_panel(x, y, self.rotation)
        return pb.Touch(x=round(px * (w - 1)), y=round(py * (h - 1)), identifier=pointer + 1,
                        pressure=1 if down else 0)

    async def touch(self, x: float, y: float, down: bool, strict: bool = False, pointer: int = 0) -> None:
        await self.send("sendTouch", pb.TouchEvent(touches=[self.panel_touch(x, y, down, pointer)]), strict)

    async def touches(self, points, down: bool, strict: bool = True) -> None:
        """Send several pointers in one event: points = [(x, y, pointer)], normalized."""
        await self.send("sendTouch", pb.TouchEvent(
            touches=[self.panel_touch(x, y, down, p) for x, y, p in points]), strict)

    def dp(self) -> float:
        """Screen pixels per density-independent pixel."""
        try:
            return max(0.75, int(self.details.get("density") or 160) / 160)
        except ValueError:
            return 1.0

    def display_size(self, rotation=None):
        w, h = self.lcd
        return (h, w) if (self.rotation if rotation is None else rotation) % 2 else (w, h)

    async def key(self, key: str, strict: bool = False) -> None:
        await self.send("sendKey", pb.KeyboardEvent(eventType=pb.KeyboardEvent.keypress, key=key), strict)

    async def text(self, text: str, strict: bool = False) -> None:
        await self.send("sendKey", pb.KeyboardEvent(text=text), strict)

    async def rotate(self, strict: bool = False) -> None:
        # Toggle portrait and landscape only: the Android images ignore 180°, which leaves the device and frames out of step.
        angle = 0 if self.rotation % 2 else 90
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


async def tools_manifest(request: web.Request) -> web.FileResponse:
    return web.FileResponse(os.path.join(HERE, "tools.json"), headers={"Cache-Control": "no-cache"})


def token_matches(value) -> bool:
    return bool(value) and hmac.compare_digest(value.encode(), WEB_UI_TOKEN.encode())


@web.middleware
async def require_token(request: web.Request, handler):
    """With WEB_UI_TOKEN set, every request needs the bearer header or the cookie set by `/?token=`."""
    if not WEB_UI_TOKEN:
        return await handler(request)
    header = request.headers.get("Authorization", "")
    if token_matches(header[7:] if header.startswith("Bearer ") else "") \
            or token_matches(request.cookies.get(TOKEN_COOKIE)):
        return await handler(request)
    if request.method == "GET" and request.path == "/" and token_matches(request.query.get("token")):
        response = web.Response(status=302, headers={"Location": "./", "Cache-Control": "no-store"})
        response.set_cookie(TOKEN_COOKIE, WEB_UI_TOKEN, httponly=True, samesite="Strict", path="/")
        return response
    if request.path.startswith("/api/"):
        return web.json_response({"ok": False, "error": "unauthorized: missing or wrong token"}, status=401)
    return web.Response(status=401, text="Unauthorized. Open the URL with ?token=<token>, as printed by serve-droid.")


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


class NotFound(Exception):
    """No UI element matched a selector."""


# POST endpoints that only read; they stay out of the event log.
READ_ACTIONS = {"find", "wait"}


def event_params(action: str, body, request: web.Request):
    """The request body as logged: no APK bytes, no long clipboard text. None skips the event."""
    if action in READ_ACTIONS:
        return None
    if action in ("network", "accessibility") and not body:
        return None
    if action == "snapshots" and isinstance(body, dict) and body.get("action") == "list":
        return None
    if action == "install":
        return {"bytes": request.content_length}
    params = dict(body) if isinstance(body, dict) else {}
    if action == "clipboard" and len(str(params.get("text", ""))) > 200:
        params["text"] = str(params["text"])[:200]
        params["truncated"] = True
    return params


def api(handler):
    async def wrapped(request: web.Request) -> web.Response:
        if request.method != "GET" and cross_site(request):
            return web.json_response({"ok": False, "error": "cross-site request refused"}, status=403)
        emu: Emulator = request.app["emu"]
        body, status = {}, 200
        try:
            body = await request.json() if request.method == "POST" and request.can_read_body \
                and request.content_type == "application/json" else {}
            result = await handler(emu, body, request)
            payload = {"ok": True, **(result or {})}
        except (ValueError, KeyError, TypeError) as e:
            payload, status = {"ok": False, "error": f"bad request: {e}"}, 400
        except NotFound as e:
            payload, status = {"ok": False, "error": str(e)}, 404
        except (grpc.aio.AioRpcError, RuntimeError, FileNotFoundError) as e:
            detail = e.details() if isinstance(e, grpc.aio.AioRpcError) else str(e)
            payload, status = {"ok": False, "error": detail}, 502
        if request.method == "POST":
            action = request.path.rsplit("/api/", 1)[-1]
            params = event_params(action, body, request)
            if params is not None:
                emu.events.add("api", action, params, payload["ok"], payload.get("error"))
        return web.json_response(payload, status=status)
    return wrapped


async def device_state(emu: Emulator) -> dict:
    async def dark():
        return (await adb_shell("cmd uimode night", timeout=10)).strip().endswith("yes")

    names = ("dark", "battery", "location")
    results = await asyncio.gather(dark(), emu.battery(), emu.location(), return_exceptions=True)
    state = {n: (None if isinstance(r, Exception) else r) for n, r in zip(names, results)}
    return {**state, "clipboard": emu.clipboard or ""}


@api
async def get_state(emu: Emulator, body: dict, request: web.Request):
    return await device_state(emu)


@api
async def get_device_info(emu: Emulator, body: dict, request: web.Request):
    state, fg = await asyncio.gather(device_state(emu), foreground(), return_exceptions=True)
    w, h = emu.display_size()
    d = emu.details
    density = d.get("density")
    return {"label": emu.label, "model": d.get("model"), "android": d.get("android"), "api": d.get("api"),
            "screenWidth": w, "screenHeight": h, "density": int(density) if str(density).isdigit() else density,
            "foreground": None if isinstance(fg, Exception) else fg["package"],
            **({} if isinstance(state, Exception) else state), "emulator": d.get("emulator")}


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
    return await foreground()


async def foreground() -> dict:
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


SELECTOR_KEYS = ("text", "id", "desc", "class")


def has_selector(body: dict) -> bool:
    return any(body.get(k) not in (None, "") for k in SELECTOR_KEYS)


def selector_matcher(body: dict):
    """Build a node predicate from a selector (spec 6.1). Raises ValueError when it has no criteria."""
    if not has_selector(body):
        raise ValueError("selector needs at least one of text, id, desc or class")
    exact = bool(body.get("exact", False))

    def same(value, want) -> bool:
        if value is None:
            return False
        return value == want if exact else want.lower() in value.lower()

    text, rid, desc, cls = (None if body.get(k) in (None, "") else str(body[k]) for k in SELECTOR_KEYS)
    if rid and ":id/" in rid:
        rid = rid.split(":id/")[-1]
    if cls and "." in cls:
        cls = cls.rsplit(".", 1)[-1]

    def match(node: dict) -> bool:
        return ((text is None or same(node.get("text"), text) or same(node.get("description"), text))
                and (rid is None or same(node.get("id"), rid))
                and (desc is None or same(node.get("description"), desc))
                and (cls is None or same(node.get("class"), cls)))
    return match


def describe_selector(body: dict) -> str:
    return ", ".join(f"{k}={body[k]!r}" for k in SELECTOR_KEYS if body.get(k) not in (None, ""))


async def find_nodes(emu: Emulator, body: dict):
    match = selector_matcher(body)
    tree = await ui_tree(emu)
    return [n for n in tree["nodes"] if match(n)], tree


def pick(matches: list, body: dict):
    index = int(body.get("index", 0))
    if index < 0:
        raise ValueError("index must be 0 or more")
    return matches[index] if index < len(matches) else None


async def press(emu: Emulator, x: float, y: float, hold_ms: int) -> None:
    await emu.touch(x, y, True, strict=True)
    await asyncio.sleep(hold_ms / 1000)
    await emu.touch(x, y, False, strict=True)


@api
async def post_tap(emu: Emulator, body: dict, request: web.Request):
    hold = max(40, min(5000, int(body.get("duration_ms", 60))))
    node = None
    if has_selector(body):
        matches, _ = await find_nodes(emu, body)
        node = pick(matches, body)
        if not node:
            raise NotFound(f"no element matches {describe_selector(body)}"
                           + (f" at index {body.get('index')}" if matches else ""))
        px, py = node["center"]
    else:
        px, py = body["x"], body["y"]
    x, y = device_point(emu, px, py)
    await press(emu, x, y, hold)
    return {"x": px, "y": py, **({"node": node} if node else {})}


@api
async def post_find(emu: Emulator, body: dict, request: web.Request):
    matches, tree = await find_nodes(emu, body)
    return {"matches": matches, "total": len(matches),
            "screenWidth": tree["screenWidth"], "screenHeight": tree["screenHeight"]}


@api
async def post_wait(emu: Emulator, body: dict, request: web.Request):
    match = selector_matcher(body)
    timeout = max(0, min(60000, int(body.get("timeout_ms", 10000))))
    interval = max(100, min(10000, int(body.get("interval_ms", 500))))
    gone = bool(body.get("gone", False))
    start = time.monotonic()
    attempts, node, error = 0, None, None
    while True:
        attempts += 1
        try:
            node = pick([n for n in (await ui_tree(emu))["nodes"] if match(n)], body)
            error = None
            if (node is None) == gone:
                elapsed = round((time.monotonic() - start) * 1000)
                return {"found": True, "elapsed_ms": elapsed, "attempts": attempts, **({"node": node} if node else {})}
        except RuntimeError as e:
            error = str(e)
        elapsed = (time.monotonic() - start) * 1000
        if elapsed + interval > timeout:
            result = {"found": False, "elapsed_ms": round(elapsed), "attempts": attempts}
            if node:
                result["node"] = node
            if error:
                result["error"] = error
            return result
        await asyncio.sleep(interval / 1000)


def clamp_point(emu: Emulator, x: float, y: float):
    w, h = emu.display_size()
    return min(max(x, 0), w - 1), min(max(y, 0), h - 1)


async def pinch(emu: Emulator, cx: float, cy: float, scale: float, duration_ms: int) -> None:
    """Two fingers along the horizontal axis through (cx, cy), from distance d0 to d0 * scale."""
    w, h = emu.display_size()
    big = min(w, h) * 0.6
    d0, d1 = (big / scale, big) if scale >= 1 else (big, big * scale)
    steps = max(4, duration_ms // 16)

    def points(d):
        a = clamp_point(emu, cx - d / 2, cy)
        b = clamp_point(emu, cx + d / 2, cy)
        return [(a[0] / (w - 1), a[1] / (h - 1), 1), (b[0] / (w - 1), b[1] / (h - 1), 2)]

    for i in range(steps + 1):
        await emu.touches(points(d0 + (d1 - d0) * i / steps), True)
        await asyncio.sleep(duration_ms / 1000 / steps)
    await asyncio.sleep(0.12)
    await emu.touches(points(d1), False)


async def drag(emu: Emulator, x1, y1, x2, y2, duration_ms: int, settle_ms: int = 0) -> None:
    """Touch, move and lift in screen pixels. `settle_ms` holds still before lifting, so lists do not fling."""
    w, h = emu.display_size()
    steps = max(2, duration_ms // 16)
    for i in range(steps + 1):
        t = i / steps
        await emu.touch((x1 + (x2 - x1) * t) / (w - 1), (y1 + (y2 - y1) * t) / (h - 1), True, strict=True)
        await asyncio.sleep(duration_ms / 1000 / steps)
    if settle_ms:
        await asyncio.sleep(settle_ms / 1000)
    await emu.touch(x2 / (w - 1), y2 / (h - 1), False, strict=True)


async def scroll(emu: Emulator, x: float, y: float, dx: float, dy: float) -> None:
    """Scroll content by (dx, dy) pixels like a mouse wheel: +dy reveals content further down.

    The finger moves the other way. Long scrolls split into several drags; each adds the touch slop
    that Android eats before a scroll starts, and settles before lifting so the list does not fling.
    """
    w, h = emu.display_size()
    slop = 8 * emu.dp()
    remaining = [float(dx), float(dy)]
    limit = (w * 0.7, h * 0.7)
    for _ in range(20):
        if abs(remaining[0]) < 1 and abs(remaining[1]) < 1:
            break
        step = [max(-limit[i], min(limit[i], remaining[i])) for i in (0, 1)]
        remaining = [remaining[i] - step[i] for i in (0, 1)]
        length = (step[0] ** 2 + step[1] ** 2) ** 0.5
        ux, uy = step[0] / length, step[1] / length
        mx, my = step[0] + ux * slop, step[1] + uy * slop
        sx, sy = clamp_point(emu, x + mx / 2, y + my / 2)
        ex, ey = clamp_point(emu, sx - mx, sy - my)
        await drag(emu, sx, sy, ex, ey, int(max(120, min(500, length / 2))), settle_ms=120)


@api
async def post_pinch(emu: Emulator, body: dict, request: web.Request):
    w, h = emu.display_size()
    x, y = float(body.get("x", w / 2)), float(body.get("y", h / 2))
    device_point(emu, x, y)
    scale = float(body["scale"])
    if not 0.2 <= scale <= 5:
        raise ValueError("scale must be between 0.2 and 5")
    await pinch(emu, x, y, scale, max(100, min(5000, int(body.get("duration_ms", 400)))))


@api
async def post_scroll(emu: Emulator, body: dict, request: web.Request):
    w, h = emu.display_size()
    x, y = float(body.get("x", w / 2)), float(body.get("y", h / 2))
    device_point(emu, x, y)
    dx, dy = float(body.get("dx", 0)), float(body.get("dy", 0))
    if not (dx or dy):
        raise ValueError("dx or dy must be non-zero")
    await scroll(emu, x, y, dx, dy)


@api
async def post_shell(emu: Emulator, body: dict, request: web.Request):
    command = str(body["command"]).strip()
    if not command:
        raise ValueError("command is empty")
    timeout = max(1000, min(300000, int(body.get("timeout_ms", 30000))))
    output, code = await adb_shell_status(command, timeout / 1000)
    return {"output": output, "exit_code": code}


@api
async def get_events(emu: Emulator, body: dict, request: web.Request):
    limit = max(0, min(1000, int(request.query.get("limit", 200))))
    events = emu.events.recent(limit)
    after = request.query.get("after")
    if after is not None:
        events = [e for e in events if e["id"] > int(after)]
    return {"events": events}


@api
async def get_events_script(emu: Emulator, body: dict, request: web.Request):
    events = [e for e in emu.events.ring if e["ok"]]
    t0 = events[0]["time"] if events else 0
    w, h = emu.display_size()
    device = {"label": emu.label, "model": emu.details.get("model"), "android": emu.details.get("android"),
              "screenWidth": w, "screenHeight": h}
    return {"version": 1, "device": device,
            "steps": [script_step(e["time"] - t0, e["action"], e["params"]) for e in events]}


def script_step(t: int, action: str, params: dict) -> dict:
    """Params sit beside `t` and `action`, or under `params` when a name collides (api/app has `action`)."""
    if {"t", "action", "params"} & params.keys():
        return {"t": t, "action": action, "params": params}
    return {"t": t, "action": action, **params}


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
    img, rotation = emu.frame
    edge = max(160, min(MAX_EDGE, int(request.query.get("max_edge", 768))))
    if not emu.frame_full:
        img = await emu.call("getScreenshot", pb.ImageFormat(format=pb.ImageFormat.RGB888, width=edge, height=edge),
                             timeout=10)
        rotation = int(img.format.rotation.rotation)
    jpeg, w, h = await asyncio.get_running_loop().run_in_executor(None, emu.encode, img, edge, 70)
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
    return await ui_tree(emu)


async def ui_tree(emu: Emulator) -> dict:
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


class GestureRecorder:
    """Collapse one viewer's raw touches into replayable events: tap, swipe, or pinch for two fingers."""

    def __init__(self, emu: Emulator) -> None:
        self.emu = emu
        self.down = {}
        self.done = {}
        self.start = 0.0

    def touch(self, pointer: int, x: float, y: float, down: bool) -> None:
        w, h = self.emu.display_size()
        p = (round(x * (w - 1)), round(y * (h - 1)))
        if down:
            if pointer in self.down:
                self.down[pointer][1] = p
                return
            if not self.down:
                self.start, self.done = time.monotonic(), {}
            self.down[pointer] = [p, p]
            return
        stroke = self.down.pop(pointer, None)
        if stroke is None:
            return
        stroke[1] = p
        self.done[pointer] = stroke
        if not self.down:
            self.finish(round((time.monotonic() - self.start) * 1000))

    def finish(self, duration: int) -> None:
        strokes = list(self.done.values())
        self.done = {}
        if len(strokes) >= 2:
            (a0, a1), (b0, b1) = strokes[:2]
            d0 = ((a0[0] - b0[0]) ** 2 + (a0[1] - b0[1]) ** 2) ** 0.5
            d1 = ((a1[0] - b1[0]) ** 2 + (a1[1] - b1[1]) ** 2) ** 0.5
            scale = max(0.2, min(5.0, d1 / d0)) if d0 else 1.0
            self.emu.events.add("ui", "pinch", {"x": (a0[0] + b0[0]) // 2, "y": (a0[1] + b0[1]) // 2,
                                                "scale": round(scale, 2), "duration_ms": max(100, duration)})
            return
        (x1, y1), (x2, y2) = strokes[0]
        w, h = self.emu.display_size()
        if abs(x2 - x1) + abs(y2 - y1) <= max(12, 0.015 * min(w, h)):
            self.emu.events.add("ui", "tap", {"x": x1, "y": y1, "duration_ms": max(40, min(5000, duration))})
        else:
            self.emu.events.add("ui", "swipe", {"x1": x1, "y1": y1, "x2": x2, "y2": y2,
                                                "duration_ms": max(50, min(5000, duration))})


class Wheel:
    """Batch a burst of wheel deltas from a viewer into scroll gestures, one at a time."""

    def __init__(self, emu: Emulator) -> None:
        self.emu = emu
        self.pending = None
        self.task = None

    def add(self, x: float, y: float, dx: float, dy: float) -> None:
        w, h = self.emu.display_size()
        scale = self.emu.dp()
        px, py = x * (w - 1), y * (h - 1)
        if self.pending:
            self.pending[2] += dx * scale
            self.pending[3] += dy * scale
        else:
            self.pending = [px, py, dx * scale, dy * scale]
        if not self.task or self.task.done():
            self.task = asyncio.create_task(self.run())

    async def run(self) -> None:
        while self.pending:
            await asyncio.sleep(0.08)
            x, y, dx, dy = self.pending
            self.pending = None
            if abs(dx) < 1 and abs(dy) < 1:
                continue
            params = {"x": round(x), "y": round(y), "dx": round(dx), "dy": round(dy)}
            try:
                await scroll(self.emu, x, y, dx, dy)
                self.emu.events.add("ui", "scroll", params)
            except (grpc.aio.AioRpcError, RuntimeError) as e:
                logger.warning(f"wheel scroll failed: {e}")

    def cancel(self) -> None:
        if self.task:
            self.task.cancel()


async def seed_jpeg(emu: Emulator) -> bytes:
    """A still for an H.264 viewer to paint before its first keyframe decodes."""
    edge = min(MAX_EDGE, max(emu.lcd))
    img = emu.frame[0] if emu.frame and emu.frame_full else await emu.call(
        "getScreenshot", pb.ImageFormat(format=pb.ImageFormat.RGB888, width=edge, height=edge), timeout=10)
    jpeg, _, _ = await asyncio.get_running_loop().run_in_executor(None, emu.encode, img, edge)
    return jpeg


async def socket(request: web.Request) -> web.WebSocketResponse:
    """Viewer socket. `?codec=h264` asks for H.264 (video.py); else, or when it is unavailable, JPEG frames.

    The first message says which: `{t:"codec", codec:"h264"|"jpeg"}`. It can switch to jpeg later if
    screenrecord fails. Binary messages are a JPEG per frame, or `[tag][payload]` for H.264.
    """
    if cross_site(request):
        raise web.HTTPForbidden()
    emu: Emulator = request.app["emu"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    emu.sockets.add(ws)
    gestures, wheel = GestureRecorder(emu), Wheel(emu)
    h264 = request.query.get("codec") == "h264" and emu.video.available()

    async def send_frames():
        emu.jpeg_viewers.add(ws)
        emu.viewers_changed()
        await ws.send_str(json.dumps({"t": "codec", "codec": "jpeg"}))
        seq, meta = -1, None
        while not ws.closed:
            async with emu.frame_ready:
                await emu.frame_ready.wait_for(lambda: emu.frame_seq != seq and emu.frame_full)
                seq = emu.frame_seq
            jpeg, w, h, rot = await emu.viewer_frame()
            if meta != (w, h, rot):
                meta = (w, h, rot)
                await ws.send_str(json.dumps({"t": "frame", "w": w, "h": h, "rotation": rot}))
            await ws.send_bytes(jpeg)

    async def send_video():
        await ws.send_str(json.dumps({"t": "codec", "codec": "h264"}))
        viewer = emu.video.subscribe()
        try:
            if not viewer.replayed:
                try:
                    await ws.send_bytes(bytes([video.TAG_SEED]) + await seed_jpeg(emu))
                except (grpc.aio.AioRpcError, RuntimeError, TypeError) as e:
                    logger.info(f"no seed frame: {e}")
            while not ws.closed:
                message = await viewer.queue.get()
                if message is None:
                    break
                await ws.send_bytes(message)
        finally:
            emu.video.unsubscribe(viewer)
        if not ws.closed:
            await send_frames()

    try:
        sender = asyncio.create_task(send_video() if h264 else send_frames())
        if emu.clipboard is not None:
            await ws.send_str(json.dumps({"t": "clipboard", "text": emu.clipboard}))
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                m = json.loads(msg.data)
                kind = m.get("t")
                if kind == "touch":
                    pointer = int(m.get("id") or 0)
                    if not 0 <= pointer <= 9:
                        raise ValueError(f"touch id {pointer} is not 0-9")
                    x, y, down = float(m["x"]), float(m["y"]), bool(m["down"])
                    await emu.touch(x, y, down, pointer=pointer)
                    gestures.touch(pointer, x, y, down)
                elif kind == "wheel":
                    wheel.add(min(max(float(m["x"]), 0), 1), min(max(float(m["y"]), 0), 1),
                              float(m.get("dx", 0)), float(m.get("dy", 0)))
                elif kind == "key":
                    await emu.key(str(m["key"]))
                    emu.events.add("ui", "key", {"key": str(m["key"])})
                elif kind == "text":
                    await emu.text(str(m["text"]))
                    emu.events.add("ui", "text", {"text": str(m["text"])})
                elif kind == "rotate":
                    await emu.rotate()
                    emu.events.add("ui", "rotate", {})
                elif kind == "keyframe":
                    emu.video.request_keyframe()
            except (ValueError, KeyError, TypeError, AttributeError) as e:
                logger.warning(f"ignored malformed message: {e}")
    finally:
        emu.sockets.discard(ws)
        emu.jpeg_viewers.discard(ws)
        emu.viewers_changed()
        sender.cancel()
        wheel.cancel()
    return ws


def device_control_routes() -> list:
    """Routes from controls.py (apps, snapshots, telephony, network...), when that module is present.

    Each is (method, path, handler) with handler `async (emu, body, request)`. A route can replace a core one.
    """
    try:
        import controls
    except ImportError as e:
        logger.info(f"device controls unavailable: {e}")
        return []
    return list(getattr(controls, "ROUTES", []))


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

    app = web.Application(client_max_size=MAX_APK_BYTES, middlewares=[require_token])
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
    routes = {
        ("GET", "/"): index, ("GET", "/info"): info, ("GET", "/screenshot"): screenshot, ("GET", "/ws"): socket,
        ("GET", "/tools.json"): tools_manifest, ("GET", "/logcat"): logcat_socket,
        ("GET", "/api/state"): get_state, ("GET", "/api/foreground"): get_foreground,
        ("GET", "/api/device-info"): get_device_info, ("GET", "/api/frame"): get_frame,
        ("GET", "/api/ui-tree"): get_ui_tree, ("GET", "/api/logcat"): get_logcat,
        ("GET", "/api/events"): get_events, ("GET", "/api/events/script"): get_events_script,
        ("POST", "/api/clipboard"): post_clipboard, ("POST", "/api/open-url"): post_open_url,
        ("POST", "/api/appearance"): post_appearance, ("POST", "/api/battery"): post_battery,
        ("POST", "/api/location"): post_location, ("POST", "/api/install"): post_install,
        ("POST", "/api/tap"): post_tap, ("POST", "/api/swipe"): post_swipe, ("POST", "/api/key"): post_key,
        ("POST", "/api/text"): post_text, ("POST", "/api/rotate"): post_rotate,
        ("POST", "/api/find"): post_find, ("POST", "/api/wait"): post_wait, ("POST", "/api/pinch"): post_pinch,
        ("POST", "/api/scroll"): post_scroll, ("POST", "/api/shell"): post_shell,
    }
    for method, path, handler in device_control_routes():
        routes[(method.upper(), "/" + path.lstrip("/"))] = api(handler)
    app.add_routes([web.route(method, path, handler) for (method, path), handler in routes.items()])
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
