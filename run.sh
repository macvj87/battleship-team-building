#!/usr/bin/env bash
# Start the Battleship server on the LAN.
#
#   ./run.sh              start on the default port
#   PORT=9000 ./run.sh    start on another port
#   ADMIN_KEY=CAPTAIN ./run.sh   pin the admin key instead of a random one

set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "First run: creating a Python environment…"
  python3 -m venv .venv
fi

if ! .venv/bin/python -c "import fastapi, uvicorn" 2>/dev/null; then
  echo "Installing dependencies (this only happens once)…"
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet "fastapi" "uvicorn[standard]"
fi

exec .venv/bin/python server.py
