---
name: gospelo-mediakit
description: AI 映像制作向けの動画ユーティリティ。(1) 最初/最後のフレームを png 等で書き出す mediakit_extract_frames、(2) 速度変更(4秒→1秒など。フレームレート維持・音声ピッチ/音量不変)の mediakit_change_speed。実装は gospelo_mediakit パッケージ(配布物 gospelo-mediakit-mcp、ffmpeg ベースの決定論的処理)が持ち、Claude Code は .mcp.json 経由で MCP ツールとして直接呼ぶ。返り値に input_format/output_format と processing(適用フィルタ・ffmpeg コマンド全文)を含む。
allowed-tools: mcp__gospelo-mediakit__mediakit_extract_frames mcp__gospelo-mediakit__mediakit_change_speed Read Bash(ffmpeg:*) Bash(ffprobe:*)
---

# gospelo-mediakit (Claude Code 版)

AI 映像制作向けの動画ユーティリティ。**(1) 最初/最後のフレーム抽出**と
**(2) 速度変更(fps 維持・ピッチ/音量不変)** を提供するスキル。

> **実装は MCP サーバ。** ロジックの実体は `gospelo_mediakit` パッケージの MCP サーバ
> (`mcp_server.py` + `gospelo_mediakit.core` の ffmpeg ラッパー) が持つ。Claude Code は
> プロジェクトルートの `.mcp.json` 経由で **`mediakit_extract_frames` を MCP ツールとして
> 直接呼び出す**。Codex 版 ([`skills/codex/gospelo-mediakit/`](../../codex/gospelo-mediakit/SKILL.md))
> と同じ venv バイナリを共有する。

## Usage

```
/gospelo-mediakit <video>                       # 最初と最後の両方を抽出
/gospelo-mediakit <video> --which last          # 最後だけ
/gospelo-mediakit <video> --out-dir ./frames    # 出力先指定
/gospelo-mediakit <video> --fmt jpg --overwrite # jpg・上書き
```

## One-time setup

リポジトリルートで:

```bash
bash skills/setup.sh
```

`skills/setup.sh` が venv ビルド + `.mcp.json`(Claude Code)/ Codex への登録 + symlink を
一括実行する。Claude Code のセッションを開き直すと `mediakit_extract_frames` が
MCP ツールとして使えるようになる。前提: システムに `ffmpeg`(任意で `ffprobe`)。

## 実行手順

要望に応じて該当ツールを **1 回呼ぶ**。ffmpeg/OpenCV を Bash で直接叩いて再実装しない。

### フレーム抽出 → `mediakit_extract_frames`

```
mediakit_extract_frames {
  "video_path": "<user video path>",
  "out_dir":    <user out-dir or null>,
  "prefix":     <user prefix or null>,
  "fmt":        <user fmt, default "png">,
  "which":      <"first" | "last" | "both", default "both">,
  "overwrite":  <user value, default false>
}
```

返り値: `first_frame` / `last_frame`(絶対パス)、`info`(入力フォーマット)、
`processing`(各画像の生成方法・ffmpeg コマンド)。

### 速度変更 → `mediakit_change_speed`

「4秒を1秒に」「2倍速に」「半分の速度に」等の要望で呼ぶ。
フレームレートは維持、音声のピッチ・音量は保たれる。

```
mediakit_change_speed {
  "video_path":      "<user video path>",
  "speed":           <percent, default 100。200=2倍速で短く / 50=半分で長く>,
  "target_duration": <秒数。指定時は speed より優先し厳密に切り揃え>,
  "fps":             <出力 fps。既定は元の fps を維持>,
  "out_dir":         <or null>,
  "prefix":          <or null>,
  "overwrite":       <default false>
}
```

返り値: `output`(絶対パス)、`output_duration` / `fps` / `factor`、
`input_format` / `output_format`(コンテナ・コーデック・解像度等)、
`processing`(適用フィルタ・フレーム間引き方式・**実行した ffmpeg コマンド全文**・サマリ)。

### 報告のしかた

- `ok == true`: 出力パスと主要メタ(尺/fps/解像度)を 1 つにまとめて報告。
  ユーザーが「どう処理したか」を聞いたら `processing.summary` と
  `processing.ffmpeg_command` を提示する。
- `ok == false`: `error` を表示して対処を促す。

### 複数ファイルの一括処理(並列性)

各呼び出しは **1 ファイル** を処理する。複数ファイルが渡されたら、Claude Code は
**1 メッセージ内で複数のツール呼び出しを並列発行**してよい(各呼び出しは独立)。
並列でツール呼び出しできないホスト(Codex 等)では **1 ファイルずつ逐次** 呼ぶ —
各呼び出しは短時間・決定論的なので遅くなるだけで正しさには影響しない。
1 回の呼び出しに複数ファイルを詰め込んだり、Bash ループで ffmpeg を再実装したりしない。

## エラーハンドリング

| `error` の内容 | 対応 |
|---|---|
| `input video not found` | パスを確認するよう促す |
| `ffmpeg not found on PATH` | `brew install ffmpeg` を案内 |
| `output already exists` | `overwrite=true` を提案、または `out_dir`/`prefix` 変更 |
| `ffmpeg failed to extract …` | 破損/未対応コーデックの可能性。stderr 抜粋を提示 |

## Forbidden shortcuts

- `ffmpeg` / `ffprobe` を Bash で直接叩いてフレーム抽出を再実装しない(`mediakit_extract_frames` を使う)
- OpenCV の `CAP_PROP_POS_FRAMES` で最後のフレームを取りにいかない(取りこぼす)

## See also

- [README_jp.md](../../../README_jp.md) — パッケージ全体の概要
- [skills/codex/gospelo-mediakit/SKILL.md](../../codex/gospelo-mediakit/SKILL.md) — Codex 版
