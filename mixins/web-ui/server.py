#!/usr/bin/env python3
"""Browser UI for the Android emulator, driven by the emulator's gRPC API."""
import argparse
import asyncio
import glob
import io
import json
import logging
import os
import sys

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


class Emulator:
    def __init__(self, address: str, label: str) -> None:
        self.address = address
        self.label = label or "Android Emulator"
        self.channel = None
        self.stub = None
        self.md = []
        self.lcd = (1080, 1920)
        self.rotation = 0
        self.frame = None
        self.frame_seq = 0
        self.frame_ready = asyncio.Condition()
        self.connected = asyncio.Event()

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
                cfg = {e.key: e.value for e in status.hardwareConfig.entry}
                self.lcd = (int(cfg.get("hw.lcd.width", 1080)), int(cfg.get("hw.lcd.height", 1920)))
                logger.info(f"connected to emulator at {self.address}, panel {self.lcd[0]}x{self.lcd[1]}")
                self.connected.set()
                return
            except grpc.aio.AioRpcError as e:
                logger.info(f"waiting for emulator gRPC ({e.code().name})")
                await asyncio.sleep(2)

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

    async def call(self, method: str, request) -> None:
        if not self.connected.is_set():
            return
        try:
            await getattr(self.stub, method)(request, metadata=self.md, timeout=5)
        except grpc.aio.AioRpcError as e:
            logger.warning(f"{method} failed: {e.code().name}")

    async def touch(self, x: float, y: float, down: bool) -> None:
        w, h = self.lcd
        px, py = to_panel(x, y, self.rotation)
        touch = pb.Touch(x=round(px * (w - 1)), y=round(py * (h - 1)), identifier=1, pressure=1 if down else 0)
        await self.call("sendTouch", pb.TouchEvent(touches=[touch]))

    async def key(self, key: str) -> None:
        await self.call("sendKey", pb.KeyboardEvent(eventType=pb.KeyboardEvent.keypress, key=key))

    async def text(self, text: str) -> None:
        await self.call("sendKey", pb.KeyboardEvent(text=text))

    async def rotate(self) -> None:
        angle = {0: 90, 1: 180, 2: 270, 3: 0}[self.rotation]
        await self.call("setPhysicalModel", pb.PhysicalModelValue(
            target=pb.PhysicalModelValue.ROTATION, value=pb.ParameterValue(data=[0, 0, angle])))

    async def screenshot(self) -> bytes:
        img = await self.stub.getScreenshot(pb.ImageFormat(format=pb.ImageFormat.PNG), metadata=self.md, timeout=10)
        return img.image


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(os.path.join(HERE, "index.html"))


async def info(request: web.Request) -> web.Response:
    emu: Emulator = request.app["emu"]
    w, h = emu.lcd
    return web.json_response({"label": emu.label, "width": w, "height": h})


async def screenshot(request: web.Request) -> web.Response:
    emu: Emulator = request.app["emu"]
    if not emu.connected.is_set():
        raise web.HTTPServiceUnavailable()
    try:
        png = await emu.screenshot()
    except grpc.aio.AioRpcError:
        raise web.HTTPServiceUnavailable()
    return web.Response(body=png, content_type="image/png")


async def socket(request: web.Request) -> web.WebSocketResponse:
    emu: Emulator = request.app["emu"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)

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
        sender.cancel()
    return ws


async def start_background(app: web.Application) -> None:
    app["emu"] = Emulator(*app["emu_args"])
    app["pump"] = asyncio.create_task(app["emu"].pump_frames())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grpc", default=os.environ.get("EMULATOR_GRPC", "localhost:8554"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEB_UI_PORT", "6090")))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--label", default=os.environ.get("EMULATOR_DEVICE", ""))
    args = parser.parse_args()

    app = web.Application()
    app["emu_args"] = (args.grpc, args.label)
    app.on_startup.append(start_background)
    app.add_routes([web.get("/", index), web.get("/info", info),
                    web.get("/screenshot", screenshot), web.get("/ws", socket)])
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
