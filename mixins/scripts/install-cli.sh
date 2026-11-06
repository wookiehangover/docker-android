#!/bin/bash
# Installs the docker-android CLI. Passed to the emulator build as the "extension" secret,
# which upstream fills with a private script.
set -euo pipefail
python3 -m venv "${WORK_PATH}/ve"
"${WORK_PATH}/ve/bin/pip" install --no-cache-dir -e "${APP_PATH}/cli"
ln -sf "${WORK_PATH}/ve/bin/docker-android" /usr/local/bin/docker-android
