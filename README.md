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
supabase/      データベースの設計（schema.sql）。Supabase の SQL Editor で実行する
vendor/        Supabase のライブラリ（npm run vendor で更新）。サーバー設定があるときだけ読み込む
ios/           iPhoneアプリ（Capacitor）のXcodeプロジェクト
scripts/       www/ へのコピー、iPhoneアプリのアイコン・起動画面の作成
```

- 動画データは `index.html` 内の `VIDEOS` 配列にハードコードされたデモ用サンプル動画。
- サーバー・API・データベース・認証は未実装。すべてクライアント側のみで完結する状態。

## テスト

```
npm install
(cd server && npm install)
npm test                 # アプリ全体（AIサーバー・データベースとのやりとりも含む）
npm run test:db          # データベース設計（PostgreSQLが必要。他人のデータを読めない・書けないかを確認）
npm run check:live       # 本物のSupabaseで確認（確認用アカウントを作って最後に消す。npm test には含めない）
(cd server && npm test)  # AIサーバー単体
```

- `tests/full.test.js`：全画面・全機能のチェック。`tests/ai.test.js`：AIコーチ（AIなし／模擬AIあり／AIサーバー）。
- `tests/features.test.js`：キーワード検索・連続記録・興味なし・通知・設定（バックアップ／全削除／ご意見）・読み込み中とオフラインの表示・iPhoneの案内。
- `tests/layout.test.js`：スマホ（幅320〜430px）とパソコンで、はみ出し・入力欄の文字サイズ・ボタンの押しやすさを確認。
- テスト用のサーバー（ポート8139、`PORT` で変更可）はテストが自分で起動します。
- AIはにせもの（決まった文を返す）に置き換えて動かすので、APIの料金はかかりません。
- Playwright付属のブラウザが無い環境では、`CHROMIUM_PATH` にChromiumの場所を指定してください。
- スクリーンショットは `tests/output/` に出ます（git管理外）。

## iPhoneアプリ（Capacitor・TestFlight向け）

同じ index.html を、Capacitor でiPhoneアプリに包む（作り直しはしない）。

```
npm run ios:sync     # index.html などを www/ にまとめて、iOSプロジェクトに入れる
npm run ios:assets   # アイコン（1024px・透明なし）と起動画面を作り直す
```

- アプリID（Bundle ID）は `jp.zonenow.app`、名前は「ゾーンNOW」、iPhone専用・縦向きのみ
- 写真・カメラ・マイクを使う理由の文（Info.plist）を入れてある（審査で必要）
- アプリの中では、Service Worker・「ホーム画面に追加」の案内を使わない。共有リンクは `index.html` の `APP_WEB_URL`（公開ページ https://ryugo201001037-wq.github.io/zo-ne-NOW/app/ ）で作る
- AIサーバーは `capacitor://localhost` からの呼び出しを許可する（`server/wrangler.toml` の `ALLOWED_ORIGINS`）
- Macがなくても、GitHub Actions のMacでビルドを確かめている（`.github/workflows/ios-build.yml`。署名なし・シミュレーター向け）

### ウェブ版の公開（GitHub Pages）

同じサイトに2つの版を並べて公開している（`.github/workflows/pages.yml`。Settings → Pages の Source は「GitHub Actions」）。
- https://ryugo201001037-wq.github.io/zo-ne-NOW/ … 前のプロトタイプ（`claude/zonenow-mvp-short-video-gcjp2s` の `docs/` をそのまま。このワークフローは読むだけ）
- https://ryugo201001037-wq.github.io/zo-ne-NOW/app/ … この版（main）。URLを知っている人だけが開く
- 更新：main が変わったとき／1時間ごと（前のプロトタイプの変更を拾う）／Actions の「Run workflow」
- 2つの版はブラウザの保存場所を共有するので、この版は前のプロトタイプのデータ（`zonenow_mvp_…`）やキャッシュを消さないようにしている
- 注意：`claude/change-possibility-ms2mm1` ブランチの `deploy-pages.yml` は、そのブランチに変更を送るとサイト全体を上書きする

TestFlightに出す手順は [docs/TESTFLIGHT.md](docs/TESTFLIGHT.md)。
プライバシーポリシーは `privacy.html`（公開ページ https://ryugo201001037-wq.github.io/zo-ne-NOW/app/privacy.html ）。登録画面と設定画面からリンクしている。【要記入】の2か所（運営者・連絡先）を埋めてから外部テストに使う。
- `.github/workflows/testflight.yml`：GitHub の Actions から手で実行すると、App Store Connect の APIキーで自動署名して TestFlight にアップロードする（Secrets が4つ必要）
- App Store Connect は Xcode 26 以上で作ったアプリしか受け付けない（2026年4月28日から）ので、iOS のワークフローは macOS 26 で動かす

## ログインとデータベース（Supabase）

テスト期間は**名前だけで登録**（Supabaseの匿名ログイン）。初回設定で名前と学年を入れるとアカウントができ、
ログイン状態は端末に保存されるので、次からは開くだけで自動でログインしている。

- 画面は今まで通り端末の記録で表示し、変更をサーバーへ送る。電波がないときは端末に残し、つながったら自動で送る
- データは「行ごとの権限」で守る：自分のプロフィールと記録だけ読み書きできる。投稿だけはログインしている全員が読める（`supabase/schema.sql`、`npm run test:db` で確認）
- ユーザー検索：検索画面でキーワードを入れると、登録した全員を名前で探せる（関数 `search_users`。返すのはアカウントIDと名前だけ）。押すとその人の投稿一覧、フォローもできる
- フォローは端末の中だけ（本物の利用者はアカウントID、見本のクリエイターは名前で覚える）。フォローされた人には伝わらない
- いいね・保存・コメント：みんなの投稿はサーバーに保存（`likes` / `saves` / `comments`）。数は関数 `post_stats` で全員分が見え、だれが押したかは本人だけ。コメントは全員が読め、書いた人と投稿した人が消せる。見本の動画は今まで通り端末の中だけ
- 設定の「すべてのデータを削除」で、サーバーのアカウントとデータ（投稿とそのファイルも）も消える

### 投稿（みんなのフィードに流れる）

- ファイルは Storage の `posts` バケット（`<user_id>/<投稿id>/<番号>.<拡張子>`）、内容は `posts` テーブル。置ける・消せるのは自分のフォルダだけ
- ログインしている人は全員の投稿を読める（新しい順に100件まで読み込み、見本の動画の4倍出やすい）
- 見本の動画（`index.html` の `VIDEOS`）は、みんなの投稿が20本を超えたらフィードと検索に出さない（`SAMPLE_RETIRE_AFTER`。投稿が減ればまた出る）
- **1ファイル50MBまで**（Supabase 無料プランの上限）。大きい動画（約2Mbpsより重いもの）は、送る前に端末の中で720p・約1.6Mbpsに軽くする（3分で約37MB）。軽くするには動画の長さと同じだけ時間がかかり、その間はアプリを開いたままにする
- 写真は長い辺1440pxのJPEGに縮小して送る
- 通報：シェアの「通報する」から理由を選ぶと `reports` テーブルに届く（アプリからは読めない）。運営は Table Editor で確認し、問題のある投稿は `posts` の行と Storage のファイルを消す
- 容量の目安（無料プラン）：保存1GB（3分の動画で約25本、1分なら約80本）、配信は月5GB程度。足りなくなったら Pro プランか、Cloudflare R2 などへの移行を考える
- バケットは公開（URLを知っていれば見られる）。ファイル名はランダムなIDなので推測はできない
- 配信の一時保存（CDN）は1時間（`Cache-Control: max-age=3600`）。消したファイルも、URLを知っている人には最大1時間見えることがある
- 注意：名前だけの登録なので、**ブラウザのデータを消したり機種変更したりすると、同じアカウントには戻れない**。本番ではメール登録などを足して引き継げるようにする
- `index.html` の `SUPABASE_URL_DEFAULT` が空のときは、今まで通り端末の中だけで動く

### つなぐ手順

1. [Supabase](https://supabase.com/) でプロジェクトを作る（無料プランで可。リージョンは Tokyo がおすすめ）
2. 「SQL Editor」で `supabase/schema.sql` の中身を貼り付けて「Run」
3. 「Authentication」→「Sign In / Providers」で **Allow anonymous sign-ins** をオンにする
4. 「Project Settings」→「API」の **Project URL** と **anon public** キーを、`index.html` の `SUPABASE_URL_DEFAULT` と `SUPABASE_ANON_KEY_DEFAULT` に書く
   - anon キーはアプリに入れてよい公開用のキー。**service_role キーは絶対にアプリやチャットに貼らない**
5. 1つの学校（同じWi-Fi）から一度にたくさん登録する場合は、「Authentication」→「Rate Limits」の匿名ログインの回数上限を上げておく

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
