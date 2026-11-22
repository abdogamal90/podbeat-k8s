#!/usr/bin/env sh
# podbeat launcher - starts the server and opens your browser.
set -e
cd "$(dirname "$0")"
exec python3 podbeat.py --open "$@"
