#!/bin/bash
# Set up the venv for gospelo-mediakit-mcp.
# Idempotent: re-running is safe; pip reinstalls only if dependencies change.
#
# After this script:
#   venv/bin/gospelo-mediakit-mcp        # MCP stdio server entry point
#   venv/bin/gospelo-mediakit-mcp cli    # one-shot CLI mode (smoke tests / hosts)
#
# The venv installs BOTH the core package (gospelo-mediakit, editable from the
# repo root) and this MCP wrapper, so the server imports gospelo_mediakit.core
# directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# repo root = mcp-server/gospelo-mediakit -> ../../
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PYTHON="${PYTHON:-python3}"
VENV_DIR="venv"

echo "[setup_venv] target:    $SCRIPT_DIR/$VENV_DIR"
echo "[setup_venv] core repo: $REPO_ROOT"
echo "[setup_venv] using $PYTHON ($($PYTHON --version 2>&1))"

if [[ ! -d "$VENV_DIR" ]]; then
    echo "[setup_venv] creating venv..."
    "$PYTHON" -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install --quiet --upgrade pip setuptools wheel

echo "[setup_venv] installing gospelo-mediakit (core, editable)..."
"$VENV_DIR/bin/pip" install --quiet -e "$REPO_ROOT"

echo "[setup_venv] installing gospelo-mediakit-mcp (this server, editable)..."
"$VENV_DIR/bin/pip" install --quiet -e .

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "[setup_venv] WARNING: ffmpeg not found on PATH. The tool needs it at runtime."
    echo "[setup_venv]          macOS: brew install ffmpeg"
fi

echo "[setup_venv] done. Smoke test:"
echo "  $VENV_DIR/bin/gospelo-mediakit-mcp cli mediakit_extract_frames --json '{\"video_path\":\"/path/to/clip.mp4\"}'"
