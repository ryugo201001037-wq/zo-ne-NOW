// sw.js
// ------------------------------------------------------
// これは「Service Worker」というファイルです。
// ブラウザとは別のところで裏方として動く小さなプログラムで、
// このファイルがあることでスマホの「ホーム画面に追加」ボタンが
// 使えるようになり、アプリのように起動できるようになります。
// 今回のプロトタイプでは「起動できること」を優先し、
// 複雑なオフラインキャッシュ処理はまだ入れていません。
// ------------------------------------------------------

const CACHE_NAME = "zonenow-cache-v1";
const CORE_FILES = [
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// インストール時：アプリの土台となるファイルを保存しておく
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES))
  );
  self.skipWaiting();
});

// 古いキャッシュの掃除
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

// リクエストが来たとき：保存済みファイルなら即返す、なければネットへ
self.addEventListener("fetch", (event) => {
  // 動画ファイルは容量が大きいのでキャッシュせず、常にネットから取得する
  if (event.request.destination === "video") return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
