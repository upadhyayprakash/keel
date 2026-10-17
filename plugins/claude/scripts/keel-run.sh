#!/usr/bin/env bash
# Runs one keel command with --json and prints keel's single JSON object.
# Finds keel on PATH, or in the newest nvm Node version when PATH has no nvm.
set -u
KEEL_BIN="${KEEL_BIN:-}"
if [ -z "$KEEL_BIN" ]; then
  KEEL_BIN="$(command -v keel 2>/dev/null || true)"
fi
if [ -z "$KEEL_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  KEEL_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin/keel 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$KEEL_BIN" ] || [ ! -x "$KEEL_BIN" ]; then
  echo '{"ok":false,"error":"keel is not installed.","hint":"npm install -g @nouisi/keel (needs Node 20.19 or newer), or set KEEL_BIN to its path."}'
  exit 127
fi
# keel needs node on PATH; use the node next to the keel we found.
PATH="$(dirname "$KEEL_BIN"):$PATH" exec "$KEEL_BIN" "$@" --json
