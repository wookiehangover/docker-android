#!/bin/sh
set -eu

ui=$(dirname "$0")/../web-ui
state="$PWD/.serve-droid"
package_dir=$(cd "$ui/.." && pwd -P)
if [ "$(pwd -P)" = "$package_dir" ]; then
    venv="$PWD/.venv"
else
    venv="$state/.venv"
fi

uv="$state/bin/uv"
if command -v uv >/dev/null 2>&1; then
    uv=uv
fi

system_python() {
    for python in "$venv/bin/python" python3 python3.14 python3.13 python3.12; do
        if command -v "$python" >/dev/null 2>&1 &&
            "$python" -c 'import sys; sys.exit(not (3, 12) <= sys.version_info[:2] < (3, 15))' 2>/dev/null; then
            printf '%s\n' "$python"
            return 0
        fi
    done
    return 1
}

mode=${SERVE_DROID_PYTHON_SETUP:-}
if [ -z "$mode" ]; then
    if [ -f "$venv/.serve-droid-system" ]; then
        mode=system
    elif command -v "$uv" >/dev/null 2>&1; then
        mode=uv
    elif [ -t 0 ]; then
        printf '%s\n' 'uv was not found. Choose Python setup:' \
            '  1) Install uv for this project (manages Python automatically)' \
            '  2) Use installed Python 3.12–3.14 with venv and pip' >&2
        printf 'Choice [1/2]: ' >&2
        IFS= read -r choice || exit 1
        case "$choice" in
            1|uv) mode=uv ;;
            2|system) mode=system ;;
            *) echo 'Setup cancelled.' >&2; exit 1 ;;
        esac
    else
        mode=system
    fi
fi

case "$mode" in
    system)
        if ! python=$(system_python); then
            echo 'System setup needs Python 3.12–3.14. To install uv instead, rerun with SERVE_DROID_PYTHON_SETUP=uv.' >&2
            exit 1
        fi
        if [ "$python" != "$venv/bin/python" ]; then
            "$python" -m venv "$venv"
        fi
        python="$venv/bin/python"
        if ! "$python" -m pip --version >/dev/null 2>&1; then
            "$python" -m ensurepip
        fi
        "$python" -m pip --disable-pip-version-check install --quiet -r "$ui/mac-requirements.txt" >&2
        touch "$venv/.serve-droid-system"
        ;;
    uv)
        if ! command -v "$uv" >/dev/null 2>&1; then
            echo "Setting up uv in $state/bin…" >&2
            installer=$(mktemp)
            trap 'rm -f "$installer"' EXIT
            /usr/bin/curl -fsSL https://astral.sh/uv/0.11.28/install.sh -o "$installer"
            UV_UNMANAGED_INSTALL="$state/bin" /bin/sh "$installer" >&2
            rm -f "$installer"
            trap - EXIT
        fi
        UV_PROJECT_ENVIRONMENT="$venv" "$uv" sync --project "$ui" --frozen --python 3.12 --no-install-project >&2
        rm -f "$venv/.serve-droid-system"
        ;;
    *) echo 'SERVE_DROID_PYTHON_SETUP must be uv or system.' >&2; exit 1 ;;
esac

exec "$venv/bin/python" "$ui/attach.py" "$@"
