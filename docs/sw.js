// ============================================================
// sw.js（Service Worker：ブラウザの裏側で動く小さなプログラム）
// ------------------------------------------------------------
// この仕組みがあると、スマホの「ホーム画面に追加」機能が使えるようになり、
// アプリのように起動できます。
// 今回は「起動できること」を優先したシンプルな作りにしていて、
// 難しいオフライン再生などは行いません（YouTube動画はネットが必須のため）。
// ============================================================

const CACHE_NAME = "zonenow-mvp-cache-v1";

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
// 自分のサイト（同じオリジン）のファイルだけキャッシュを確認し、
// YouTube側の動画・APIリクエストなど外部通信には一切手を出さない。
// （下手にキャッシュすると動画が再生できなくなるため）
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (!isSameOrigin || event.request.method !== "GET") {
    return; // 何もしない＝ブラウザが普段通りネットに取りに行く
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
