// ============================================================
// sw.js（Service Worker：ブラウザの裏側で動く小さなプログラム）
// ------------------------------------------------------------
// この仕組みがあると、スマホの「ホーム画面に追加」機能が使えるようになり、
// アプリのように起動できます。
// 今回は「起動できること」を優先したシンプルな作りにしていて、
// 難しいオフライン再生などは行いません（YouTube動画はネットが必須のため）。
// ============================================================

// ⚠️ バージョン番号（v1, v2...）。ここを変えると、古いキャッシュを
//    全部捨てて作り直させることができる（今回、下のfetch処理を直したので
//    一度だけv2に上げて、古いキャッシュを掃除している）。
const CACHE_NAME = "zonenow-mvp-cache-v2";

// あらかじめ保存しておく「アプリの土台」となるファイル一覧
const CORE_FILES = [
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// インストール時：土台となるファイルをキャッシュ（保存）しておく
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES))
  );
  self.skipWaiting(); // 新しいService Workerをすぐに使えるようにする
});

// 有効化時：古いバージョンのキャッシュを掃除する
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// リクエストが発生したとき：
// 自分のサイト（同じオリジン）のファイルだけを見て、
// YouTube側の動画・APIリクエストなど外部通信には一切手を出さない。
// （下手にキャッシュすると動画が再生できなくなるため）
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (!isSameOrigin || event.request.method !== "GET") {
    return; // 何もしない＝ブラウザが普段通りネットに取りに行く
  }

  // index.html（アプリ本体）は「まずネットから最新版を取りに行き、
  // オフラインの時だけキャッシュを使う」方式にする。
  // これにより、コードを更新するたびにキャッシュのバージョン番号を
  // 手動で上げなくても、次にネットに繋がった状態で開けば自動的に
  // 最新の内容に更新されるようになる（＝古い見た目のまま固まらない）。
  const isAppShell = event.request.mode === "navigate" || url.pathname.endsWith("index.html");
  if (isAppShell){
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseCopy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseCopy));
          return response;
        })
        .catch(() => caches.match(event.request)) // オフラインの時だけ、保存しておいた版を使う
    );
    return;
  }

  // それ以外（manifest.jsonやアイコンなど、めったに変わらないファイル）は
  // 今まで通りキャッシュ優先で、素早く・オフラインでも表示できるようにする。
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
