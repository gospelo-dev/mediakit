# gospelo-mediakit MCP server

AI 映像制作向けの **決定論的メディアユーティリティ** を MCP ツールとして公開する
**薄いラッパー**。ロジックの実体はリポジトリルートの `gospelo_mediakit` パッケージ
(`core/`) が持ち、本サーバは `core` の関数を呼ぶだけ (各ツール ~20 行)。

同じ venv バイナリを **Claude Code** (`.mcp.json`) と **Codex** (`codex mcp add`)
が共有する。設定ファイル不要・外部依存なし (ffmpeg/ffprobe バイナリのみ)。

## セットアップ

リポジトリルートで一括:

```bash
bash skills/setup.sh
```

または本サーバ単体で venv だけ作る:

```bash
cd mcp-server/gospelo-mediakit
./setup_venv.sh
```

依存: Python 3.11+ / `fastmcp` / システムに `ffmpeg`(+ 任意で `ffprobe`)。

## 提供ツール

| Tool | 役割 |
|------|------|
| `mediakit_extract_frames` | 動画の **最初/最後のフレーム**を画像ファイル(png 等)として書き出す。最後のフレームは ffmpeg `-sseof` で確実に取得する |

### `mediakit_extract_frames` 引数

| Arg | Type | Default | 説明 |
|-----|------|---------|------|
| `video_path` | string | (必須) | 入力動画 (mp4/mov/…) |
| `out_dir` | string | 動画と同じ場所 | 出力ディレクトリ(無ければ作成) |
| `prefix` | string | 動画のファイル名 stem | 出力ファイル名の接頭辞 |
| `fmt` | string | `png` | 画像フォーマット/拡張子 |
| `which` | string | `both` | `first` / `last` / `both` |
| `overwrite` | bool | `false` | 既存ファイルを上書きするか |

返り値: `{ ok, video_path, out_dir, first_frame, last_frame, info{width,height,fps,nb_frames,duration_seconds} }`。
失敗時: `{ ok: false, error }`。

## 動作確認

```bash
# 一発 CLI モード(MCP セッション不要)
./venv/bin/gospelo-mediakit-mcp cli mediakit_extract_frames \
  --json '{"video_path":"/path/to/clip.mp4","which":"both","overwrite":true}'

# MCP stdio モードで起動(通常はホストが spawn する)
./venv/bin/gospelo-mediakit-mcp
```

## ディレクトリ構成

```
mcp-server/gospelo-mediakit/
├── README.md                # 本ファイル
├── pyproject.toml           # fastmcp + core path 依存
├── setup_venv.sh            # venv 構築(core を editable install)
├── venv/                    # gitignore
└── src/gospelo_mediakit_mcp/
    ├── __init__.py
    └── server.py            # FastMCP 薄いラッパー + cli モード
```

ロジック本体は [`../../gospelo_mediakit/core/`](../../gospelo_mediakit/core/) を参照。
