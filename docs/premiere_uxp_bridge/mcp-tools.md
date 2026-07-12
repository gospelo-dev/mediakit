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
| `solo_video_track` | int | なし | 指定ビデオトラック**単体**の画を書き出す。他のビデオトラックを一時的に非表示（トラック出力ミュート）にして書き出し、**同一コール内で必ず元の状態へ復元**（応答の `soloToggled` / `soloRestored` で確認可能） |
| `include_reflection` | bool | `false` | `_reflect`（Exporter / TickTime の利用可能メソッド一覧）を付加 |
| `wait_seconds` | float | `10.0` | Premiere の画像書き込みは**ブリッジ応答後に非同期で行われる**ため、新しいファイルがサイズ安定で現れるまでポーリングして待つ（応答の `fileReady: true` で読み取り可能を保証）。`0` で待機なし |
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

## premiere_trim_clip / premiere_ripple_delete_head（write）

クリップのトリムと、その応用のリップル削除（`sequence.trimClip`）。
Premiere の API に**レザー（カット）は存在しない**が、「T でカットして前半/後半を
削除」はエッジトリムと等価であることを利用する。

- `premiere_trim_clip(item_start_seconds, in_seconds?, out_seconds?, close_gap?)`:
  汎用トリム。実機で確定したセマンティクス: `createSetInPointAction` は
  **UI の左端トリムと同じ**（start がイン点と一緒に右へ動き end 固定 →
  手前にギャップが残る）
- `premiere_ripple_delete_head(cut_sequence_seconds, item_start_seconds, ...)`:
  **タイムライン時刻**でカット位置を指定（ソースのイン点への換算は UXP 側で
  実施）し、トリム後に元の開始位置へ詰めるまでを 1 コールで実行。
  レザー＋前半削除＋ギャップクローズ相当

**実装上の重要点（実機で確定）**:

- トリムと詰め移動を**1 トランザクションに合成すると `Invalid parameter` で拒否**
  される（アクション生成時の検証がトランザクション適用前の状態に対して走り、
  詰め移動が「負の位置」と判定されるため）。そのため同一コール内の
  **2 トランザクション**で実行 — 完全に取り消すには Undo 2 回
- リンクされた A/V ペアは追従しないため、同期維持には映像・音声それぞれに
  同じ呼び出しを行う

**検証結果**: V1/A1 とも `cut=3.1875s`（00:00:03:03 @16fps）で実行し、
両者が `start=0 / in=3.1875 / end=1645.875` に完全一致（A/V 同期維持）。
diagnostics 0 件。失敗時の安全性も確認済み（合成トランザクション拒否時は
全ロールバックされ before == after）。

---

## premiere_razor_clip（write・レザーカット）

**1 クリップをタイムライン位置で 2 クリップに分割**する（`sequence.razorClip`）。
Premiere の API にレザーは存在しないため、検証済みプリミティブの合成で実現:

```
① 同トラックへ時間オフセット付きクローン（overwrite）
     → 上書きされた側の元クリップ半分が自動で切り詰められる（実機確定）
② クローンをエッジトリム（左端 or 右端）
③ クローンを相対移動で最終位置へ
```

クローンは「作られる側のピースの長さ」ぶん元クリップからはみ出すため、
**実行可能な戦略のうち、はみ出しが短い方を自動選択**する:

| 戦略 | クローンが成る側 | はみ出し区間（要空き） |
|---|---|---|
| `clone-tail` | 後半ピース | クリップ後方に前半の長さぶん |
| `clone-head` | 前半ピース | クリップ前方に後半の長さぶん（タイムライン負値は不可） |

どちらも実行不可なら、周辺クリップの一覧つきで拒否する。各ステップ後に観測し、
想定外の中間状態では**即停止**（Undo 1 回で戻れる地点）。完全な取り消しは
最大 Undo 3 回。リンク A/V は追従しないため映像・音声を個別に分割する。

**引数**: `cut_sequence_seconds`（タイムライン時刻・クリップ内側必須）,
`item_start_seconds`, `track_type`, `track_index`, `tolerance_seconds`,
`timeout_seconds`

**戻り値**（実測）: `{"ok": true, "split": true, "strategy": "clone-tail", "before": {...}, "original": {start: 0, end: 3.1875, in: 0, out: 3.1875}, "clone": {start: 3.1875, end: 1649.0625, in: 3.1875, out: 1649.0625}, "diagnostics": []}`

**検証結果**: 27.5 分のクリップを 00:00:03:03（3.1875s @16fps）で分割。
2 ピースが隙間なく密着し、各ピースの `in` がタイムライン位置と一致
（= カット点で内容が継ぎ目なく連続）。全体スパンは分割前と完全一致。
再実行でも同一結果（再現性確認済み）。diagnostics 0 件。

---

## PIP キット: create_subsequence / remove_clip / set_clip_transform / set_active_sequence（write）

ネスト（子シーケンス化）とピクチャー・イン・ピクチャーを構成する 4 ツール。
典型フロー（実機検証済み）:

```
① premiere_create_subsequence   対象クリップ群 → 子シーケンス（ビンに追加）
② premiere_remove_clip × N      元クリップをタイムラインから除去（ripple 対応）
③ premiere_insert_clip          子シーケンスの新 ID をネストクリップとして挿入
④ premiere_set_clip_transform   スケール%・位置で PIP 化
⑤ premiere_set_active_sequence  ネスト内部の修正が必要なら切り替えて操作 → 親へ復帰
```

- `premiere_create_subsequence(items=[{track_type, track_index, item_start_seconds}, …])`:
  選択 → `createSubsequence`。**タイムラインは不変**（ビンに新シーケンス）。
  戻り値の `newItemIds` を ③ にそのまま渡せる
- `premiere_remove_clip(item_start_seconds, …, ripple?)`: トラックアイテムの除去
  （ビンのアイテムは不変）
- `premiere_set_clip_transform(item_start_seconds, …, scale?, position_x?, position_y?)`:
  Motion 固定エフェクト（matchName `AE.ADBE Motion`、ロケール非依存）の
  スケール/位置を書き換え。**引数なしで現在値の読み取りのみ**も可能で、
  応答に before/after を含む。**Position は正規化座標**（0〜1、中央 = [0.5, 0.5]）
  — ピクセルではない（実機で較正済み）。スケールは %（100 = 原寸）
- `premiere_set_active_sequence(name)`: アクティブシーケンスの切り替え。
  全ツールはアクティブシーケンスに作用するため、ネスト内部の操作に必須。
  名前不一致時は存在するシーケンス名一覧を返す

**実機で確定した注意点**:

- **ネストは作成時のトラック表示状態を引き継ぐ**（親で非表示のトラックは
  ネスト内でも非表示 → ⑤ で切り替えて `set_video_track_output` で修復）
- Position にピクセル値を渡すと画面外へ飛ぶ（正規化座標であるため）。
  ツールは変更前の値を返すので、初回呼び出しが単位の較正を兼ねる

**検証結果**: bg.png（V2）+ misaki（V3）を子シーケンス化 → 元クリップ除去 →
ネスト挿入 → スケール 30%・位置 (0.82, 0.18) → フレーム書き出しで
「demo_base 全画面の右上に、bg の上に misaki が乗った PIP」を目視確認。
diagnostics 全ステップ 0 件。

---

## premiere_set_video_track_output / premiere_set_audio_track_mute（write）

トラックの出力状態を切り替える 2 ツール。どちらも同じブリッジメソッド
`sequence.setTrackMute`（公式 API `track.setMute`）の薄いラッパーだが、
Premiere の UI の呼び名に合わせて分割している:

| ツール | 対応 UI | 引数 |
|---|---|---|
| `premiere_set_video_track_output` | 目アイコン（トラック出力） | `visible`（true で表示）, `track_index` |
| `premiere_set_audio_track_mute` | M ボタン（ミュート） | `mute`（true で消音）, `track_index` |

- 応答に before/after の実測値を含むため、1 往復で act → observe が完結
  （video 側は `visibleBefore/After`、audio 側は `mutedBefore/After`）
- **ロックではない**（トラックロックの操作 API は UXP に存在しない —
  `EVENT_TRACK_LOCK_CHANGED` イベントのみ）
- 単発の「1 トラックだけの画が欲しい」なら、自動復元つきの
  `premiere_export_frame(solo_video_track=…)` を推奨

**検証結果**: A1 のミュート（`mutedBefore: false → mutedAfter: true`）、
V3 の表示 OFF→ON（solo_video_track 実験内で before/after 確認）とも実測済み。
diagnostics 0 件。

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

## プロジェクト管理: list_sequences / create_sequence / save_project / rename_item

- `premiere_list_sequences(include_clip_transforms?)`（read）:
  **親・子（サブシーケンス）を問わず全シーケンス**の画角（`frameWidth`/`frameHeight`）・
  `fps`・トラック数を、**アクティブ切り替えなしで**一括取得。
  `include_clip_transforms=true` で各シーケンスのビデオクリップ一覧も付く:
  Motion トランスフォーム（`position` 正規化 0〜1 / `scale` / `scaleWidth` /
  `uniformScale`）＋**ソース画角**（実メディアは MCP 層の ffprobe ハイブリッドで
  `sourceWidth/Height/Fps`、ネストクリップは兄弟シーケンスの画角を名前照合で
  解決し `isNested: true`）。UXP API にはメディアのソース画角を返すメソッドが
  存在しない（stable/beta 型定義とも確認済み）ため、このハイブリッドが正解
- `premiere_create_sequence(name, item_ids)`（write）: **既存プロジェクト内**に
  シーケンスを新規作成（`createSequenceFromMedia`）。**先頭アイテムの画角・fps を
  自動採用**し、アイテムをタイムラインに配置（実測: misaki_0 から 1104×816、
  demo_base から 1920×1080）
- `premiere_save_project()`（write）: アクティブプロジェクトを保存。
  **ブリッジの編集は保存するまでディスクに残らない**（未保存で閉じると全て消える
  — 実機で経験済みの教訓）。編集バッチの最後に呼ぶこと
- `premiere_rename_item(item_id, new_name)`（write）: ビンアイテムのリネーム。
  シーケンスはビンアイテムと名前を共有するため、シーケンス名の変更もこれで行う
  （実測: main-edit → pip）

また `premiere_get_sequence_state` の `sequence` ブロックに
`frameWidth` / `frameHeight` / `fps` が追加され、毎回の L1 観測に画角が付属する。

---

## premiere_add_effect（write・エフェクト適用 = ロードマップ段階 4）

クリップにビデオエフェクトを追加し、任意でカラーパラメータを設定する
（`sequence.addEffect`）。**公式 API の `VideoFilterFactory` を使用** —
ロードマップでは非公式 QE DOM を想定していたが、公式ルートで達成したため
バージョン耐性の懸念なし。

- **エフェクト解決**: `getDisplayNames()` / `getMatchNames()` の実行時列挙から
  表示名の部分一致（`effect_query="Ultra"` → `AE.ADBE Ultra Key`）。
  ロケール非依存で matchName の推測が不要
- **適用**: `createAppendComponentAction` の単一トランザクション。適用後に
  全パラメータ（index / displayName / 現在値）を読み返して返却
- **カラー設定**（`color_hex`）: カラー型パラメータを構造判定で自動検出し、
  **値域自動較正**（0-255 → 読み返し不一致 → 0-1 で再試行）でセット。
  実機で確定: **`ppro.Color` は 0〜1 の浮動小数**（0-255 を渡すとクランプされ
  意図しない色になる — 初回実装の失敗から較正機構で回復）
- **`existing=true`**: 適用済みエフェクトをクリップ上で検索して検査・再設定
  （二重適用なし）。Motion / Opacity などの**固有コンポーネント**も
  `match_name` で対象にできる
- **`set_params`**: 数値/ブールパラメータを index 指定で一括設定
  （`[{"index": 12, "value": 30}]`）。1 トランザクション・読み返し付き。
  `keyframes` 形式（`[{"index": 0, "keyframes": [{"timeSeconds": 7.7,
  "value": 100}, ...]}]`）で **`createSetTimeVaryingAction` +
  `createAddKeyframeAction` によるキーフレームアニメーション**も可能
  （時刻はクリップ時間）

**引数**: `item_start_seconds`, `effect_query` または `match_name`,
`color_hex?`, `set_params?`, `existing?`, `track_type`, `track_index`

**検証結果**: misaki（ブルーバック `#002FFA`）に Ultra キーを適用し、
キーカラーを較正セット（読み返し (0, 0.184, 0.9725) ≈ #002FFA）。フレーム
書き出しで**ブルーが完全に抜け、下のオフィス背景に合成**されることを目視確認。
Ultra キーの全 26 パラメータ（キーカラー=index 2、透明度・許容量・スピル等）の
地図も取得済み。

**確定済みパラメータ地図**（実機で読み取り・設定検証済み）:

- **Ultra キー** (`AE.ADBE Ultra Key`): 2=キーカラー、11=チョーク、12=柔らかく
- **Motion** (`AE.ADBE Motion`): 0=位置（正規化 0..1）、1=スケール（非均等時は縦）、
  2=スケール(幅)、3=縦横比固定、7〜10=切り抜き 左/上/右/下
- **Opacity** (`AE.ADBE Opacity`): 0=不透明度、1・2=描画モード
- **Lumetri カラー** (`AE.ADBE Lumetri`): 14=色温度、16=彩度、19=露光量、
  20=コントラスト、21=ハイライト、22=シャドウ、23=白レベル、24=黒レベル、
  41=シャープ、42=自然な彩度、110=ビネット適用量（全 130 個）

---

## premiere_get_effect_params（read）

適用済みエフェクト/固有コンポーネントのパラメータ一覧（index / displayName /
現在値）を**変更なしで**取得する。実体は `sequence.addEffect` の
`existing=true` だが、読み取り専用ツールとして分離することで、照会目的の
呼び出しが誤ってエフェクトを新規適用する事故を防ぐ。`set_params` で index を
指定する前の地図取りに使う。

**引数**: `item_start_seconds`, `effect_query` または `match_name`,
`track_type`, `track_index`

---

## premiere_fade_clip（write・不透明度フェード）

クリップの Opacity（`AE.ADBE Opacity`）にキーフレームを 2 つ打ち、
フェードアウト（既定 100→0）/フェードイン（`opacity_from=0, opacity_to=100`）を
1 コールで設定する糖衣ツール。時刻は**クリップ時間**（start=0・in=0 の
クリップならシーケンス時間と一致）。

**引数**: `item_start_seconds`, `fade_start_seconds`, `fade_end_seconds`,
`opacity_from?`, `opacity_to?`, `track_index`

**検証結果**: man_walk クリップに 7.7s→8.375s のフェードアウトを設定。
`timeVarying: true` 読み返し確認、中間フレーム（8.05s）で約 50% ブレンドを
目視確認。

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
| `premiere_trim_clip` | `sequence.trimClip` | write（エッジトリム・応答に before/after） |
| `premiere_ripple_delete_head` | `sequence.trimClip`（closeGap） | write（カット＋前半削除＋詰めを1コール） |
| `premiere_razor_clip` | `sequence.razorClip` | write（1→2クリップ分割・戦略自動選択） |
| `premiere_create_subsequence` | `sequence.createSubsequence` | write（子シーケンス作成・タイムライン不変） |
| `premiere_remove_clip` | `sequence.removeClip` | write（取り消し可能・ripple 対応） |
| `premiere_set_clip_transform` | `sequence.setClipTransform` | write（Motion スケール/位置/切り抜き・非均等スケール対応・読み取り較正つき） |
| `premiere_get_effect_params` | `sequence.addEffect`（existing・読み取りのみ） | read（パラメータ地図の照会） |
| `premiere_fade_clip` | `sequence.addEffect`（Opacity キーフレーム） | write（フェードイン/アウト糖衣） |
| `premiere_set_active_sequence` | `project.setActiveSequence` | write（UI 状態のみ・ネスト操作の鍵） |
| `premiere_list_sequences` | `project.listSequences` | read（全シーケンスの画角/fps/トランスフォーム） |
| `premiere_create_sequence` | `project.createSequence` | write（既存プロジェクト内・先頭素材の画角採用） |
| `premiere_save_project` | `project.save` | write（保存。編集バッチの最後に必須） |
| `premiere_rename_item` | `project.renameItem` | write（取り消し可能・シーケンス名共用） |
| `premiere_add_effect` | `sequence.addEffect` | write（公式 VideoFilterFactory・カラー自動較正） |
| `premiere_set_video_track_output` | `sequence.setTrackMute`（video） | write（目アイコン相当・応答に before/after） |
| `premiere_set_audio_track_mute` | `sequence.setTrackMute`（audio） | write（M ボタン相当・応答に before/after） |
| `premiere_import_captions` | `sequence.importCaptions` | write（読み込みのみ・配置は手動1ドラッグ） |
| `premiere_add_telops` | `sequence.insertMogrt`（キューごと） | write（取り消し可能・完全自動） |

新しい操作は、UXP ハンドラと Python allowlist の**両方**に明示的に追加した
もののみ有効になる（任意コード実行は非対応・非方針）。
