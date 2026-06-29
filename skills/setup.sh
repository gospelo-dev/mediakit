#!/usr/bin/env bash
set -euo pipefail

# Unified setup for the gospelo-mediakit thin-wrapper MCP stack.
#
# What this script does (all idempotent):
#   1) For each mcp-server/<name>/setup_venv.sh -> run it (build the venv that
#      path-installs the core package + the FastMCP wrapper).
#   2) Register each venv-built MCP server in the project-root .mcp.json so
#      Claude Code picks it up.
#   3) If the `codex` CLI is on PATH -> register each server with Codex
#      (`codex mcp add`, never overwriting an existing registration). This same
#      ~/.codex/config.toml is read by the Codex App, so both are covered.
#   4) Register each server in Claude Desktop's global config so the desktop app
#      can use it too (idempotent; injects PATH so the GUI-spawned process finds
#      ffmpeg). Skipped if Claude Desktop is not installed.
#   5) Symlink skills/claude/<name> -> .claude/skills/<name> for Claude Code
#      skill discovery. (Codex skills under skills/codex/ are documentation the
#      user points Codex at; Codex has no project skill-symlink convention.)
#
# Host coverage:
#   Claude Code  -> .mcp.json (project, step 2)
#   Codex CLI    -> ~/.codex/config.toml (step 3)
#   Codex App    -> ~/.codex/config.toml (same file, step 3)
#   Claude Desktop -> ~/Library/Application Support/Claude/... (step 4)
#
# Adding a new MCP server: drop a directory under mcp-server/ with its own
# setup_venv.sh and a `<name>-mcp` console script. No edit to this script.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_DIR="$REPO_ROOT/mcp-server"

MCP_VENV_COUNT=0
CLAUDE_MCP_REGISTERED=0
CLAUDE_MCP_SKIPPED=0
CODEX_REGISTERED=0
CODEX_SKIPPED=0
DESKTOP_REGISTERED=0
DESKTOP_SKIPPED=0
CLAUDE_SYMLINK_COUNT=0

# Directory that holds ffmpeg/ffprobe, injected into the Claude Desktop entry's
# PATH so the GUI-spawned server can find them (GUI apps don't inherit the
# shell PATH). Falls back to a sensible default if ffmpeg isn't on PATH here.
FFMPEG_BIN_DIR="$(dirname "$(command -v ffmpeg 2>/dev/null || echo /opt/homebrew/bin/ffmpeg)")"

# ---------------------------------------------------------------------------
# 1) Build each MCP server's venv.
# ---------------------------------------------------------------------------
build_mcp_venvs() {
  [ -d "$MCP_DIR" ] || return 0
  shopt -s nullglob
  for server_dir in "$MCP_DIR"/*/; do
    local name setup
    name="$(basename "$server_dir")"
    setup="$server_dir/setup_venv.sh"
    [ -f "$setup" ] || continue
    echo ""
    echo "=== Building MCP server venv: $name ==="
    if ! command -v python3 >/dev/null 2>&1; then
      echo "  [WARN] python3 not on PATH; skipping venv build for $name"
      continue
    fi
    if (cd "$server_dir" && bash "$setup"); then
      MCP_VENV_COUNT=$((MCP_VENV_COUNT + 1))
    else
      echo "  [WARN] setup_venv.sh failed for $name (continuing)"
    fi
  done
  shopt -u nullglob
}

# ---------------------------------------------------------------------------
# 2) Register each server in .mcp.json (Claude Code). Idempotent; never
#    overwrites an entry that exists with a different command.
# ---------------------------------------------------------------------------
register_claude_mcp() {
  local mcp_json="$REPO_ROOT/.mcp.json"
  [ -d "$MCP_DIR" ] || return 0
  command -v python3 >/dev/null 2>&1 || { echo "  [WARN] python3 missing; skip .mcp.json"; return 0; }

  echo ""
  echo "=== Registering MCP servers in .mcp.json (Claude Code) ==="
  shopt -s nullglob
  for server_dir in "$MCP_DIR"/*/; do
    local name binary
    name="$(basename "$server_dir")"
    [ -f "$server_dir/setup_venv.sh" ] || continue
    binary="${server_dir%/}/venv/bin/$name-mcp"
    if [ ! -x "$binary" ]; then
      echo "  [WARN] $binary not executable; skipping .mcp.json for $name"
      continue
    fi
    local result
    result="$(python3 - "$mcp_json" "$name" "$binary" <<'PY'
import json, pathlib, sys
mcp_path, name, command = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(mcp_path)
data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"mcpServers": {}}
servers = data.setdefault("mcpServers", {})
desired = {"command": command}
if servers.get(name) == desired:
    print("unchanged")
elif name in servers:
    print("skip:exists")
else:
    servers[name] = desired
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("added")
PY
)"
    case "$result" in
      added) echo "  claude (.mcp.json): registered $name"; CLAUDE_MCP_REGISTERED=$((CLAUDE_MCP_REGISTERED + 1));;
      unchanged) echo "  claude (.mcp.json): $name already up to date"; CLAUDE_MCP_SKIPPED=$((CLAUDE_MCP_SKIPPED + 1));;
      skip:exists) echo "  claude (.mcp.json): $name exists with different command; not overwriting"; CLAUDE_MCP_SKIPPED=$((CLAUDE_MCP_SKIPPED + 1));;
      *) echo "  [WARN] unexpected .mcp.json result for $name: $result";;
    esac
  done
  shopt -u nullglob
}

# ---------------------------------------------------------------------------
# 3) Register each server with the Codex CLI. Idempotent; skips if present.
# ---------------------------------------------------------------------------
register_codex_mcp() {
  [ -d "$MCP_DIR" ] || return 0
  if ! command -v codex >/dev/null 2>&1; then
    echo ""
    echo "[INFO] codex CLI not on PATH; skipping Codex MCP registration."
    return 0
  fi
  echo ""
  echo "=== Registering MCP servers with Codex CLI ==="
  shopt -s nullglob
  for server_dir in "$MCP_DIR"/*/; do
    local name binary
    name="$(basename "$server_dir")"
    [ -f "$server_dir/setup_venv.sh" ] || continue
    binary="${server_dir%/}/venv/bin/$name-mcp"
    if [ ! -x "$binary" ]; then
      echo "  [WARN] $binary not executable; skipping codex for $name"
      continue
    fi
    if codex mcp get "$name" >/dev/null 2>&1; then
      echo "  codex: $name already registered (run 'codex mcp remove $name' then re-run to update)"
      CODEX_SKIPPED=$((CODEX_SKIPPED + 1))
      continue
    fi
    if codex mcp add "$name" -- "$binary" >/dev/null 2>&1; then
      echo "  codex: registered $name -> $binary"
      CODEX_REGISTERED=$((CODEX_REGISTERED + 1))
    else
      echo "  [WARN] codex mcp add failed for $name (continuing)"
    fi
  done
  shopt -u nullglob
}

# ---------------------------------------------------------------------------
# 4) Register each server in Claude Desktop's global config. Idempotent; never
#    overwrites an entry that exists with a different command. Injects PATH so
#    the GUI-spawned stdio process can locate ffmpeg/ffprobe.
# ---------------------------------------------------------------------------
register_claude_desktop() {
  local cfg="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  local app_dir="$HOME/Library/Application Support/Claude"
  if [ ! -d "$app_dir" ]; then
    echo ""
    echo "[INFO] Claude Desktop not installed (no $app_dir); skipping."
    return 0
  fi
  command -v python3 >/dev/null 2>&1 || { echo "  [WARN] python3 missing; skip Claude Desktop"; return 0; }
  [ -d "$MCP_DIR" ] || return 0

  echo ""
  echo "=== Registering MCP servers in Claude Desktop config ==="
  shopt -s nullglob
  for server_dir in "$MCP_DIR"/*/; do
    local name binary
    name="$(basename "$server_dir")"
    [ -f "$server_dir/setup_venv.sh" ] || continue
    binary="${server_dir%/}/venv/bin/$name-mcp"
    if [ ! -x "$binary" ]; then
      echo "  [WARN] $binary not executable; skipping Claude Desktop for $name"
      continue
    fi
    local result
    result="$(python3 - "$cfg" "$name" "$binary" "$FFMPEG_BIN_DIR" <<'PY'
import json, os, pathlib, sys
cfg_path, name, command, ffdir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
p = pathlib.Path(cfg_path)
data = json.loads(p.read_text(encoding="utf-8")) if p.exists() and p.stat().st_size else {}
servers = data.setdefault("mcpServers", {})
# PATH so the GUI-spawned process finds ffmpeg; keep a generic system PATH too.
path_val = os.pathsep.join([ffdir, "/usr/local/bin", "/usr/bin", "/bin"])
desired = {"command": command, "env": {"PATH": path_val}}
if servers.get(name) == desired:
    print("unchanged")
elif name in servers:
    print("skip:exists")
else:
    servers[name] = desired
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("added")
PY
)"
    case "$result" in
      added) echo "  claude-desktop: registered $name"; DESKTOP_REGISTERED=$((DESKTOP_REGISTERED + 1));;
      unchanged) echo "  claude-desktop: $name already up to date"; DESKTOP_SKIPPED=$((DESKTOP_SKIPPED + 1));;
      skip:exists) echo "  claude-desktop: $name exists with different config; not overwriting"; DESKTOP_SKIPPED=$((DESKTOP_SKIPPED + 1));;
      *) echo "  [WARN] unexpected Claude Desktop result for $name: $result";;
    esac
  done
  shopt -u nullglob
}

# ---------------------------------------------------------------------------
# 5) Symlink Claude skills into .claude/skills.
#    `ln -sfn` (note -n) so an existing symlink-to-dir is replaced, not nested.
# ---------------------------------------------------------------------------
symlink_claude_skills() {
  local source_dir="$SCRIPT_DIR/claude"
  local target_dir="$REPO_ROOT/.claude/skills"
  [ -d "$source_dir" ] || return 0
  mkdir -p "$target_dir"
  echo ""
  echo "=== Symlinking Claude skills into .claude/skills ==="
  shopt -s nullglob
  for skill_dir in "$source_dir"/*/; do
    local name="$(basename "$skill_dir")"
    ln -sfn "$skill_dir" "$target_dir/$name"
    echo "  symlink: $target_dir/$name -> $skill_dir"
    CLAUDE_SYMLINK_COUNT=$((CLAUDE_SYMLINK_COUNT + 1))
  done
  shopt -u nullglob
}

# ---------------------------------------------------------------------------
build_mcp_venvs
register_claude_mcp
register_codex_mcp
register_claude_desktop
symlink_claude_skills

echo ""
echo "=== Summary ==="
echo "mcp-server venvs built:        $MCP_VENV_COUNT"
echo ".mcp.json (Claude Code):       registered $CLAUDE_MCP_REGISTERED, skipped $CLAUDE_MCP_SKIPPED"
if command -v codex >/dev/null 2>&1; then
  echo "codex CLI + App:               registered $CODEX_REGISTERED, skipped $CODEX_SKIPPED"
fi
echo "Claude Desktop:                registered $DESKTOP_REGISTERED, skipped $DESKTOP_SKIPPED"
echo ".claude/skills symlinks:       $CLAUDE_SYMLINK_COUNT"
echo ""
echo "Next: FULLY restart Claude Desktop / Codex App (quit + reopen), and reopen"
echo "      your Claude Code / Codex CLI session, so the MCP tool loads."
echo "Smoke test (no host needed):"
echo "  mcp-server/gospelo-mediakit/venv/bin/gospelo-mediakit-mcp cli \\"
echo "    mediakit_extract_frames --json '{\"video_path\":\"/path/clip.mp4\",\"overwrite\":true}'"
