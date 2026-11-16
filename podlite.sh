#!/usr/bin/env sh
# podlite launcher - starts the server and opens your browser.
set -e
cd "$(dirname "$0")"
exec python3 podlite.py --open "$@"
