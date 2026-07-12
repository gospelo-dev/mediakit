# gospelo-mediakit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/gospelo-dev/mediakit/blob/main/LICENSE.md) [![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776AB.svg?logo=python&logoColor=white)](https://www.python.org/) [![Powered by FFmpeg](https://img.shields.io/badge/Powered_by-FFmpeg-007808.svg?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/) [![MCP](https://img.shields.io/badge/MCP-Claude_Code_%7C_Desktop_%7C_Codex-6e40c9.svg)](https://modelcontextprotocol.io/)

*[English](README.md) | 日本語*

映像制作で地味に使う **便利ツールを MCP でまとめた** ユーティリティ集です。
今は動画の **最初/最後フレーム抽出**、**速度変更**(fps 維持・ピッチ不変)、
**色味補正**(AI 生成の色ズレを参照画像に合わせる)を収録。
中身は ffmpeg を叩くだけの小さな処理だけですがアップデートしていきます。

3 つの呼び出し口を持つが、ロジックの実体は **1 か所** (`gospelo_mediakit/core/`)
にだけ存在する「薄いラッパー」構成:

<p align="center">
  <img src="https://raw.githubusercontent.com/gospelo-dev/mediakit/main/images/architecture.png" alt="gospelo-mediakit アーキテクチャ: 多ホスト・単一コア" width="860">
</p>

<details>
<summary>テキスト版 (ASCII)</summary>

```
                ┌─ Claude Code   (.mcp.json, プロジェクト)        ─┐
                │  Claude Desktop (claude_desktop_config.json)    │
  MCP stdio  ◄──┤  Codex CLI      (~/.codex/config.toml)          │ ←─ 全ホストが
   server    ◄──┤  Codex App      (~/.codex/config.toml ※同一)    │    同じ venv
 (薄wrapper)    └────────────────────────────────────────────────┘    バイナリを叩く
        │
        ▼  import
  gospelo_mediakit.core   ◄── CLI (gospelo-mediakit / python -m …) も同じ core を呼ぶ
   (ffmpeg を subprocess)
```

</details>

対応ホスト（`bash skills/setup.sh` が全て登録）:

| ホスト | 登録先 | スコープ |
|--------|--------|----------|
| Claude Code | `.mcp.json`(プロジェクト) | このリポジトリ内 |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | グローバル |
| Codex CLI | `~/.codex/config.toml` | グローバル |
| Codex App | `~/.codex/config.toml`(CLI と同一ファイル) | グローバル |

> **GUI アプリ(Claude Desktop / Codex App)の注意**: シェルの PATH を継承しないため、
> 本サーバは `ffmpeg`/`ffprobe` を **PATH → `/opt/homebrew/bin` 等の定番ディレクトリ →
> 環境変数 `GOSPELO_MEDIAKIT_FFMPEG`/`GOSPELO_MEDIAKIT_FFPROBE`** の順で自動探索する。
> setup.sh は Claude Desktop エントリに PATH も注入する。設定変更後は**アプリを完全再起動**。

- **コア** `gospelo_mediakit/core/` — ffmpeg を叩く決定論的 Python(LLM 不使用)。
- **CLI** `gospelo-mediakit extract-frames …` — core の薄い wrapper。CI / シェル用。
- **MCP サーバ** `gospelo_mediakit/mcp_server.py` — FastMCP の ~20 行 wrapper。
  CLI と MCP の 2 つの実行コマンドが**単一配布物 `gospelo-mediakit-mcp`** に同梱。

## セットアップ

配布物は **`gospelo-mediakit-mcp`** 1 つで、MCP サーバと CLI の両方を含む。
前提: システムの `ffmpeg`(任意で `ffprobe`)。下記 uvx 方式には [uv](https://docs.astral.sh/uv/) が必要。

### 推奨: `uvx` でゼロインストール(全OS共通)

各ホストの MCP 設定を `uvx gospelo-mediakit-mcp` に向けるだけ。`uv` が必要時に
パッケージ(と適切な Python)を取得するので、clone も venv も絶対パスも不要。
**同じ設定が macOS / Linux / Windows で動く**:

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

> 初回起動でパッケージを取得する。ホストが spawn タイムアウトする場合は
> `uv tool install gospelo-mediakit-mcp`(常駐インストール)で事前取得するか再試行。
> ffmpeg のパスは下記の `env` ブロックで指定する。

### ローカル開発(macOS / Linux)

本リポジトリを改造する場合は、editable な `.venv` を作って全ホストに登録:

```bash
bash skills/setup.sh
```

`pip install -e .` を実行し、`.venv/bin/gospelo-mediakit-mcp` を 4 ホストに登録、
Claude スキルを symlink する。実行後はセッション/アプリを開き直す(GUI は**完全再起動**)。
Windows では上記 uvx 設定を使う(本スクリプトは bash 専用)。

### ffmpeg のパス指定(Windows / GUI アプリ)

GUI ホスト(Claude Desktop / Codex App)はシェルの PATH を継承しないため、
**環境変数 `GOSPELO_MEDIAKIT_FFMPEG` を MCP 設定の `env` ブロックに書くのが最も確実**。
値は ffmpeg 実行ファイル**または** `bin` ディレクトリのどちらでも可。
(`GOSPELO_MEDIAKIT_FFPROBE` も同様。任意。)

Claude Code / Claude Desktop(`.mcp.json` / `claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "gospelo-mediakit": {
      "command": "uvx",
      "args": ["gospelo-mediakit-mcp"],
      "env": {
        // Windows — ffmpeg.exe のパス、または bin ディレクトリ:
        "GOSPELO_MEDIAKIT_FFMPEG": "C:\\ffmpeg\\bin\\ffmpeg.exe"
        // macOS/Linux の例: "/opt/homebrew/bin/ffmpeg"
      }
    }
  }
}
```

Codex(`~/.codex/config.toml`):

```toml
[mcp_servers.gospelo-mediakit.env]
GOSPELO_MEDIAKIT_FFMPEG = "C:\\ffmpeg\\bin"   # ファイル or bin ディレクトリ
```

未指定でも `PATH` と定番ディレクトリ(macOS `/opt/homebrew/bin` 等、Windows
`C:\ffmpeg\bin` / `%ProgramFiles%\ffmpeg\bin` / scoop shims)を自動探索する。
ffmpeg の導入は `winget install ffmpeg`(Windows)/ `brew install ffmpeg`(macOS)。

## 使い方

### Claude Code / Claude Desktop / Codex(MCP ツール)

```
最初と最後のフレームを clip.mp4 から抜き出して     → mediakit_extract_frames
4秒の clip.mp4 を1秒に圧縮して(ピッチ維持)         → mediakit_change_speed
```

### CLI(ホスト不要)

```bash
# フレーム抽出
gospelo-mediakit extract-frames clip.mp4                 # 最初+最後 → clip_first.png / clip_last.png
gospelo-mediakit extract-frames clip.mp4 --which last --overwrite

# 速度変更(フレームレート維持・ピッチ/音量不変)
gospelo-mediakit change-speed clip.mp4 --target-duration 1   # 4s→1s, 出力 clip_1s.mp4
gospelo-mediakit change-speed clip.mp4 --speed 200           # 2倍速(短く), clip_2x.mp4
gospelo-mediakit change-speed clip.mp4 --speed 50            # 半分の速度(長く)
gospelo-mediakit change-speed clip.mp4 --target-duration 1 --fps 24

# 色味補正(生成動画を元フレームの色に合わせる。AI の色ズレ対策)
gospelo-mediakit color-match generated.mp4 --reference original_frame.png

# uvx で一発実行(インストール不要。CLI は同じ配布物に同梱):
uvx --from gospelo-mediakit-mcp gospelo-mediakit change-speed clip.mp4 --target-duration 1
```

## ツール一覧

### `mediakit_extract_frames` — 最初/最後フレーム抽出

| Arg | Default | 説明 |
|-----|---------|------|
| `video_path` | (必須) | 入力動画 |
| `out_dir` | 動画と同じ場所 | 出力先 |
| `prefix` | 動画の stem | 出力名の接頭辞 |
| `fmt` | `png` | 画像フォーマット |
| `which` | `both` | `first` / `last` / `both` |
| `overwrite` | `false` | 既存上書き |

> **なぜ ffmpeg か**: 最後のフレームは OpenCV の `CAP_PROP_POS_FRAMES` seek だと
> コーデック次第で黒画/取りこぼしが起きる。本ツールは ffmpeg `-sseof`(末尾から
> シークして EOF まで上書き)で確実に取得する。

### `mediakit_change_speed` — 速度変更(fps維持・ピッチ/音量不変)

| Arg | Default | 説明 |
|-----|---------|------|
| `video_path` | (必須) | 入力動画 |
| `speed` | `100` | 速度%（100=等速 / 200=2倍速で短く / 50=半分で長く） |
| `target_duration` | なし | 出力秒数を指定（`speed` より優先・厳密に切り揃え） |
| `fps` | 元の fps | 出力フレームレート（既定は維持。指定で変換も可） |
| `out_dir` / `prefix` / `overwrite` | — | 抽出ツールと同じ |

> **fps 維持の仕組み**: `setpts` だけだと全フレームを詰めて fps が上がる。`fps` フィルタで
> 元の fps に戻し、**最近傍タイムスタンプで間引き(drop/duplicate、画素合成はしない)**。
> 音声は `atempo`(テンポ変更でピッチ・音量を保持、2倍超は連鎖)。

### `mediakit_color_match` — 参照画像に色味を合わせる

| Arg | Default | 説明 |
|-----|---------|------|
| `video_path` | (必須) | 色ズレした/生成された動画 |
| `reference_image` | (必須) | 目標の色を持つ画像(元フレーム等) |
| `method` | `gain` | `gain`(乗算) / `offset`(加算) |
| `strength` | `1.0` | 補正の強さ 0..1(1.0=フル) |
| `out_dir` / `prefix` / `overwrite` | — | 他ツールと同じ |

> **用途**: Seedance 等の AI 生成は元フレームから色がズレやすく(特に青が落ちる)。
> 参照画像と動画のチャンネル平均(ffmpeg `scale=1:1` の面積平均)を比べ、per-channel の
> `gain`/`offset` を全体に適用して戻す。**依存追加なし**。全体一律の補正なので、
> 時間方向のドリフト(先頭と末尾でズレ量が違う場合)は補正しない。

### `mediakit_probe` — メディア情報の取得(画角・fps・コーデック)

| Arg | Default | 説明 |
|-----|---------|------|
| `video_path` | (必須) | 調べるメディアファイル(動画・音声どちらも可) |

> **用途**: シーケンス設定やテロップサイズを決める前に素材の画角・fps・長さを
> 知りたいとき。読み取り専用の ffprobe ラッパーで、`width`/`height`/`fps`/
> `nb_frames`/`duration_seconds`/コーデック/音声情報を返す。

### `mediakit_sample_color` — フレーム内の指定位置のカラーコード取得

| Arg | Default | 説明 |
|-----|---------|------|
| `media_path` | (必須) | 動画または画像ファイル |
| `time_seconds` | `0` | 動画のフレーム時刻(画像では無視) |
| `x` / `y` | `0` | ピクセル位置(左上原点) |
| `region` | `1` | (x,y) からの NxN 平均。1 = 正確な1ピクセル |

> **用途**: クロマキーのキーカラー取得、特定箇所の色ズレ確認、レンダリング結果の
> 色検証。rgb24 変換を crop より先に行うため、クロマサブサンプリングの影響を
> 受けない正確な値を返す。`rgb` / `hex` / フレームサイズ / ffmpeg コマンド全文を返す。

## 出力に含まれる情報(LLM 連携用)

両ツールの返り値には、生成方法とフォーマットを説明・再現するための情報が入る:

- `input_format` / `output_format`(または `info`) — コンテナ・コーデック・解像度・
  fps・フレーム数・ビットレート・サイズ・音声(codec/sample_rate/channels)
- `processing` — 適用したフィルタ列、フレーム間引き方式、フレーム数、エンコーダ、
  **実行した ffmpeg コマンド全文**、1行サマリ

## ディレクトリ構成

```
mediakit/
├── README.md / README_jp.md
├── pyproject.toml                      # 単一配布物: gospelo-mediakit-mcp
├── gospelo_mediakit/                   # import するパッケージ
│   ├── cli.py                          # CLI サブコマンドディスパッチャ
│   ├── mcp_server.py                   # FastMCP 薄wrapper + cli モード
│   ├── core/                           # ★ ロジック本体(ffmpeg ラッパー)
│   │   ├── frames.py                   #   extract_endframes
│   │   ├── speed.py                    #   change_speed
│   │   ├── color_match.py              #   color_match
│   │   ├── ffmpeg.py                   #   run_ffmpeg / probe / has_audio
│   │   └── errors.py
│   └── tools/
│       ├── extract_frames.py           # CLI 薄wrapper
│       ├── change_speed.py             # CLI 薄wrapper
│       └── color_match.py              # CLI 薄wrapper
├── skills/
│   ├── setup.sh                        # ローカル開発: .venv + 全ホスト登録
│   ├── claude/gospelo-mediakit/skill.md
│   └── codex/gospelo-mediakit/SKILL.md
└── tests/
```

## 新しいツールを足すとき

1. `gospelo_mediakit/core/<feature>.py` にロジックを書く(ffmpeg 等を subprocess)。
2. `gospelo_mediakit/tools/<feature>.py` に argparse → core → JSON の薄 wrapper。
3. `cli.py` の `_SUBCOMMANDS` に 1 行追加。
4. `gospelo_mediakit/mcp_server.py` に `@mcp.tool()` を ~20 行追加(core を呼ぶだけ)。

## 公開(メンテナ向け)

```bash
python -m build           # または uv build  → dist/gospelo_mediakit_mcp-*.whl + .tar.gz
twine upload dist/*       # または uv publish
```

公開後、利用者は MCP 設定に `uvx gospelo-mediakit-mcp` を書くだけでよい。

## ライセンス

MIT — [LICENSE.md](LICENSE.md) を参照。
