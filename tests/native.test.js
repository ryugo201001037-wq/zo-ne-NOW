// iPhoneアプリ（Capacitor）の中で動いたときのテスト（実行：npm test）
// 本物のiPhoneアプリの代わりに、Capacitor があるふり（window.Capacitor）をして確かめる
const { APP_URL, startServer, launchBrowser, createChecker } = require('./helpers');
const { check, state, report } = createChecker();

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

async function open(browser, native) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(native => {
    window.confirm = () => false;
    if (native) {
      window.__haptics = [];
      // 端末の中の通知（勉強リマインド）：予約・取り消し・許可を記録する。__permission で許可するかを変えられる
      window.__ln = { scheduled: [], cancelled: 0, listeners: {}, permission: 'granted', asked: 0 };
      const LocalNotifications = {
        checkPermissions: async () => ({ display: window.__ln.asked ? window.__ln.permission : 'prompt' }),
        requestPermissions: async () => { window.__ln.asked++; return { display: window.__ln.permission }; },
        schedule: async o => { window.__ln.scheduled = o.notifications; },
        cancel: async () => { window.__ln.cancelled++; window.__ln.scheduled = []; },
        addListener: (name, fn) => { window.__ln.listeners[name] = fn; },
      };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { Haptics: { impact: async o => { window.__haptics.push(o.style); } }, LocalNotifications } };
    }
    localStorage.setItem('zonenow_profile', JSON.stringify({ name: 'テスト', grade: 'junior2', createdAt: 1 }));
  }, native);
  await page.goto(APP_URL);
  await page.waitForTimeout(700);
  return { context, page, errors };
}

(async () => {
  const server = await startServer();
  const browser = await launchBrowser();

  state.section = 'iPhoneアプリの中';
  const app = await open(browser, true);
  const p = app.page;
  check('アプリの中だと分かる', await p.evaluate(() => IS_NATIVE_APP === true));
  check('Service Workerは使わない', await p.evaluate(async () => !(await navigator.serviceWorker.getRegistration())));
  check('「ホーム画面に追加」の案内は出さない', !(await p.$eval('#install-banner', el => el.classList.contains('show'))));
  await p.click('.screen.active [data-nav="profile"]'); await p.click('#profile-gear'); await p.waitForTimeout(200);
  check('設定の「ホーム画面に追加する方法」も出さない', !(await p.isVisible('#settings-install-section')));
  check('バージョンに「iPhoneアプリ」', (await p.textContent('#settings-version')).includes('（iPhoneアプリ）'));

  state.section = '勉強リマインド';
  check('設定に勉強リマインド（最初はオフ・20:00）', await p.isVisible('#settings-reminder-section') && (await p.textContent('#reminder-toggle')) === 'オンにする' && (await p.inputValue('#reminder-time')) === '20:00');
  await p.fill('#reminder-time', '19:30');
  await p.click('#reminder-toggle'); await p.waitForTimeout(200);
  const scheduled = await p.evaluate(() => window.__ln.scheduled);
  check('オンにすると、通知を許可してもらってから毎日19:30に予約', scheduled.length === 1 && scheduled[0].schedule.on.hour === 19 && scheduled[0].schedule.on.minute === 30 && await p.evaluate(() => window.__ln.asked === 1), JSON.stringify(scheduled));
  check('ボタンは「オフにする」に変わる', (await p.textContent('#reminder-toggle')) === 'オフにする' && (await p.textContent('#reminder-status')).includes('毎日 19:30'));
  await p.fill('#reminder-time', '21:00'); await p.dispatchEvent('#reminder-time', 'change'); await p.waitForTimeout(200);
  check('時刻を変えると、予約も入れ直す', await p.evaluate(() => window.__ln.scheduled.length === 1 && window.__ln.scheduled[0].schedule.on.hour === 21));
  await p.click('#reminder-toggle'); await p.waitForTimeout(200);
  check('オフにすると予約を消す', await p.evaluate(() => window.__ln.scheduled.length === 0) && (await p.textContent('#reminder-toggle')) === 'オンにする');
  await p.evaluate(() => { window.__ln.permission = 'denied'; });
  await p.click('#reminder-toggle'); await p.waitForTimeout(200);
  check('通知を許可されなければ、オフのまま理由を伝える', (await p.textContent('#reminder-toggle')) === 'オンにする' && (await p.textContent('#toast')).includes('通知が許可されていません') && await p.evaluate(() => window.__ln.scheduled.length === 0));
  await p.click('#settings-back'); await p.waitForTimeout(150);
  await p.evaluate(() => window.__ln.listeners.localNotificationActionPerformed({}));
  await p.waitForTimeout(200);
  check('リマインドの通知を押して開くと、記録（タイマー）の画面', await p.$eval('.screen.active', el => el.id) === 'record-screen');
  await p.click('.screen.active [data-nav="profile"]'); await p.click('#profile-gear'); await p.waitForTimeout(200);
  await p.click('#settings-back'); await p.waitForTimeout(150);
  await p.click('.screen.active [data-nav="home"]'); await p.waitForTimeout(200);
  await p.click('#feed .short-slide:first-child [data-role="share"]');
  check('リンクを開くとその動画から再生されると伝える', (await p.textContent('#share-note')).includes('リンクを開くと'));
  check('共有のURLは capacitor:// ではなく公開ページ', await p.evaluate(() => shareUrlOf(VIDEOS[0]) === `https://ryugo201001037-wq.github.io/zo-ne-NOW/app/?v=${VIDEOS[0].id}`));
  await p.click('#share-sheet-close'); await p.waitForTimeout(150);
  await p.click('#feed .short-slide:first-child [data-role="like"]');
  check('いいねで軽く振動', await p.evaluate(() => window.__haptics.includes('LIGHT')));
  check('ボタンや文字は長押しで選択されない', await p.evaluate(() => getComputedStyle(document.body).webkitUserSelect === 'none' || getComputedStyle(document.body).userSelect === 'none'));
  check('AIの回答は選んでコピーできる', await p.evaluate(() => { const b = document.createElement('div'); b.className = 'ai-bubble'; document.body.appendChild(b); const v = getComputedStyle(b).userSelect || getComputedStyle(b).webkitUserSelect; b.remove(); return v === 'text'; }));
  check('エラーなし', !app.errors.length, app.errors.join(' / '));
  await app.context.close();

  state.section = 'ウェブ（今まで通り）';
  const web = await open(browser, false);
  check('ウェブではアプリの中ではない', await web.page.evaluate(() => IS_NATIVE_APP === false));
  check('ウェブでは勉強リマインドを出さない（端末の通知が使えない）', !(await web.page.isVisible('#settings-reminder-section')));
  check('iPhoneのSafariでは「ホーム画面に追加」を案内する', await web.page.$eval('#install-banner', el => el.classList.contains('show')));
  check('共有リンクは今のページのURL', await web.page.evaluate(() => shareUrlOf(VIDEOS[0]).startsWith(location.origin) && shareUrlOf(VIDEOS[0]).includes('?v=')));
  check('エラーなし', !web.errors.length, web.errors.join(' / '));
  await web.context.close();

  report();
  await browser.close();
  server.close();
})();
