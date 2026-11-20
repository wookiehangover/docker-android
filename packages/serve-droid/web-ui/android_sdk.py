"""Find and, on request, install the Android SDK packages used by attach."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def executable(path):
    return path.is_file() and os.access(path, os.X_OK)


def missing_packages(root):
    missing = []
    if not executable(root / "platform-tools/adb"):
        missing.append("platform-tools")
    if not executable(root / "emulator/emulator") or not (root / "emulator/lib/emulator_controller.proto").is_file():
        missing.append("emulator")
    return missing


def sdk_root():
    configured = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if configured:
        return Path(configured).expanduser()
    default = Path.home() / "Library/Android/sdk"
    roots = [default]
    for binary, directory in [("adb", "platform-tools"), ("emulator", "emulator")]:
        found = shutil.which(binary)
        if found:
            parent = Path(found).resolve().parent
            if parent.name == directory:
                roots.append(parent.parent)
    return min(roots, key=lambda root: len(missing_packages(root)))


def sdk_manager(root):
    candidates = [root / "cmdline-tools/latest/bin/sdkmanager"]
    candidates.extend(sorted(root.glob("cmdline-tools/*/bin/sdkmanager"), reverse=True))
    return next((str(path) for path in candidates if executable(path)), shutil.which("sdkmanager"))


def homebrew():
    return shutil.which("brew") or next((str(path) for path in (
        Path("/opt/homebrew/bin/brew"), Path("/usr/local/bin/brew")) if executable(path)), None)


def ensure_sdk(require_manager=False):
    root = sdk_root()
    missing = missing_packages(root)
    manager = sdk_manager(root)
    if not missing and not require_manager:
        return root
    brew = homebrew()
    packages = " ".join(missing)
    manual = f'Install {packages} in Android Studio’s SDK Manager or set ANDROID_HOME to a complete SDK.'

    env = os.environ.copy()
    # Android Studio bundles a JDK even when macOS has no system Java runtime.
    studio_java = Path("/Applications/Android Studio.app/Contents/jbr/Contents/Home")
    if not env.get("JAVA_HOME") and executable(studio_java / "bin/java"):
        env["JAVA_HOME"] = str(studio_java)
        os.environ["JAVA_HOME"] = str(studio_java)
    java = str(Path(env["JAVA_HOME"]) / "bin/java") if env.get("JAVA_HOME") else shutil.which("java")
    needs_java = not java or not executable(Path(java)) or subprocess.run(
        [java, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
    casks = []
    if not manager:
        casks.append("android-commandlinetools")
    if needs_java:
        casks.append("temurin")
    if not missing and not casks:
        return root
    if sys.platform != "darwin" or not sys.stdin.isatty():
        raise ValueError(manual if missing else "Run serve-droid in a terminal to install Android command-line tools and Java.")
    if missing:
        print(f"Missing Android SDK packages in {root}: {packages}.", file=sys.stderr)
    if casks and not brew:
        print("Setup will install Homebrew using its official installer.", file=sys.stderr)
    if casks:
        print(f"Setup will also run brew install --cask {' '.join(casks)}.", file=sys.stderr)
    print("Install now? [y/N] ", end="", flush=True, file=sys.stderr)
    if sys.stdin.readline().strip().lower() not in ("y", "yes"):
        raise ValueError(f"Installation skipped. {manual}")
    if casks:
        if not brew:
            with tempfile.NamedTemporaryFile(suffix=".sh") as script:
                subprocess.run(["/usr/bin/curl", "-fsSL", "-o", script.name,
                                "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"], check=True)
                subprocess.run(["/bin/bash", script.name], check=True)
            brew = homebrew()
            if not brew:
                raise ValueError("The Homebrew installer finished but the brew executable was not found.")
        os.environ["PATH"] = str(Path(brew).parent) + os.pathsep + os.environ["PATH"]
        env["PATH"] = os.environ["PATH"]
        subprocess.run([brew, "install", "--cask", *casks], check=True)
        manager = sdk_manager(root)
    if not manager:
        raise ValueError("Could not locate sdkmanager after installation. Check your Homebrew PATH.")
    if needs_java:
        env.pop("JAVA_HOME", None)
        os.environ.pop("JAVA_HOME", None)
    if missing:
        subprocess.run([manager, f"--sdk_root={root}", *missing], check=True, env=env)
    if missing_packages(root):
        raise ValueError(f"SDK setup is incomplete. {manual}")
    return root
