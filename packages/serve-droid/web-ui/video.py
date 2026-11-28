"""H.264 screen video from `adb exec-out screenrecord`, re-framed for WebCodecs.

screenrecord writes an Annex B stream (NAL units after 00 00 01 start codes). The browser's
`VideoDecoder` wants AVCC: an avcC config built from SPS + PPS, then each frame as 4-byte
length-prefixed NAL units. Each WebSocket binary message is `[tag:u8][payload]`:

    0x01 config  avcC record (configures the decoder; sent again when it changes)
    0x02 key     IDR access unit
    0x03 delta   non-IDR access unit
    0x04 seed    JPEG still, painted on join before the first keyframe decodes

screenrecord stops after 180 s, only emits frames when the screen changes and does not
follow rotation. So the capture restarts on exit and on rotation, and caches the current
GOP so a late joiner can paint at once.

Design ported from serve-avd `src/h264.ts` and `src/capture.ts`
(https://github.com/hsandhu/serve-avd, Apache-2.0).
"""
import asyncio
import logging
import os
import time

logger = logging.getLogger("web_ui.video")

TAG_CONFIG, TAG_KEY, TAG_DELTA, TAG_SEED = 1, 2, 3, 4
NAL_SLICE, NAL_IDR, NAL_SEI, NAL_SPS, NAL_PPS, NAL_AUD = 1, 5, 6, 7, 8, 9

BITRATE = int(float(os.environ.get("WEB_UI_H264_BITRATE", "4")) * 1_000_000)
SIZE_CAPS = (1280, 720)
GOP_MAX_FRAMES = 900
GOP_MAX_BYTES = 48 << 20
JOIN_REPLAY_MAX_FRAMES = 30
JOIN_REPLAY_MAX_BYTES = 2 << 20
KEYFRAME_MIN_INTERVAL = 3.0
SETTLE = 0.02
FAST_EXIT = 2.0
FAST_EXIT_LIMIT = 3


def fit(width: int, height: int, cap: int) -> str:
    """screenrecord size for a display, longest side at most `cap`, both sides even."""
    scale = min(1, cap / max(width, height))
    return "%dx%d" % tuple(max(2, round(v * scale / 2) * 2) for v in (width, height))


def avcc_config(sps: bytes, pps: bytes) -> bytes:
    """AVCDecoderConfigurationRecord with one SPS, one PPS and 4-byte NAL lengths."""
    return (bytes([1, sps[1], sps[2], sps[3], 0xFF, 0xE1]) + len(sps).to_bytes(2, "big") + sps
            + b"\x01" + len(pps).to_bytes(2, "big") + pps)


START_CODE = b"\x00\x00\x00\x01"


def annexb_config(config: bytes) -> bytes:
    """SPS and PPS from an avcC record (as built by avcc_config), each after a start code."""
    sps_len = int.from_bytes(config[6:8], "big")
    sps = config[8:8 + sps_len]
    at = 8 + sps_len + 1
    pps = config[at + 2:at + 2 + int.from_bytes(config[at:at + 2], "big")]
    return START_CODE + sps + START_CODE + pps


def annexb_frame(payload: bytes) -> bytes:
    """4-byte length-prefixed NAL units to start-code-prefixed ones."""
    out, at = bytearray(), 0
    while at + 4 <= len(payload):
        size = int.from_bytes(payload[at:at + 4], "big")
        out += START_CODE + payload[at + 4:at + 4 + size]
        at += 4 + size
    return bytes(out)


def codec_string(config: bytes) -> str:
    return "avc1.%02x%02x%02x" % (config[1], config[2], config[3])


async def stop_device_process(pid: int) -> None:
    """Killing `adb exec-out` leaves screenrecord running on the device until it next writes; stop it now."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "adb", "shell", f"kill {pid}", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await asyncio.wait_for(proc.wait(), 5)
    except (OSError, asyncio.TimeoutError) as e:
        logger.info(f"could not stop screenrecord {pid}: {e!r}")


class AnnexB:
    """Incremental Annex B → AVCC access units. Feed chunks, get `(tag, payload)` messages."""

    def __init__(self) -> None:
        self.buf = b""
        self.start = -1
        self.scan = 0
        self.sps = self.pps = None
        self.config = None
        self.unit = []
        self.unit_key = False

    @property
    def pending(self) -> bool:
        return bool(self.unit) or (self.start >= 0 and len(self.buf) > self.start)

    def push(self, chunk: bytes) -> list:
        buf = self.buf + chunk
        nals, i = [], self.scan
        while True:
            i = buf.find(b"\x00\x00\x01", i)
            if i < 0:
                break
            end = i - 1 if i > 0 and buf[i - 1] == 0 else i
            if self.start >= 0 and end > self.start:
                nals.append(buf[self.start:end])
            self.start = i = i + 3
        keep = self.start if self.start >= 0 else max(0, len(buf) - 3)
        self.buf = buf[keep:]
        self.start = 0 if self.start >= 0 else -1
        self.scan = max(0, len(self.buf) - 3)
        return self.handle(nals)

    def flush(self) -> list:
        """Emit what is buffered. screenrecord goes quiet after a whole frame, so a short pause means it is complete."""
        nals = [self.buf[self.start:]] if self.start >= 0 and len(self.buf) > self.start else []
        self.buf, self.start, self.scan = b"", -1, 0
        return self.handle(nals) + self.end_unit()

    def end_unit(self) -> list:
        if not self.unit:
            return []
        payload = b"".join(len(n).to_bytes(4, "big") + n for n in self.unit)
        tag = TAG_KEY if self.unit_key else TAG_DELTA
        self.unit, self.unit_key = [], False
        return [(tag, payload)]

    def handle(self, nals: list) -> list:
        out = []
        for nal in nals:
            kind = nal[0] & 0x1F
            if kind in (NAL_SLICE, NAL_IDR):
                if self.unit and len(nal) > 1 and nal[1] & 0x80:
                    out += self.end_unit()
                if not self.unit and self.sps and self.pps:
                    config = avcc_config(self.sps, self.pps)
                    if config != self.config:
                        self.config = config
                        out.append((TAG_CONFIG, config))
                self.unit.append(nal)
                self.unit_key = self.unit_key or kind == NAL_IDR
            elif kind in (NAL_SPS, NAL_PPS, NAL_AUD):
                out += self.end_unit()
                if kind == NAL_SPS:
                    self.sps = nal
                elif kind == NAL_PPS:
                    self.pps = nal
        return out


class Viewer:
    """One H.264 socket's outbox. A viewer that falls behind skips to the next keyframe."""

    MAX_QUEUE = 120

    def __init__(self, video: "VideoCapture") -> None:
        self.video = video
        self.queue = asyncio.Queue()
        self.need_key = True
        self.replayed = False

    def put(self, tag: int, payload: bytes) -> None:
        if tag == TAG_KEY:
            self.need_key = False
        elif tag == TAG_DELTA and self.need_key:
            return
        if self.queue.qsize() >= self.MAX_QUEUE and tag != TAG_CONFIG:
            while not self.queue.empty():
                self.queue.get_nowait()
            config = self.video.config
            if config:
                self.queue.put_nowait(bytes([TAG_CONFIG]) + config)
            if tag != TAG_KEY:
                self.need_key = True
                self.video.request_keyframe()
                return
        self.queue.put_nowait(bytes([tag]) + payload)


class VideoCapture:
    """One screenrecord session per device, running while any H.264 viewer is connected."""

    def __init__(self, display_size) -> None:
        self.display_size = display_size
        self.viewers = set()
        self.task = None
        self.proc = None
        self.config = None
        self.size = None
        self.gop = []
        self.gop_bytes = 0
        self.cap = 0
        self.unavailable = None
        self.failed_at = 0.0
        self.last_restart = 0.0
        self.restart_timer = None

    def available(self) -> bool:
        """False for a minute after screenrecord failed (the device may still be booting)."""
        return not self.unavailable or time.monotonic() - self.failed_at > 60

    def subscribe(self) -> Viewer:
        viewer = Viewer(self)
        self.viewers.add(viewer)
        viewer.replayed = bool(self.config and self.gop and len(self.gop) <= JOIN_REPLAY_MAX_FRAMES
                               and self.gop_bytes <= JOIN_REPLAY_MAX_BYTES)
        if viewer.replayed:
            viewer.put(TAG_CONFIG, self.config)
            for tag, payload in self.gop:
                viewer.put(tag, payload)
        elif self.config:
            viewer.put(TAG_CONFIG, self.config)
            self.request_keyframe()
        if not self.task or self.task.done():
            self.unavailable, self.cap = None, 0
            self.task = asyncio.create_task(self.run())
        return viewer

    def unsubscribe(self, viewer: Viewer) -> None:
        self.viewers.discard(viewer)
        if not self.viewers:
            self.kill()
            self.config, self.gop, self.gop_bytes = None, [], 0

    def restart(self) -> None:
        """New session: fresh SPS/PPS and an IDR at the current size and rotation."""
        self.last_restart = time.monotonic()
        if self.restart_timer:
            self.restart_timer.cancel()
            self.restart_timer = None
        self.kill()

    def request_keyframe(self) -> None:
        """Restart soon for a keyframe, at most once per KEYFRAME_MIN_INTERVAL."""
        if not self.proc or self.restart_timer:
            return
        wait = self.last_restart + KEYFRAME_MIN_INTERVAL - time.monotonic()
        if wait <= 0:
            self.restart()
        else:
            self.restart_timer = asyncio.get_running_loop().call_later(wait, self.restart)

    def kill(self) -> None:
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass

    def dispatch(self, messages: list) -> None:
        for tag, payload in messages:
            if tag == TAG_CONFIG:
                self.config = payload
                self.gop, self.gop_bytes = [], 0
            elif tag == TAG_KEY:
                self.gop, self.gop_bytes = [(tag, payload)], len(payload)
            elif self.gop:
                self.gop.append((tag, payload))
                self.gop_bytes += len(payload)
                if len(self.gop) > GOP_MAX_FRAMES or self.gop_bytes > GOP_MAX_BYTES:
                    self.gop, self.gop_bytes = [], 0
            for viewer in list(self.viewers):
                viewer.put(tag, payload)

    async def run(self) -> None:
        fast_exits = 0
        while self.viewers:
            w, h = self.display_size()
            self.size = fit(w, h, SIZE_CAPS[self.cap])
            started, saw_frame = time.monotonic(), False
            command = (f"echo $$; exec screenrecord --output-format=h264 --time-limit 179 --bit-rate {BITRATE} "
                       f"--size {self.size} -")
            try:
                self.proc = await asyncio.create_subprocess_exec(
                    "adb", "exec-out", command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            except OSError as e:
                self.fail(f"adb unavailable: {e}")
                return
            logger.info(f"screenrecord {self.size} at {BITRATE // 1000} kbit/s")
            parser, last_restart, pid = AnnexB(), self.last_restart, None
            try:
                pid = int(await asyncio.wait_for(self.proc.stdout.readline(), 10))
                # The last viewer can leave while adb starts; unsubscribe() had no process to kill then.
                while self.viewers:
                    try:
                        chunk = await asyncio.wait_for(self.proc.stdout.read(1 << 16), SETTLE if parser.pending else 1)
                    except asyncio.TimeoutError:
                        self.dispatch(parser.flush())
                        continue
                    if not chunk:
                        break
                    messages = parser.push(chunk)
                    saw_frame = saw_frame or any(tag != TAG_CONFIG for tag, _ in messages)
                    self.dispatch(messages)
            except (ValueError, asyncio.TimeoutError, asyncio.LimitOverrunError) as e:
                logger.warning(f"screenrecord did not start: {e!r}")
            finally:
                self.kill()
                await self.proc.wait()
                self.proc = None
                if pid:
                    await stop_device_process(pid)
            self.dispatch(parser.flush())
            deliberate = self.last_restart != last_restart or not self.viewers
            if not deliberate and not saw_frame and time.monotonic() - started < FAST_EXIT:
                if self.cap < len(SIZE_CAPS) - 1:
                    self.cap += 1
                    logger.warning(f"screenrecord rejected {self.size}; trying a smaller size")
                    continue
                fast_exits += 1
                if fast_exits >= FAST_EXIT_LIMIT:
                    self.fail("screenrecord exits at once")
                    return
            else:
                fast_exits = 0
            if not deliberate:
                await asyncio.sleep(0.25)

    def fail(self, reason: str) -> None:
        """Give up on video. Each viewer's queue gets None, so its socket can fall back to JPEG."""
        logger.warning(f"H.264 video unavailable: {reason}")
        self.unavailable = reason
        self.failed_at = time.monotonic()
        viewers, self.viewers = self.viewers, set()
        for viewer in viewers:
            viewer.queue.put_nowait(None)
