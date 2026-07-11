# gospelo-mediakit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/gospelo-dev/mediakit/blob/main/LICENSE.md) [![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776AB.svg?logo=python&logoColor=white)](https://www.python.org/) [![Powered by FFmpeg](https://img.shields.io/badge/Powered_by-FFmpeg-007808.svg?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/) [![MCP](https://img.shields.io/badge/MCP-Claude_Code_%7C_Desktop_%7C_Codex-6e40c9.svg)](https://modelcontextprotocol.io/)

*English | [日本語](README_jp.md)*

**Handy little tools for video-production work, bundled as an MCP server.**
Today it offers **first/last frame extraction**, **speed change** (e.g.
compress a 4-second clip to 1 second), and **colour matching** (nudge an
AI-generated clip's colour back toward a reference frame). Under the hood it
just shells out to ffmpeg — small for now, but it'll keep growing.

It has three entry points, but the actual logic lives in **one place**
(`gospelo_mediakit/core/`) — a thin-wrapper design:

<p align="center">
  <img src="https://raw.githubusercontent.com/gospelo-dev/mediakit/main/images/architecture.png" alt="gospelo-mediakit architecture: many hosts, one core" width="860">
</p>

<details>
<summary>Text version (ASCII)</summary>

```
                ┌─ Claude Code   (.mcp.json, project)            ─┐
                │  Claude Desktop (claude_desktop_config.json)    │
  MCP stdio  ◄──┤  Codex CLI      (~/.codex/config.toml)          │ ←─ every host
   server    ◄──┤  Codex App      (~/.codex/config.toml, same)    │    calls the same
 (thin wrap)    └────────────────────────────────────────────────┘    venv binary
        │
        ▼  import
  gospelo_mediakit.core   ◄── the CLI (gospelo-mediakit / python -m …) calls the same core
   (ffmpeg via subprocess)
```

</details>

Supported hosts (all registered by `bash skills/setup.sh`):

| Host | Registered in | Scope |
|------|---------------|-------|
| Claude Code | `.mcp.json` (project) | this repository |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | global |
| Codex CLI | `~/.codex/config.toml` | global |
| Codex App | `~/.codex/config.toml` (same file as the CLI) | global |

> **Note for GUI apps (Claude Desktop / Codex App):** they do not inherit your
> shell `PATH`, so the server locates `ffmpeg`/`ffprobe` in this order:
> **`PATH` → common dirs like `/opt/homebrew/bin` → the env vars
> `GOSPELO_MEDIAKIT_FFMPEG`/`GOSPELO_MEDIAKIT_FFPROBE`**. `setup.sh` also injects
> a `PATH` into the Claude Desktop entry. Fully restart the app after changing
> its config.

- **Core** `gospelo_mediakit/core/` — deterministic Python over ffmpeg (no LLM).
- **CLI** `gospelo-mediakit extract-frames …` — a thin wrapper over the core, for
  CI / shell use.
- **MCP server** `gospelo_mediakit/mcp_server.py` — a ~20-line FastMCP wrapper.
  Both console scripts ship in one distribution (`gospelo-mediakit-mcp`).

## Setup

The package ships as one distribution, **`gospelo-mediakit-mcp`**, that provides
both the MCP server and the CLI. Requirements: `ffmpeg` on the system (and
[uv](https://docs.astral.sh/uv/) for the zero-install path below). `ffprobe` is
optional.

### Recommended: zero-install via `uvx` (cross-platform)

Point each host's MCP config at `uvx gospelo-mediakit-mcp` — `uv` fetches the
package (and a suitable Python) on demand, so there is no clone, no venv, and no
machine-specific path. The same config works on macOS, Linux and Windows:

```jsonc
// Claude Code .mcp.json / Claude Desktop claude_desktop_config.json
{
  "mcpServers": {
    "gospelo-mediakit": { "command": "uvx", "args": ["gospelo-mediakit-mcp"] }
  }
}
```

```bash
# Codex (CLI + App)
codex mcp add gospelo-mediakit -- uvx gospelo-mediakit-mcp
```

> First launch downloads the package; if a host times out spawning the server,
> pre-warm it once with `uv tool install gospelo-mediakit-mcp` (persistent) or
> just retry. Add an `env` block to point at ffmpeg — see below.

### Local development (macOS / Linux)

To hack on this repo, build an editable `.venv` and register it everywhere:

```bash
bash skills/setup.sh
```

It runs `pip install -e .`, registers `.venv/bin/gospelo-mediakit-mcp` with all
four hosts, and symlinks the Claude skill. Reopen the session/app afterwards
(**fully restart** the GUI apps). On Windows, use the `uvx` config above instead
(this script is bash-only).

### Pointing at ffmpeg (Windows / GUI apps)

GUI hosts (Claude Desktop, Codex App) don't inherit your shell `PATH`, so the
most reliable way to locate ffmpeg is the **`GOSPELO_MEDIAKIT_FFMPEG`** env var,
set in the MCP server's `env` block. It accepts the ffmpeg executable **or** its
`bin` directory. (`GOSPELO_MEDIAKIT_FFPROBE` is the same for ffprobe; optional.)

Claude Code / Claude Desktop (`.mcp.json` / `claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "gospelo-mediakit": {
      "command": "uvx",
      "args": ["gospelo-mediakit-mcp"],
      "env": {
        // Windows — the ffmpeg.exe path or its bin dir:
        "GOSPELO_MEDIAKIT_FFMPEG": "C:\\ffmpeg\\bin\\ffmpeg.exe"
        // macOS/Linux example: "/opt/homebrew/bin/ffmpeg"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.gospelo-mediakit.env]
GOSPELO_MEDIAKIT_FFMPEG = "C:\\ffmpeg\\bin"   # file or bin directory
```

Without the override the server still auto-searches `PATH` and the usual install
locations (macOS `/opt/homebrew/bin` etc.; Windows `C:\ffmpeg\bin`,
`%ProgramFiles%\ffmpeg\bin`, scoop shims). Install ffmpeg with
`winget install ffmpeg` (Windows) or `brew install ffmpeg` (macOS).

## Usage

### Claude Code / Claude Desktop / Codex (MCP tools)

```
Extract the first and last frame of clip.mp4          → mediakit_extract_frames
Compress the 4-second clip.mp4 to 1 second (keep pitch) → mediakit_change_speed
```

### CLI (no host needed)

```bash
# Frame extraction
gospelo-mediakit extract-frames clip.mp4                 # first+last → clip_first.png / clip_last.png
gospelo-mediakit extract-frames clip.mp4 --which last --overwrite

# Speed change (frame rate maintained; pitch & volume preserved)
gospelo-mediakit change-speed clip.mp4 --target-duration 1   # 4s→1s, output clip_1s.mp4
gospelo-mediakit change-speed clip.mp4 --speed 200           # 2x faster (shorter), clip_2x.mp4
gospelo-mediakit change-speed clip.mp4 --speed 50            # half speed (longer)
gospelo-mediakit change-speed clip.mp4 --target-duration 1 --fps 24

# Colour match a generated clip toward the original frame (fixes AI colour drift)
gospelo-mediakit color-match generated.mp4 --reference original_frame.png

# One-shot, no install, via uvx (the CLI script lives in the same distribution):
uvx --from gospelo-mediakit-mcp gospelo-mediakit change-speed clip.mp4 --target-duration 1
```

## Tools

### `mediakit_extract_frames` — first/last frame extraction

| Arg | Default | Description |
|-----|---------|-------------|
| `video_path` | (required) | Input video |
| `out_dir` | video's directory | Output directory |
| `prefix` | video's stem | Output basename prefix |
| `fmt` | `png` | Image format |
| `which` | `both` | `first` / `last` / `both` |
| `overwrite` | `false` | Overwrite existing output |

> **Why ffmpeg:** the last frame is unreliable via OpenCV's
> `CAP_PROP_POS_FRAMES` seek (black/dropped frames depending on the codec). This
> tool uses ffmpeg `-sseof` (seek from the end and overwrite until EOF) to grab
> it reliably.

### `mediakit_change_speed` — speed change (keeps fps, pitch & volume)

| Arg | Default | Description |
|-----|---------|-------------|
| `video_path` | (required) | Input video |
| `speed` | `100` | Speed percent (100 = original, 200 = 2x faster/shorter, 50 = half/longer) |
| `target_duration` | none | Target output seconds (overrides `speed`; hard-trimmed exactly) |
| `fps` | source fps | Output frame rate (default keeps source; set to also convert) |
| `out_dir` / `prefix` / `overwrite` | — | Same as the extraction tool |

> **How the frame rate is maintained:** `setpts` alone crams every frame into the
> shorter duration and inflates the fps; the `fps` filter restores the source
> rate by **nearest-timestamp drop/duplicate (no pixel blending)**. Audio uses
> `atempo` (a tempo change that preserves pitch and volume; chained beyond 2x).

### `mediakit_color_match` — match colour toward a reference image

| Arg | Default | Description |
|-----|---------|-------------|
| `video_path` | (required) | The colour-shifted / generated video |
| `reference_image` | (required) | Image whose colour is the target (e.g. the original frame) |
| `method` | `gain` | `gain` (multiplicative) or `offset` (additive) |
| `strength` | `1.0` | 0..1 blend of the correction with identity |
| `out_dir` / `prefix` / `overwrite` | — | Same as the other tools |

> **Why:** AI video generators (e.g. Seedance) drift colour from the source frame
> — commonly dropping the blue channel. This measures the per-channel average of
> the reference image vs the video (ffmpeg `scale=1:1` area-average) and applies a
> per-channel `gain`/`offset` across the whole clip. Dependency-free. It is a
> single global correction (matches the average); per-time drift is not corrected.

## Output details (for LLM integration)

Both tools return enough information to explain and reproduce what they did:

- `input_format` / `output_format` (or `info`) — container, codec, resolution,
  fps, frame count, bit rate, size, audio (codec / sample_rate / channels).
- `processing` — the filter chains applied, the frame-resampling method, frame
  counts, the encoder, the **full ffmpeg command**, and a one-line summary.

## Layout

```
mediakit/
├── README.md / README_jp.md
├── pyproject.toml                      # one distribution: gospelo-mediakit-mcp
├── gospelo_mediakit/                   # the importable package
│   ├── cli.py                          # CLI subcommand dispatcher
│   ├── mcp_server.py                   # FastMCP thin wrapper + cli mode
│   ├── core/                           # ★ the logic (ffmpeg wrappers)
│   │   ├── frames.py                   #   extract_endframes
│   │   ├── speed.py                    #   change_speed
│   │   ├── color_match.py              #   color_match
│   │   ├── ffmpeg.py                   #   run_ffmpeg / probe / has_audio
│   │   └── errors.py
│   └── tools/
│       ├── extract_frames.py           # thin CLI wrapper
│       ├── change_speed.py             # thin CLI wrapper
│       └── color_match.py              # thin CLI wrapper
├── skills/
│   ├── setup.sh                        # local-dev: .venv + register all hosts
│   ├── claude/gospelo-mediakit/skill.md
│   └── codex/gospelo-mediakit/SKILL.md
└── tests/
```

## Adding a new tool

1. Write the logic in `gospelo_mediakit/core/<feature>.py` (ffmpeg via subprocess).
2. Add a thin `gospelo_mediakit/tools/<feature>.py` (argparse → core → JSON).
3. Add one line to `_SUBCOMMANDS` in `cli.py`.
4. Add a ~20-line `@mcp.tool()` in `gospelo_mediakit/mcp_server.py` (just calls the core).

## Publishing (maintainers)

```bash
python -m build           # or: uv build  → dist/gospelo_mediakit_mcp-*.whl + .tar.gz
twine upload dist/*       # or: uv publish
```

After release, end users need nothing but `uvx gospelo-mediakit-mcp` in their MCP config.

## License

MIT — see [LICENSE.md](LICENSE.md).
