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

観測系ツール（status / assets / state / frame）は**プロジェクトに対して読み取り専用**
（`premiere_export_frame` は静止画ファイルを書き出すが、プレイヘッドも含めて
Premiere 側の状態は変えない）。write 系ツール（create_project / insert_clip /
add_marker）はタイムライン等を変更するが、いずれも**単一の取り消し可能な
トランザクション**として実行され、既存メディアファイルは変更しない。
write 系のテストは使い捨てプロジェクト（`premiere_create_project` で作成）で行う。

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

## premiere_create_project（write）

新規の `.prproj` を作成してアクティブ化し、任意でメディア読み込みとシーケンス
作成まで行う。**write 系テストのための使い捨てプロジェクト作成**が主用途。
既存プロジェクト・メディアファイルは変更しない（アクティブが切り替わるのみ）。
ブリッジメソッド `project.create` を呼ぶ。

**引数**:

| 名前 | 型 | 既定値 | 説明 |
|---|---|---|---|
| `path` | str | 必須 | 新規 `.prproj` の絶対パス。既存パスは拒否 |
| `import_paths` | list[str] | なし | ルートビンに読み込むメディア（MCP 側で存在チェック） |
| `sequence_name` | str | なし | 指定時、読み込んだクリップからシーケンスを作成 |
| `include_reflection` | bool | `false` | `_reflect`（Project のメソッド一覧）を付加 |
| `timeout_seconds` | float | `45.0` | タイムアウト（1〜60 秒） |

**戻り値**（実測）: `{"ok": true, "created": true, "project": {name, path}, "importedCount": 1, "sequence": {"name": "bridge-test-seq"}, "diagnostics": []}`

**検証結果**: 使い捨てプロジェクトを新規作成 → `misaki_0.mp4` 読み込み →
シーケンス自動作成（V3/A3、クリップ 0〜7.2s 配置）。直後の
`sequence.getState` で新プロジェクトがアクティブになったことを観測確認。
`_reflect` で `executeTransaction` / `lockedAccess` / `createSequence` /
`deleteSequence` / `save` / `saveAs` / `close` 等の実在を確認。

---

## premiere_insert_clip（write）

アクティブなシーケンスにプロジェクトアイテムを挿入する。**タイムラインを変更
する**。単一の取り消し可能なトランザクション（Premiere の取り消しで戻せる）。
ブリッジメソッド `sequence.insertClip` を呼ぶ。実行後は
`premiere_get_sequence_state` で結果を確認する（act → observe）。

**引数**:

| 名前 | 型 | 既定値 | 説明 |
|---|---|---|---|
| `project_item_id` | str | 必須 | `premiere_list_project_assets` の asset ID |
| `time_seconds` | float | 必須 | 挿入位置（秒） |
| `video_track_index` / `audio_track_index` | int | `0` | 対象トラック（0 始まり） |
| `overwrite` | bool | `false` | `true` で上書き配置、`false` で挿入（後続シフト） |
| `limit_shift` | bool | `false` | 挿入時のシフトを対象トラックに限定 |
| `include_reflection` | bool | `false` | `_reflect`（SequenceEditor のメソッド一覧）を付加 |
| `timeout_seconds` | float | `30.0` | タイムアウト（1〜60 秒） |

**戻り値**（実測）: `{"ok": true, "inserted": true, "mode": "insert", "videoTrackIndex": 0, "audioTrackIndex": 0, "timeSeconds": 10, "diagnostics": []}`

**検証結果**: 使い捨てプロジェクトで t=10s に挿入 → `sequence.getState` で
クリップ行 2 → 4、新クリップが start=10 / end=17.2 に正確に配置されたことを
観測確認。

**実装上の重要点**: `create*Action` 系は `project.lockedAccess()` の**中で**
生成しないと `Requires locked access` エラーになる（アクション生成と
`executeTransaction` を同一の lockedAccess コールバック内で行う）。

---

## premiere_add_marker（write）

アクティブなシーケンスにマーカーを追加する。**シーケンスのマーカーを変更
する**。単一の取り消し可能なトランザクション。ブリッジメソッド
`sequence.addMarker` を呼ぶ。応答に書き込み後のマーカー数（読み返し）を含む。

**引数**:

| 名前 | 型 | 既定値 | 説明 |
|---|---|---|---|
| `name` | str | 必須 | マーカー名 |
| `time_seconds` | float | 必須 | 位置（秒） |
| `duration_seconds` | float | なし | 長さ（秒） |
| `comments` | str | なし | コメント |
| `marker_type` | str | `Comment` | マーカー種別 |
| `include_reflection` | bool | `false` | `_reflect`（Markers のメソッド一覧）を付加 |
| `timeout_seconds` | float | `30.0` | タイムアウト（1〜60 秒） |

**戻り値**（実測）: `{"ok": true, "added": true, "name": "bridge-marker", "timeSeconds": 5, "markerCount": 1, "diagnostics": []}`

**検証結果**: t=5s に 2 秒のコメント付きマーカーを追加、`markerCount: 1` を
読み返しで確認。`_reflect` で `createMoveMarkerAction` /
`createRemoveMarkerAction` の実在も確認（将来のマーカー編集の道具）。

---

## premiere_import_media（write）

メディアファイルを**アクティブプロジェクトのルートビンへ読み込む**
（`project.importMedia`）。ビンのみ変更・タイムライン非接触・ソース非改変。
新規アイテムは before/after の ID 差分で特定され `{id, name}` で返るため、
そのまま `premiere_insert_clip` に連鎖できる。MCP 側で全パスの存在を検証。

**引数**: `paths`（絶対パスのリスト・必須）, `timeout_seconds`（既定 45）

**戻り値**（実測）: `{"ok": true, "imported": true, "requestedCount": 1, "newItems": [{"id": "…", "name": "misaki_0.mp4"}], "diagnostics": []}`

**検証結果**: アクティブプロジェクトへ読み込み、アセット 3 → 4 件・新規 ID
返却を観測確認。diagnostics 0 件。

---

## premiere_move_clip（write）

アクティブシーケンス上の既存クリップを移動する（`sequence.moveClip`）。
対象はトラック種別・トラック番号・現在の開始秒（許容誤差つき）で特定。

- **時間移動（同一トラック）**: `trackItem.createMoveAction` — 実機で判明した
  とおり引数は**移動量（オフセット）**のため、ツール側は「絶対時刻指定 →
  内部でオフセット換算」する
- **垂直移動（トラック間、`new_track_index` 指定時）**: 直接 API が存在しない
  ため、`createCloneTrackItemAction`（垂直オフセット付き複製）＋
  `createRemoveItemsAction`（元削除）を**単一トランザクション**で実行
  （atomic・取り消し 1 回）。削除用の選択は `sequence.clearSelection()` →
  `getSelection()` → `selection.addItem(item)` で構築し、ユーザーの選択状態を
  巻き込まない

**引数**:

| 名前 | 型 | 既定値 | 説明 |
|---|---|---|---|
| `item_start_seconds` | float | 必須 | 対象クリップの現在の開始秒 |
| `new_start_seconds` | float | 必須 | 移動先の開始秒 |
| `track_type` | str | `video` | `video` / `audio` |
| `track_index` | int | `0` | 元トラック（0 始まり） |
| `new_track_index` | int | なし | 指定時はトラック間の垂直移動 |
| `tolerance_seconds` | float | `0.05` | 開始秒の一致許容誤差 |
| `timeout_seconds` | float | `30.0` | タイムアウト（1〜60 秒） |

**戻り値**（実測）: `{"ok": true, "moved": true, "name": "misaki_0.mp4", "fromSeconds": 0, "toSeconds": 0, "offsetSeconds": 0, "trackType": "video", "trackIndex": 1, "newTrackIndex": 2, "trackDelta": 1, "diagnostics": []}`

**検証結果**: 時間移動（V2 の 10s → 0s、オフセット -10 で正確に移動）と
垂直移動（V2 → V3、A2 → A3 とも成功。移動先にクリップ・元トラックは空・
他トラック無傷）を観測確認。diagnostics 0 件。

**実証済みの注意点**:

- **リンクされた A/V ペアは追従しない** — 片側だけ動かすと音ズレになるため、
  映像と音声を**それぞれ**移動すること
- 見つからない場合のエラーには、そのトラック上の全クリップの開始秒一覧が
  含まれる（再試行の手がかり）

---

## premiere_import_captions（write）

SRT をプロジェクトへ読み込む（`sequence.importCaptions`）。タイムライン配置は
Premiere の現行 UXP API がキャプションアイテムに対してサイレント no-op のため、
`placed` は**キャプショントラック数の実測差分**で正直に判定される（false が
期待値）。残る手動操作は「ビンからシーケンスへ 1 回ドラッグ」のみで、
応答の `note` にも同じ案内が入る。ドラッグすると Premiere がキャプション
トラックを生成し全キューを配置する（実機確認済み）。

**検証結果**: `imported: true` / `placed: false` / note 付与。手動ドラッグ後、
キャプショントラック C1 にキュー（0〜5.28s）が生成・表示された。

---

## premiere_add_telops（write・完全自動テロップ）

SRT の**全キューを編集可能なテキストテロップとして自動配置**する
オーケストレーション。キューごとに: ① 同梱 Motion Graphics テンプレートの
テキストを差し替えた .mogrt を生成（`gospelo_mediakit/premiere/mogrt.py`、
capsuleID を毎回新規化）→ ② `sequence.insertMogrt` でキュー開始時刻に挿入 →
③ `createSetEndAction` でキューの長さにトリム。配置後も Essential Graphics で
テキスト・スタイルとも編集可能（ffmpeg 焼き込みとの違い）。

**引数**:

| 名前 | 型 | 既定値 | 説明 |
|---|---|---|---|
| `srt_path` | str | 必須 | 字幕ファイル（mlx-whisper 等の出力） |
| `template_path` | str | 同梱 Simple Broadcast Caption | 差し替え元の .mogrt |
| `video_track_index` | int | `2` | 配置先ビデオトラック（0 始まり） |
| `time_offset_seconds` | float | `0.0` | 全キューへ加算する時刻オフセット |
| `max_cues` | int | なし | 配置キュー数の上限 |
| `timeout_seconds` | float | `60.0` | リクエスト単位のタイムアウト |

**戻り値**（実測）: `{"ok": true, "placedCues": 1, "totalCues": 1, "template": "…", "results": [{"cue": 1, "text": "…", "timeSeconds": 30.0, "durationSeconds": 5.28, "inserted": true, "durationSet": true, "diagnostics": []}]}`

**検証結果**: mlx-whisper の実転写テキスト「こちらは（製品名）で最初に表示
されるスケジュール画面になります」がテンプレートスタイル付きで指定時刻に描画
されることをフレーム書き出しで確認。UXP 呼び出し失敗 0 件。

**mogrt パッチ技法（`make_telop_mogrt`）で対処済みの罠**:

1. Premiere は capsuleID で mogrt をキャッシュ（同一 ID の改変版はキャッシュ元が
   描画される）→ 出力ごとに UUID 再生成
2. prgraphic はロケール別・パラメータ名も翻訳済み → 名前でなく**構造**
   （base64→UTF-16LE JSON に `mTextParam` を含むか）で全バリアントをパッチ
3. ppro 製テンプレートの definition.json は `capsuleparams` でなく
   `clientControls` → 両対応

**既知の制限**: 長文はテンプレートのフォントサイズのままはみ出し得る
（`mStyleSheet.mFontSize` も同じ構造にあるため、サイズ指定オプションで拡張可能）。

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
| `premiere_create_project` | `project.create` | write（新規プロジェクト作成のみ） |
| `premiere_insert_clip` | `sequence.insertClip` | write（取り消し可能） |
| `premiere_add_marker` | `sequence.addMarker` | write（取り消し可能） |
| `premiere_import_media` | `project.importMedia` | write（ビンへの追加のみ） |
| `premiere_move_clip` | `sequence.moveClip` | write（取り消し可能・垂直移動は clone+remove 合成） |
| `premiere_import_captions` | `sequence.importCaptions` | write（読み込みのみ・配置は手動1ドラッグ） |
| `premiere_add_telops` | `sequence.insertMogrt`（キューごと） | write（取り消し可能・完全自動） |

新しい操作は、UXP ハンドラと Python allowlist の**両方**に明示的に追加した
もののみ有効になる（任意コード実行は非対応・非方針）。
