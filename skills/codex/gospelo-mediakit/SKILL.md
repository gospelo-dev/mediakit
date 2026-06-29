---
name: gospelo-mediakit
description: Video utilities for AI video production. (1) mediakit_extract_frames — first/last frame to image files. (2) mediakit_change_speed — re-time a clip (e.g. 4s->1s) keeping frame rate and audio pitch/volume. The gospelo_mediakit package (distribution gospelo-mediakit-mcp) does the deterministic ffmpeg work; Codex calls the MCP tools. Results include input_format/output_format and a processing block (filters applied + full ffmpeg command). Registered once in ~/.codex/config.toml, shared by the Codex CLI and App.
---

# gospelo-mediakit (Codex flavour)

Video utilities, done by the `mediakit_*` MCP tools; this skill describes how to
call them. Do **not** re-implement ffmpeg/OpenCV inline.

## When to invoke

- "get the first/last frame", "save the start/end image", "thumbnail"
  -> `mediakit_extract_frames`
- "compress this 4s clip to 1s", "make it 2x faster", "slow it to half speed"
  (keep frame rate; keep audio pitch/volume) -> `mediakit_change_speed`

## One-time setup

Once the package is published, register the zero-install runner (all OSes):

```bash
codex mcp add gospelo-mediakit -- uvx gospelo-mediakit-mcp
```

For local development of this repo instead, `bash skills/setup.sh` builds an
editable `.venv` and registers `.venv/bin/gospelo-mediakit-mcp`. Either way,
re-open the Codex session afterwards. Requires `ffmpeg` (and optionally
`ffprobe`) — set `GOSPELO_MEDIAKIT_FFMPEG` in the server's env if it is not on PATH.

## Steps

Each tool is a single deterministic call — no sub-agent fan-out needed.

### Frame extraction — `mediakit_extract_frames`

```
mediakit_extract_frames {
  "video_path": "<absolute video path>",
  "out_dir":    <out-dir or null>,
  "prefix":     <prefix or null>,
  "fmt":        "png",
  "which":      "first" | "last" | "both",
  "overwrite":  false
}
```

### Speed change — `mediakit_change_speed`

Keeps frame rate; preserves audio pitch and volume.

```
mediakit_change_speed {
  "video_path":      "<absolute video path>",
  "speed":           100,            // percent: 200=2x faster (shorter), 50=half speed
  "target_duration": null,           // seconds; overrides speed, trimmed exactly
  "fps":             null,           // default keeps source fps
  "out_dir":         null,
  "prefix":          null,
  "overwrite":       false
}
```

### Report

- `ok == true`: report the output path and key metadata (duration / fps /
  resolution from `output_format`). If the user asks *how* it was made, show
  `processing.summary` and `processing.ffmpeg_command`.
- `ok == false`: show `error` and suggest the fix (see table).

## Batch / multiple files (parallelism note)

Each call processes **one** video. When the user asks for several files:

- **If the host can dispatch tool calls in parallel** (e.g. Claude Code issues
  multiple tool uses in one turn), run one call per file concurrently.
- **If the host cannot run tool calls in parallel** (Codex and most non–Claude-Code
  hosts run them one at a time), process the files **sequentially** — call the
  tool, wait for the JSON, then call it for the next file. This is fully
  supported; it is only slower, never incorrect. Each call is short and
  deterministic, so there is no timeout concern. Do **not** try to pack multiple
  files into a single call or write a shell loop that re-implements the tool —
  just call the MCP tool once per file in turn.

Report a one-line per-file summary as each call returns so the user sees
progress during a sequential batch.

## Error handling

| `error` | Fix |
|---|---|
| `input video not found` | Check the path |
| `ffmpeg not found on PATH` | `brew install ffmpeg` |
| `output already exists` | Pass `overwrite=true`, or change `out_dir`/`prefix` |
| `ffmpeg failed to extract …` | Likely corrupt / unsupported codec; inspect the stderr excerpt |

## Fallback without an MCP host

The same logic is a plain CLI, so a shell/CI step can call it directly:

```bash
uvx --from gospelo-mediakit-mcp gospelo-mediakit extract-frames /path/clip.mp4 --overwrite
# or, if the package is installed: gospelo-mediakit extract-frames /path/clip.mp4 --overwrite
```

## See also

- [README.md](../../../README.md) — package overview, install, publishing
- [skills/claude/gospelo-mediakit/skill.md](../../claude/gospelo-mediakit/skill.md) — Claude Code flavour
