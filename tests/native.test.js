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
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { Haptics: { impact: async o => { window.__haptics.push(o.style); } } } };
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
  check('iPhoneのSafariでは「ホーム画面に追加」を案内する', await web.page.$eval('#install-banner', el => el.classList.contains('show')));
  check('共有リンクは今のページのURL', await web.page.evaluate(() => shareUrlOf(VIDEOS[0]).startsWith(location.origin) && shareUrlOf(VIDEOS[0]).includes('?v=')));
  check('エラーなし', !web.errors.length, web.errors.join(' / '));
  await web.context.close();

  report();
  await browser.close();
  server.close();
})();
