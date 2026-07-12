# gospelo-premiere-mcp ツールリファレンス（動作確認済み）

`gospelo-premiere-mcp` が現時点で提供する MCP ツールの一覧。掲載しているのは
**実機の Adobe Premiere Pro に対してエンドツーエンドで動作確認済み**のものだけ。
セットアップ（証明書・トークン・UXP パネル）は
[premiere_uxp_bridge/README.md](../../premiere_uxp_bridge/README.md) を参照。
全体設計とロードマップは [agent-architecture.md](agent-architecture.md) を参照。

## 検証環境

| 項目 | 値 |
|---|---|
| 検証日 | 2026-07-12 |
| Premiere Pro | 25.6+（UXP manifest `minVersion: 25.6.0`） |
| 接続方式 | WSS（Let's Encrypt 証明書 + /etc/hosts loopback）、token 認証 |
| 検証プロジェクト | `demo-project.prproj` |

すべてのツールは**プロジェクトに対して読み取り専用**。プロジェクト・タイムライン・
メディアを変更しない（`premiere_export_frame` は静止画ファイルを書き出すが、
プレイヘッドも含めて Premiere 側の状態は変えない）。

---

## premiere_bridge_status

ブリッジの待受状態と UXP パネルの接続有無を返す。セットアップ確認用。

**引数**: なし

**戻り値**:

```json
{"ok": true, "endpoint": "wss://127.0.0.1:47653", "connected": true}
```

環境変数が不足している場合などは `{"ok": false, "error": "..."}`。

---

## premiere_list_project_assets

アクティブなプロジェクトのアセット（ビン・メディア・シーケンス）を
ルートから再帰的に列挙する。ブリッジメソッド `project.assets.list` を呼ぶ。

**引数**:

| 名前 | 型 | 既定値 | 説明 |
|---|---|---|---|
| `include_bins` | bool | `true` | root / bin の行も含める |
| `timeout_seconds` | float | `20.0` | 接続・応答タイムアウト（1〜60 秒） |

**戻り値**（実測データの抜粋）:

```json
{
  "ok": true,
  "project": {
    "id": "2f38b1d1-20cc-4600-bcc0-74b00855177d",
    "name": "demo-project.prproj",
    "path": "/…/demo-project.prproj"
  },
  "assets": [
    {"id": "…", "parentId": null, "name": "demo-project.prproj", "kind": "root", "mediaPath": null, "offline": false},
    {"id": "…", "parentId": "…", "name": "narration", "kind": "sequence", "mediaPath": null, "offline": false},
    {"id": "…", "parentId": "…", "name": "misaki_0.mp4", "kind": "media", "mediaPath": "/…/misaki_0.mp4", "offline": false}
  ]
}
```

`kind` は `root` / `bin` / `sequence` / `media`。`media` は `mediaPath`（取得できる
場合）と `offline` を持つ。

**検証結果**: 17 アセット（root 1、sequence 1、音声 3、映像 12）を階層付きで取得。

---

## premiere_get_sequence_state

アクティブなシーケンスの構造化状態（L1 観測）を JSON で返す。
自律エージェントが「編集が意図どおり反映されたか」を確定判定するための
主観測メソッド。ブリッジメソッド `sequence.getState` を呼ぶ。

**引数**:

| 名前 | 型 | 既定値 | 説明 |
|---|---|---|---|
| `include_reflection` | bool | `false` | `_reflect`（sequence/track/trackItem で利用可能な UXP メソッド名一覧）を付加。API カバレッジ診断用 |
| `timeout_seconds` | float | `20.0` | 接続・応答タイムアウト（1〜60 秒） |

**戻り値**（実測データの抜粋）:

```json
{
  "ok": true,
  "project": {"name": "demo-project.prproj", "path": "/…/demo-project.prproj"},
  "sequence": {
    "name": "narration",
    "playheadSeconds": 0,
    "videoTrackCount": 7,
    "audioTrackCount": 5
  },
  "videoTracks": [
    {
      "index": 0,
      "kind": "video",
      "name": "ビデオ 1",
      "items": [
        {
          "name": "man_walk0-1.mp4",
          "startSeconds": 0,
          "endSeconds": 9.4,
          "inSeconds": 0,
          "outSeconds": 9.4,
          "mediaPath": "/…/man_walk0-1.mp4"
        }
      ]
    }
  ],
  "audioTracks": [{"index": 0, "kind": "audio", "name": "オーディオ 1", "items": ["…"]}],
  "diagnostics": []
}
```

- 時刻はすべて**秒**（Premiere 内部の ticks を `254016000000 ticks/秒` で変換）。
- `startSeconds`/`endSeconds` はタイムライン上の配置、`inSeconds`/`outSeconds` は
  ソースのトリミング位置。
- `diagnostics` には個別に失敗した UXP 呼び出しが記録される（全成功なら空）。
  一部のクリップで取得に失敗しても、残りの結果は返る（防御的設計）。

**エラー**:

| 状況 | 挙動 |
|---|---|
| パネル未接続 | `{"ok": false, "error": "Premiere UXP panel is not connected. …"}` |
| シーケンス未オープン | `{"ok": false, "error": "No active sequence. Open a sequence in the timeline, then retry."}` |

**検証結果**: シーケンス `narration`（V7 + A5 トラック）から 58 クリップの
名前・配置・イン/アウト・メディアパスを全件取得。`diagnostics` は空
（UXP 呼び出し失敗 0 件）。

---

## premiere_export_frame

アクティブなシーケンスの指定時刻のフレームを静止画として書き出す（L2 観測）。
エージェントが「絵そのもの」（色・構図・意図したクリップが映っているか）を
判断するためのメソッド。ブリッジメソッド `program.exportFrame` を呼ぶ。

時刻は Premiere のエクスポータに直接渡すため、**プレイヘッドは動かない**。

**引数**:

| 名前 | 型 | 既定値 | 説明 |
|---|---|---|---|
| `time_seconds` | float | 現在のプレイヘッド位置 | 書き出すシーケンス時刻（秒） |
| `output_dir` | str | 環境変数 → 一時フォルダ | 出力先。優先順位: 引数 > `GOSPELO_PREMIERE_EXPORT_DIR` > `<tmp>/gospelo_premiere_frames`。自動作成される |
| `file_name` | str | `frame.png` | 拡張子で形式を選択（png / jpg / tif / tga / bmp / dpx / exr / gif） |
| `width` / `height` | int | シーケンスのフレームサイズ | 出力解像度 |
| `include_reflection` | bool | `false` | `_reflect`（Exporter / TickTime の利用可能メソッド一覧）を付加 |
| `timeout_seconds` | float | `30.0` | 接続・応答タイムアウト（1〜60 秒） |

**戻り値**（実測データ）:

```json
{
  "ok": true,
  "outputFile": "/…/frames/frame_170s.png",
  "fileExists": true,
  "outputDir": "/…/frames",
  "fileName": "frame_170s.png",
  "width": 960,
  "height": 720,
  "timeResolved": true,
  "exportReturn": true,
  "diagnostics": []
}
```

`fileExists` は MCP サーバ側（Premiere と同一マシン）でファイル生成を実確認した
結果。`diagnostics` の意味は `premiere_get_sequence_state` と同じ。

**エラー**: パネル未接続 / シーケンス未オープン時は
`premiere_get_sequence_state` と同様の `{"ok": false, "error": "..."}`。

**検証結果**: `time_seconds=170.0` で 960x720 PNG（1.04MB）を生成。
L1 状態が予測したとおり該当時刻のクリップ（`misaki_9_colormatched.mp4`、
169.56〜217.48s）の絵であることを画像で確認。diagnostics 空。
`_reflect` により実 API を確定: `Exporter.exportSequenceFrame` が唯一の
フレーム書き出しメソッド、`TickTime.createWithSeconds` / `createWithTicks` /
`createWithFrameAndFrameRate` が時刻生成手段。

---

## ブリッジ allowlist との対応

Python ブリッジ（`gospelo_mediakit/premiere/bridge.py`）はメソッド allowlist で
未登録の要求を拒否する。現在の対応:

| MCP ツール | ブリッジメソッド | 種別 |
|---|---|---|
| `premiere_bridge_status` | （ブリッジ状態のみ、パネル呼び出しなし） | read |
| `premiere_list_project_assets` | `project.assets.list` | read |
| `premiere_get_sequence_state` | `sequence.getState` | read |
| `premiere_export_frame` | `program.exportFrame` | read（静止画ファイルのみ書き出し） |

新しい操作は、UXP ハンドラと Python allowlist の**両方**に明示的に追加した
もののみ有効になる（任意コード実行は非対応・非方針）。
