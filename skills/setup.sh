#!/usr/bin/env bash
set -euo pipefail

# Local-dev setup for gospelo-mediakit (macOS / Linux).
#
# This installs the single package in editable mode into a repo-root .venv and
# registers the resulting `gospelo-mediakit-mcp` binary with every host. It is
# for working ON this repo. END USERS do not need this — once the package is on
# PyPI they just point their MCP config at `uvx gospelo-mediakit-mcp` (see
# README; works on Windows too, where this bash script does not run).
#
# Steps (all idempotent):
#   1) Build .venv and `pip install -e .` (gives gospelo-mediakit + -mcp scripts).
#   2) Register .venv/bin/gospelo-mediakit-mcp in:
#        - .mcp.json                      (Claude Code, project)
#        - ~/.codex/config.toml           (Codex CLI + App) via `codex mcp add`
#        - Claude Desktop config          (with PATH env so GUI finds ffmpeg)
#      Our own entry is refreshed to the current binary path.
#   4) Symlink skills/claude/* into .claude/skills.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_NAME="gospelo-mediakit"
VENV="$REPO_ROOT/.venv"
BINARY="$VENV/bin/${SERVER_NAME}-mcp"
PYTHON="${PYTHON:-python3}"

FFMPEG_BIN_DIR="$(dirname "$(command -v ffmpeg 2>/dev/null || echo /opt/homebrew/bin/ffmpeg)")"

# ---------------------------------------------------------------------------
echo "=== Building .venv and installing gospelo-mediakit (editable) ==="
if [ ! -d "$VENV" ]; then
  "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -e "$REPO_ROOT"
if [ ! -x "$BINARY" ]; then
  echo "  [ERROR] $BINARY was not created; aborting." >&2
  exit 1
fi
echo "  ok: $BINARY"
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "  [WARN] ffmpeg not on PATH. Install it (brew install ffmpeg) or set GOSPELO_MEDIAKIT_FFMPEG."
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Registering in .mcp.json (Claude Code) ==="
python3 - "$REPO_ROOT/.mcp.json" "$SERVER_NAME" "$BINARY" <<'PY'
import json, pathlib, sys
mcp_path, name, command = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(mcp_path)
data = json.loads(p.read_text(encoding="utf-8")) if p.exists() and p.stat().st_size else {}
servers = data.setdefault("mcpServers", {})
desired = {"command": command}
if servers.get(name) == desired:
    print("  unchanged")
else:
    servers[name] = desired  # refresh our own entry to the current binary
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("  registered/updated")
PY

# ---------------------------------------------------------------------------
echo ""
echo "=== Registering with Codex CLI (also used by Codex App) ==="
if command -v codex >/dev/null 2>&1; then
  # Refresh: remove a stale entry (e.g. old mcp-server path) then add.
  codex mcp remove "$SERVER_NAME" >/dev/null 2>&1 || true
  if codex mcp add "$SERVER_NAME" -- "$BINARY" >/dev/null 2>&1; then
    echo "  registered $SERVER_NAME -> $BINARY"
  else
    echo "  [WARN] codex mcp add failed (continuing)"
  fi
else
  echo "  [INFO] codex CLI not on PATH; skipping."
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Registering in Claude Desktop config ==="
CLAUDE_DIR="$HOME/Library/Application Support/Claude"
if [ -d "$CLAUDE_DIR" ]; then
  python3 - "$CLAUDE_DIR/claude_desktop_config.json" "$SERVER_NAME" "$BINARY" "$FFMPEG_BIN_DIR" <<'PY'
import json, os, pathlib, sys
cfg, name, command, ffdir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
p = pathlib.Path(cfg)
data = json.loads(p.read_text(encoding="utf-8")) if p.exists() and p.stat().st_size else {}
servers = data.setdefault("mcpServers", {})
path_val = os.pathsep.join([ffdir, "/usr/local/bin", "/usr/bin", "/bin"])
desired = {"command": command, "env": {"PATH": path_val}}
if servers.get(name) == desired:
    print("  unchanged")
else:
    servers[name] = desired
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("  registered/updated")
PY
else
  echo "  [INFO] Claude Desktop not installed; skipping."
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Symlinking Claude skills into .claude/skills ==="
TARGET="$REPO_ROOT/.claude/skills"
mkdir -p "$TARGET"
shopt -s nullglob
for skill_dir in "$SCRIPT_DIR"/claude/*/; do
  name="$(basename "$skill_dir")"
  ln -sfn "$skill_dir" "$TARGET/$name"
  echo "  symlink: $TARGET/$name"
done
shopt -u nullglob

echo ""
echo "Done. Reopen Claude Code / Codex CLI, and FULLY restart Claude Desktop / Codex App."
echo "Smoke test:"
echo "  $BINARY cli mediakit_extract_frames --json '{\"video_path\":\"/path/clip.mp4\",\"overwrite\":true}'"
