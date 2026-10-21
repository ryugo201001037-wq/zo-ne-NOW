// sw.js
// ------------------------------------------------------
// これは「Service Worker」というファイルです。
// ブラウザとは別のところで裏方として動く小さなプログラムで、
// このファイルがあることでスマホの「ホーム画面に追加」ボタンが
// 使えるようになり、アプリのように起動できるようになります。
//
// 方針：ネット優先。オンラインのときは毎回最新のファイルを取りに行き、
// 取れたものを保存しておく。オフラインのときだけ保存済みのものを使う。
// （以前は「保存済み優先」だったため、ホーム画面に追加したアプリが
//   古い画面のまま更新されないことがあった）
// ------------------------------------------------------

// 保存の仕組みを変えたら番号を上げる（古い保存データは自動で削除される）
const CACHE_NAME = "zonenow-cache-v3";
const CORE_FILES = [
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// インストール時：オフラインでも起動できるよう、土台となるファイルを保存しておく
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES))
  );
  self.skipWaiting();
});

// 古いキャッシュの掃除（自分の古い版だけ。同じサイトの前のプロトタイプのキャッシュには触らない）
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key.startsWith("zonenow-cache-") && key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // 自分のサイトのファイル(GET)だけを扱う。動画・外部フォントなどはブラウザに任せる
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.destination === "video") return;

  // アプリ本体（index.html）は、ブラウザ自身の一時保存（GitHub Pages は10分使い回してよいと指示している）も通さず、
  // 毎回ネットから取り直す。これがないと、更新してから最大10分ほど古い版が出ることがあった
  const url = new URL(req.url);
  const isAppShell = req.mode === "navigate" || url.pathname.endsWith("/index.html");
  event.respondWith(
    (isAppShell ? fetch(url.href, { cache: "no-store", credentials: "same-origin" }) : fetch(req))
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) =>
          cached || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())
        )
      )
  );
});
