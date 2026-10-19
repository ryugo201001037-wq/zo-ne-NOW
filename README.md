# ゾーンNOW

ショート動画で勉強へのやる気に火をつける学習プラットフォーム（PWAプロトタイプ）。

## 現状の構成

ビルド不要の静的サイト（バニラHTML/CSS/JS 1ファイル構成）です。

```
index.html     ホーム(ショート動画フィード)・検索・本編プレイヤーの3画面をまとめたSPA
manifest.json  PWA用マニフェスト（ホーム画面追加対応）
sw.js          Service Worker（コアファイルのみキャッシュ、動画はキャッシュ対象外）
icons/         ホーム画面アイコン
tests/         ブラウザで全機能を動かして確かめる自動テスト（Playwright）
server/        AIサーバー（Cloudflare Workers）。APIキーを預かり、AIコーチの質問をClaudeに中継する
```

- 動画データは `index.html` 内の `VIDEOS` 配列にハードコードされたデモ用サンプル動画。
- サーバー・API・データベース・認証は未実装。すべてクライアント側のみで完結する状態。

## テスト

```
npm install
(cd server && npm install)
npm test                 # アプリ全体（AIサーバーとのやりとりも含む）
(cd server && npm test)  # AIサーバー単体
```

- `tests/full.test.js`：全画面・全機能のチェック。`tests/ai.test.js`：AIコーチ（AIなし／模擬AIあり／AIサーバー）。
- `tests/features.test.js`：友達（記録の交換）・キーワード検索・目標と連続記録・興味なし・通知・設定（バックアップ／全削除）・iPhoneの案内。
- `tests/layout.test.js`：スマホ（幅320〜430px）とパソコンで、はみ出し・入力欄の文字サイズ・ボタンの押しやすさを確認。
- テスト用のサーバー（ポート8139、`PORT` で変更可）はテストが自分で起動します。
- AIはにせもの（決まった文を返す）に置き換えて動かすので、APIの料金はかかりません。
- Playwright付属のブラウザが無い環境では、`CHROMIUM_PATH` にChromiumの場所を指定してください。
- スクリーンショットは `tests/output/` に出ます（git管理外）。

## AIサーバー（server/）

AIコーチの「問題の解説」は、本番ではこのサーバー経由でClaude（Haiku）に聞きます。
claude.aiのプレビューで開いたときは、見ている人のClaudeの利用枠を使うので、サーバーは使いません。

- APIキーはサーバーの秘密の設定にだけ置き、アプリには入れない
- 1端末あたり1日20回まで（`wrangler.toml` の `DAILY_LIMIT`）。日本時間0時にリセット
- 回答は少しずつ返す（アプリの「停止」でAIへの問い合わせも止まる）
- 注意：端末IDはブラウザのデータを消すとリセットできる。ログイン機能ができたらアカウント単位に変える。最終的な歯止めとして、Anthropic Consoleで月の利用額の上限を必ず設定する

### 公開する手順

1. [Cloudflare](https://dash.cloudflare.com/sign-up) のアカウントを作る（無料プランで可）
2. `cd server && npm install`
3. `npx wrangler login`（ブラウザでCloudflareにログイン）
4. `npx wrangler kv namespace create USAGE` → 表示された `id` を `wrangler.toml` の `REPLACE_WITH_KV_NAMESPACE_ID` に書く
5. [Anthropic Console](https://console.anthropic.com/) でAPIキーを作り、**月の利用額の上限を設定**する
6. `npx wrangler secret put ANTHROPIC_API_KEY` → キーを貼り付ける（キーはファイルやチャットに書かない）
7. `wrangler.toml` の `ALLOWED_ORIGINS` を、アプリを公開するURL（例：`https://zonenow.example.com`）にする
8. `npx wrangler deploy` → 表示されたURL（`https://zonenow-ai.xxxx.workers.dev`）を、`index.html` の `AI_SERVER_URL_DEFAULT` に書く

無料プランの回数を数える保存場所（KV）は、書き込みが1日1,000回までです（全員の質問の合計が1日約1,000問まで）。超えそうなら有料プラン（月5ドル）にします。

## 本格リリースに向けた骨組み（検討中のロードマップ）

まだ着手していません。優先度が高い順の叩き台です。

1. **動画データの外部化** — `VIDEOS`配列をJSONやAPIから取得する形に分離し、コード変更なしで動画を追加できるようにする
2. **本番動画の配信基盤** — 現在はGoogleのサンプル動画URL。実際の動画アップロード・変換・配信（CDN）の仕組みが必要
3. **バックエンド/API** — 動画メタデータの管理、視聴ログ、Zoneメーターの実績保存などにサーバーが必要になるか整理
4. **ユーザー認証・会員機能** — 学年・教科の好みを保存、視聴履歴、進捗管理をするなら必要
5. **コンテンツ管理** — 動画・教科・単元を増やしていく運用フロー（管理画面 or CMS）
6. **計測・分析** — Zoneメーター到達率など、やる気に火がつく効果を測る指標設計
7. **デプロイ・CI** — 静的ホスティング先の決定、ビルド/テストの自動化

それぞれ規模も技術選定の余地も大きいため、どこから着手するか・技術スタック（フレームワーク導入の要否、バックエンド言語、動画配信サービスなど）を決めてから進めます。
