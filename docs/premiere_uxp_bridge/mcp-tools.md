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

すべてのツールは**読み取り専用**。プロジェクト・タイムライン・メディアを変更しない。

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

## ブリッジ allowlist との対応

Python ブリッジ（`gospelo_mediakit/premiere/bridge.py`）はメソッド allowlist で
未登録の要求を拒否する。現在の対応:

| MCP ツール | ブリッジメソッド | 種別 |
|---|---|---|
| `premiere_bridge_status` | （ブリッジ状態のみ、パネル呼び出しなし） | read |
| `premiere_list_project_assets` | `project.assets.list` | read |
| `premiere_get_sequence_state` | `sequence.getState` | read |

新しい操作は、UXP ハンドラと Python allowlist の**両方**に明示的に追加した
もののみ有効になる（任意コード実行は非対応・非方針）。
