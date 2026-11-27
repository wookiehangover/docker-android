"""Emulator and app controls for the web UI: apps, snapshots, telephony, network, location routes, accessibility.

server.py mounts ROUTES with its `api()` wrapper. Each handler is `async def h(emu, body, request)` and returns a dict.
Handlers raise ValueError for bad input and RuntimeError for device failures. adb picks the device from
ANDROID_SERIAL on the native path; in the container there is one device.
"""
import asyncio
import math
import os
import re
import shlex
import sys

sys.path.insert(0, os.environ.get("EMULATOR_PROTO_PATH", os.path.dirname(__file__)))
import emulator_controller_pb2 as pb  # noqa: E402

PACKAGE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$")
SNAPSHOT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
PHONE_NUMBER = re.compile(r"^\+?[0-9][0-9 ()-]{0,30}$")
LOCALE = re.compile(r"^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$")
SPEEDS = ("gsm", "hscsd", "gprs", "edge", "umts", "hsdpa", "lte", "evdo", "full")
DELAYS = ("gprs", "edge", "umts", "none")
PHONE_OPS = {
    "call": pb.PhoneCall.InitCall, "accept": pb.PhoneCall.AcceptCall, "end": pb.PhoneCall.DisconnectCall,
    "reject": pb.PhoneCall.RejectCallExplicit, "busy": pb.PhoneCall.RejectCallBusy,
    "hold": pb.PhoneCall.PlaceCallOnHold, "unhold": pb.PhoneCall.TakeCallOffHold,
}
TALKBACK = "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService"
MAX_ROUTE_POINTS = 10000


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


async def shell(command: str, timeout: float = 30) -> str:
    return await adb("shell", command, timeout=timeout)


async def console(*args: str, timeout: float = 30) -> str:
    """Run an emulator console command through `adb emu`. The console answers OK or `KO: reason`."""
    out = (await adb("emu", *args, timeout=timeout)).replace("\r", "")
    lines = [line for line in out.splitlines() if line.strip()]
    for line in lines:
        if line.startswith("KO"):
            raise RuntimeError(line[2:].lstrip(": ") or f"emulator console: {' '.join(args)} failed")
    return "\n".join(line for line in lines if line != "OK")


def state(emu) -> dict:
    """Per-emulator state that the console cannot read back (network profile, GPS route task)."""
    if not hasattr(emu, "_controls"):
        emu._controls = {"speed": "full", "delay": "none", "route": None, "route_lock": asyncio.Lock()}
    return emu._controls


def flag(value, name: str) -> bool:
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.lower() in ("true", "false", "on", "off", "1", "0"):
        return value.lower() in ("true", "on", "1")
    raise ValueError(f"{name} must be true or false")


def package_name(body: dict) -> str:
    package = str(body.get("package", "")).strip()
    if not PACKAGE.match(package):
        raise ValueError("package must be a package name like com.example.app")
    return package


def check_success(out: str, what: str) -> None:
    if "Success" not in out:
        raise RuntimeError(out.strip() or f"{what} failed")


# Apps


async def get_apps(emu, body: dict, request):
    show_all = str(request.query.get("all", "false")).lower() in ("1", "true", "yes")
    out = await shell("pm list packages" + ("" if show_all else " -3"))
    packages = sorted(line[len("package:"):].strip() for line in out.splitlines() if line.startswith("package:"))
    return {"packages": packages}


async def post_app(emu, body: dict, request):
    action = str(body.get("action", ""))
    package = package_name(body)
    if action not in ("launch", "stop", "clear", "uninstall"):
        raise ValueError("action must be launch, stop, clear or uninstall")
    if not (await shell(f"pm path {package} 2>/dev/null; true")).strip():
        raise ValueError(f"{package} is not installed")
    if action == "launch":
        out = await shell(f"cmd package resolve-activity --brief -c android.intent.category.LAUNCHER {package}")
        activity = out.strip().splitlines()[-1].strip() if out.strip() else ""
        if "/" not in activity:
            raise RuntimeError(f"{package} has no launcher activity")
        out = await shell(f"am start -W -n {shlex.quote(activity)} 2>&1")
        if "Error" in out:
            raise RuntimeError(out.strip())
        return {"activity": activity}
    if action == "stop":
        await shell(f"am force-stop {package}")
    elif action == "clear":
        check_success(await shell(f"pm clear {package} 2>&1; true"), "pm clear")
    else:
        check_success(await shell(f"pm uninstall {package} 2>&1; true"), "pm uninstall")
    return {}


# Snapshots (emulator console; the SnapshotService proto is not compiled into the image)

SNAPSHOT_ROW = re.compile(r"^\S+\s+(\S+)\s+([\d.]+)([KMGT]?)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")
UNITS = {"": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}


async def list_snapshots() -> list:
    out = await console("avd", "snapshot", "list")
    snapshots = []
    for line in out.splitlines():
        m = SNAPSHOT_ROW.match(line.strip())
        if m and m.group(1) != "TAG":
            snapshots.append({"name": m.group(1), "size_bytes": int(float(m.group(2)) * UNITS[m.group(3)]),
                              "created": m.group(4)})
    return snapshots


async def post_snapshots(emu, body: dict, request):
    action = str(body.get("action", "list"))
    if action == "list":
        return {"snapshots": await list_snapshots()}
    if action not in ("save", "load", "delete"):
        raise ValueError("action must be list, save, load or delete")
    name = str(body.get("name", "")).strip()
    if not SNAPSHOT_NAME.match(name):
        raise ValueError("name must be 1-64 letters, digits, '.', '_' or '-'")
    if action != "save" and name not in {s["name"] for s in await list_snapshots()}:
        raise ValueError(f"no snapshot named {name}")
    await console("avd", "snapshot", action, name, timeout=180)
    if action == "load":
        stop_route(emu)
        await wait_for_adb()
    return {"name": name}


async def wait_for_adb(seconds: int = 60) -> None:
    """adb drops the device for a moment after a snapshot load; return once the shell answers again."""
    for _ in range(seconds * 2):
        try:
            if (await shell("getprop sys.boot_completed", timeout=5)).strip() == "1":
                return
        except RuntimeError:
            pass
        await asyncio.sleep(0.5)
    raise RuntimeError("the device did not come back after loading the snapshot")


# Telephony and biometrics (gRPC EmulatorController)

PHONE_ERRORS = {
    pb.PhoneResponse.BadOperation: "bad operation", pb.PhoneResponse.BadNumber: "bad phone number",
    pb.PhoneResponse.InvalidAction: "no call in a state that allows this action",
    pb.PhoneResponse.ActionFailed: "the modem refused the action", pb.PhoneResponse.RadioOff: "the radio is off",
}


def phone_number(body: dict) -> str:
    number = str(body.get("number", "")).strip()
    if not PHONE_NUMBER.match(number):
        raise ValueError("number must be a phone number like +15551234567")
    return number


def check_phone(response, what: str) -> None:
    if response.response != pb.PhoneResponse.OK:
        raise RuntimeError(f"{what} failed: {PHONE_ERRORS.get(response.response, response.response)}")


async def post_sms(emu, body: dict, request):
    number = phone_number(body)
    text = str(body.get("text", ""))
    if not text:
        raise ValueError("text is empty")
    if len(text) > 4000:
        raise ValueError("text is longer than 4000 characters")
    check_phone(await emu.call("sendSms", pb.SmsMessage(srcAddress=number, text=text)), "SMS")
    return {}


async def post_phone(emu, body: dict, request):
    action = str(body.get("action", "call"))
    if action not in PHONE_OPS:
        raise ValueError(f"action must be one of {', '.join(PHONE_OPS)}")
    number = phone_number(body)
    check_phone(await emu.call("sendPhone", pb.PhoneCall(operation=PHONE_OPS[action], number=number)), action)
    return {}


async def post_fingerprint(emu, body: dict, request):
    touch_id = int(body.get("id", 1))
    if not 1 <= touch_id <= 10:
        raise ValueError("id must be 1-10")
    await emu.call("sendFingerprint", pb.Fingerprint(isTouching=True, touchId=touch_id))
    await asyncio.sleep(0.25)
    await emu.call("sendFingerprint", pb.Fingerprint(isTouching=False, touchId=touch_id))
    return {}


# Network


async def read_network(emu) -> dict:
    out = await shell("settings get global airplane_mode_on; settings get global wifi_on; "
                      "settings get global mobile_data")
    airplane, wifi, data = (out.splitlines() + ["", "", ""])[:3]
    s = state(emu)
    return {"airplane": airplane.strip() == "1", "wifi": wifi.strip() in ("1", "2"), "data": data.strip() == "1",
            "speed": s["speed"], "delay": s["delay"]}


async def post_network(emu, body: dict, request):
    s = state(emu)
    if "speed" in body and body["speed"] is not None:
        speed = str(body["speed"]).lower()
        if speed not in SPEEDS:
            raise ValueError(f"speed must be one of {', '.join(SPEEDS)}")
    if "delay" in body and body["delay"] is not None:
        delay = str(body["delay"]).lower()
        if delay not in DELAYS:
            raise ValueError(f"delay must be one of {', '.join(DELAYS)}")
    toggles = {k: flag(body[k], k) for k in ("airplane", "wifi", "data") if body.get(k) is not None}
    if body.get("speed") is not None:
        await console("network", "speed", speed)
        s["speed"] = speed
    if body.get("delay") is not None:
        await console("network", "delay", delay)
        s["delay"] = delay
    if "airplane" in toggles:
        await shell(f"cmd connectivity airplane-mode {'enable' if toggles['airplane'] else 'disable'}")
    if "wifi" in toggles:
        await shell(f"svc wifi {'enable' if toggles['wifi'] else 'disable'}")
    if "data" in toggles:
        await shell(f"svc data {'enable' if toggles['data'] else 'disable'}")
    if toggles:
        await asyncio.sleep(0.5)
    return await read_network(emu)


# Location: a single fix, a route, or stop


def coordinate(lat, lng) -> tuple:
    lat, lng = float(lat), float(lng)
    if not (-90 <= lat <= 90 and -180 <= lng <= 180) or math.isnan(lat) or math.isnan(lng):
        raise ValueError("latitude or longitude out of range")
    return lat, lng


def heading(a: tuple, b: tuple, seconds: float) -> tuple:
    """Bearing in degrees and ground speed in m/s from a to b."""
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    dlng = lng2 - lng1
    y = math.sin(dlng) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
    bearing = (math.degrees(math.atan2(y, x)) + 360) % 360
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    meters = 2 * 6371000 * math.asin(math.sqrt(min(1.0, h)))
    return bearing, meters / seconds if seconds else 0.0


async def set_gps(emu, point: tuple, bearing: float = 0.0, speed: float = 0.0) -> None:
    await emu.call("setGps", pb.GpsState(passiveUpdate=False, latitude=point[0], longitude=point[1],
                                         speed=speed, bearing=bearing, satellites=12))


async def run_route(emu, points: list, interval: float, loop: bool) -> None:
    i = 0
    while True:
        a = points[i]
        b = points[i + 1] if i + 1 < len(points) else (points[0] if loop else a)
        bearing, speed = heading(a, b, interval) if b != a else (0.0, 0.0)
        try:
            await set_gps(emu, a, bearing, speed)
        except Exception as e:  # keep driving; the emulator may be reconnecting
            print(f"route: setGps failed: {e}", file=sys.stderr)
        i += 1
        if i >= len(points):
            if not loop:
                break
            i = 0
        await asyncio.sleep(interval)


def stop_route(emu) -> bool:
    task = state(emu)["route"]
    state(emu)["route"] = None
    if task and not task.done():
        task.cancel()
        return True
    return False


async def post_location(emu, body: dict, request):
    # One request at a time, so a route that is starting cannot escape a later stop or replacement.
    async with state(emu)["route_lock"]:
        return await set_location(emu, body)


async def set_location(emu, body: dict):
    if body.get("stop"):
        return {"stopped": stop_route(emu)}
    if "route" in body:
        route = body["route"]
        if not isinstance(route, list) or not route:
            raise ValueError("route must be a non-empty list of [lat, lng]")
        if len(route) > MAX_ROUTE_POINTS:
            raise ValueError(f"route has more than {MAX_ROUTE_POINTS} points")
        points = []
        for p in route:
            if isinstance(p, dict):
                points.append(coordinate(p["lat"], p["lng"]))
            elif isinstance(p, (list, tuple)) and len(p) >= 2:
                points.append(coordinate(p[0], p[1]))
            else:
                raise ValueError("each route point must be [lat, lng]")
        interval_ms = int(body.get("interval_ms", 1000))
        if not 100 <= interval_ms <= 600000:
            raise ValueError("interval_ms must be 100-600000")
        loop = flag(body.get("loop", False), "loop")
        stop_route(emu)
        await set_gps(emu, points[0])
        task = asyncio.create_task(run_route(emu, points, interval_ms / 1000, loop))
        state(emu)["route"] = task
        return {"points": len(points), "interval_ms": interval_ms, "loop": loop}
    lat, lng = coordinate(body["lat"], body["lng"])
    stop_route(emu)
    await set_gps(emu, (lat, lng))
    return {}


# Accessibility: font scale, density, locale, TalkBack


async def read_accessibility() -> dict:
    out = await shell("settings get system font_scale; echo ---; wm density; echo ---; "
                      "getprop persist.sys.locale; getprop ro.product.locale; echo ---; "
                      "settings get secure enabled_accessibility_services; echo ---; "
                      "pm path com.google.android.marvin.talkback 2>/dev/null; true")
    font, density, locale, services, talkback_path = (out.split("---") + [""] * 5)[:5]
    physical = re.search(r"Physical density: (\d+)", density)
    override = re.search(r"Override density: (\d+)", density)
    try:
        font_scale = float(font.strip())
    except ValueError:
        font_scale = 1.0
    locales = [line.strip() for line in locale.splitlines() if line.strip()]
    return {
        "font_scale": font_scale,
        "density": int(override.group(1)) if override else (int(physical.group(1)) if physical else None),
        "physical_density": int(physical.group(1)) if physical else None,
        "locale": locales[0] if locales else None,
        "talkback": TALKBACK in services,
        "talkback_available": bool(talkback_path.strip()),
    }


async def set_locale(locale: str) -> None:
    """System locale needs root: works on userdebug (Google APIs / AOSP) images, not on Play images."""
    if "uid=0" not in await shell("su 0 id 2>&1; true"):
        raise RuntimeError("changing the system locale needs a rootable image (not a Google Play image)")
    tag = locale.replace("_", "-")
    old_pid = (await shell("pidof system_server; true")).strip()
    await shell(f"su 0 setprop persist.sys.locale {shlex.quote(tag)}")
    await shell("su 0 setprop ctl.restart zygote")
    # sys.boot_completed stays 1 across a zygote restart: wait for a new system_server with a resumed activity.
    for _ in range(120):
        await asyncio.sleep(1)
        try:
            pid = (await shell("pidof system_server; true", timeout=5)).strip()
            if pid and pid != old_pid and "ResumedActivity" in await shell(
                    "dumpsys activity activities 2>/dev/null | grep -m1 ResumedActivity; true", timeout=10):
                return
        except RuntimeError:
            pass
    raise RuntimeError("the device did not come back after the locale change")


async def post_accessibility(emu, body: dict, request):
    if body.get("font_scale") is not None:
        scale = float(body["font_scale"])
        if not 0.5 <= scale <= 3.0:
            raise ValueError("font_scale must be 0.5-3.0")
    if body.get("density") is not None and body["density"] != "reset":
        density = int(body["density"])
        if not 72 <= density <= 1280:
            raise ValueError("density must be 72-1280 or \"reset\"")
    if body.get("locale") is not None and not LOCALE.match(str(body["locale"])):
        raise ValueError("locale must be a language tag like fr-FR")
    talkback = flag(body["talkback"], "talkback") if body.get("talkback") is not None else None

    if body.get("font_scale") is not None:
        await shell(f"settings put system font_scale {scale:g}")
    if body.get("density") is not None:
        await shell("wm density reset" if body["density"] == "reset" else f"wm density {density}")
    if talkback is not None:
        if talkback and not (await shell("pm path com.google.android.marvin.talkback 2>/dev/null; true")).strip():
            raise RuntimeError("TalkBack is not installed on this image")
        services = (await shell("settings get secure enabled_accessibility_services")).strip()
        enabled = [s for s in services.split(":") if s and s != "null" and s != TALKBACK]
        if talkback:
            enabled.append(TALKBACK)
        if enabled:
            await shell(f"settings put secure enabled_accessibility_services {shlex.quote(':'.join(enabled))}")
            await shell("settings put secure accessibility_enabled 1")
        else:
            await shell("settings delete secure enabled_accessibility_services")
            await shell("settings put secure accessibility_enabled 0")
    if body.get("locale") is not None:
        await set_locale(str(body["locale"]))
    return await read_accessibility()


ROUTES = [
    ("GET", "/api/apps", get_apps),
    ("POST", "/api/app", post_app),
    ("POST", "/api/snapshots", post_snapshots),
    ("POST", "/api/sms", post_sms),
    ("POST", "/api/phone", post_phone),
    ("POST", "/api/fingerprint", post_fingerprint),
    ("POST", "/api/network", post_network),
    ("POST", "/api/location", post_location),
    ("POST", "/api/accessibility", post_accessibility),
]
