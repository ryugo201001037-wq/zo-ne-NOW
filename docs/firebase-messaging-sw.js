// ============================================================
// firebase-messaging-sw.js
// ------------------------------------------------------------
// プッシュ通知を「アプリを閉じている間」に受け取って画面に表示するための、
// 通知専用のService Worker。アプリ本体のキャッシュを担当するsw.jsとは
// 別ファイルにしてある(Firebase Messagingの決まりで、このファイル名・
// この場所に置く必要がある)。
//
// ここにはFirebaseの「公開しても問題ない」設定値だけが入っている
// (index.htmlのCONFIG.FIREBASE_CONFIGと同じ値)。秘密鍵などは一切ない。
// ============================================================

importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBG6ESfeASNy00Lw0sHRsZkePP1U3krIV8",
  authDomain: "zonenow1-13eab.firebaseapp.com",
  projectId: "zonenow1-13eab",
  storageBucket: "zonenow1-13eab.firebasestorage.app",
  messagingSenderId: "133713143621",
  appId: "1:133713143621:web:41070d555bfa0b9f03002c",
  measurementId: "G-RVN3GQHRT1"
});

const messaging = firebase.messaging();

// アプリが裏/閉じている状態で通知を受け取ったときの表示内容
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "ZoneNOW";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, {
    body: body,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png"
  });
});

// 通知をタップしたら、ゾーンNOWを開く(すでに開いているタブがあればそちらに切り替える)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});
