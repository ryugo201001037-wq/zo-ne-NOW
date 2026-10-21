// 追加機能のテスト：キーワード検索・連続記録・興味なし・通知・設定・iPhoneの案内（実行：npm test）
const fs = require('fs');
const { ASSETS, OUT, APP_URL, startServer, launchBrowser, createChecker } = require('./helpers');
const { check, state, report } = createChecker();

const dayKey = n => { const d = new Date(); const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

// プロフィールと勉強記録を入れた状態で開く
async function openApp(browser, { name, grade = 'junior2', log = [], ua } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, ...(ua ? { userAgent: ua } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(([name, grade, log]) => {
    window.confirm = () => false;
    if (name && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('zonenow_profile', JSON.stringify({ name, grade, createdAt: 1 }));
      localStorage.setItem('zonenow_study_log', JSON.stringify(log));
    }
  }, [name, grade, log]);
  await page.goto(APP_URL);
  await page.waitForTimeout(400);
  return { context, page, errors };
}
const entry = (id, subject, minutes, daysAgo) => ({ id, subject, subjectOther: '', seconds: minutes * 60, date: dayKey(daysAgo), source: 'manual', createdAt: Date.now() - daysAgo * 1000 });

(async () => {
  const server = await startServer();
  const browser = await launchBrowser();
  const toast = page => page.textContent('#toast').catch(() => '');
  const active = page => page.$eval('.screen.active', el => el.id);
  const nav = async (page, n) => { await page.click(`.screen.active [data-nav="${n}"]`); await page.waitForTimeout(150); };

  // ========== 検索・連続記録・興味なし ==========
  const c = await openApp(browser, { name: 'テスト', log: [entry('c1', 'math', 20, 1), entry('c2', 'math', 20, 2)] });
  const page = c.page;
  state.section = '検索';
  await page.click('#search-open-btn');
  await page.fill('#search-input', 'ベクトル');
  check('キーワードで探せる', (await page.textContent('#result-count')) === '1件の動画');
  await page.fill('#search-input', '＃やる気');
  const kinds = await page.$$eval('.result-card .result-meta', ms => ms.map(m => m.textContent));
  check('全角の＃でもハッシュタグで探せる', kinds.length > 0 && kinds.every(k => k.includes('やる気')), kinds.join(','));
  await page.fill('#search-input', 'ぜったいにない言葉');
  check('見つからないときは言葉つきで案内', (await page.textContent('#empty-state')).includes('ぜったいにない言葉'));
  await page.fill('#search-input', '');
  await page.click('#search-back');
  await page.waitForTimeout(200);
  const firstTag = await page.$eval('#feed .short-slide:first-child [data-tag]', b => b.dataset.tag);
  await page.click('#feed .short-slide:first-child [data-tag]');
  await page.waitForTimeout(200);
  check('動画のハッシュタグを押すとそのタグで検索', (await active(page)) === 'search-screen' && (await page.inputValue('#search-input')) === '#' + firstTag && (await page.$$('.result-card')).length > 0, firstTag);
  await page.click('#search-back');
  await page.waitForTimeout(200);

  state.section = '連続記録';
  await nav(page, 'record');
  check('目標の欄はない', !(await page.$('#goal-select')) && !(await page.$('#goal-bar')));
  check('連続日数（昨日まで2日）', (await page.textContent('#streak-badge')).includes('連続2日'));
  await page.click('#manual-subject-chips .chip[data-id="english"]');
  await page.fill('#manual-minutes', '60');
  await page.click('#manual-add');
  await page.waitForTimeout(150);
  check('今日も勉強して連続3日', (await page.textContent('#streak-badge')).includes('連続3日'));
  const notes2 = await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_notifications')).map(n => n.text));
  check('連続3日の通知', notes2.length === 1 && notes2[0].includes('3日連続'), notes2.join(' / '));
  check('新しい通知の印（プロフィール）', await page.$eval('.screen.active .nav-btn[data-nav="profile"]', el => el.classList.contains('has-unread')));
  state.section = '通知';
  await nav(page, 'profile');
  check('ベルに未読の印', await page.$eval('#profile-bell', el => el.classList.contains('has-unread')));
  await page.click('#profile-bell');
  await page.waitForTimeout(150);
  check('通知の一覧', (await page.$$('.notify-row')).length === 1 && (await page.textContent('#notify-list')).includes('3日連続'));
  check('開くと既読になり印が消える', !(await page.$eval('#profile-bell', el => el.classList.contains('has-unread'))));
  await page.click('#notifications-back');
  await page.waitForTimeout(150);
  check('勉強時間は投稿より上（スクロールしなくても見える）', await page.evaluate(() => {
    const study = document.querySelector('.profile-study-row').getBoundingClientRect(), tabs = document.querySelector('#profile-screen .profile-tabs').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.profile-study-row > div')].map(el => el.getBoundingClientRect());
    return study.bottom <= tabs.top && study.bottom <= window.innerHeight && boxes.every(b => b.left >= 0 && b.right <= document.documentElement.clientWidth);
  }));
  check('友達は数が0', (await page.textContent('#profile-friends-count')) === '0');
  await page.click('[data-people-tab="friends"]'); await page.waitForTimeout(150);
  check('友達を押すと準備中と表示', (await page.textContent('#people-empty-title')).includes('準備中'));
  await page.click('#people-back'); await page.waitForTimeout(150);
  await page.screenshot({ path: OUT + 'features-profile.png' });

  state.section = '興味なし';
  await nav(page, 'home');
  const first = await page.$eval('#feed .short-slide:first-child', s => s.dataset.id);
  await page.click('#feed .short-slide:first-child [data-role="share"]');
  check('シェアに「興味なし」がある', await page.isVisible('#share-hide-options'));
  await page.click('[data-hide="video"]');
  await page.waitForTimeout(300);
  check('その動画がフィードから消える', !(await page.$(`#feed .short-slide[data-id="${first}"]`)) && (await toast(page)).includes('表示しない'));
  check('次の動画が再生される', await page.evaluate(() => !!currentSlide && currentSlide.classList.contains('is-active')));
  const creator = await page.evaluate(() => VIDEOS.find(v => v.id === currentSlide.dataset.id).creator);
  await page.evaluate(() => currentSlide.querySelector('[data-role="share"]').click());
  await page.click('[data-hide="creator"]');
  await page.waitForTimeout(300);
  for (let i = 1; i <= 12; i++) { await page.evaluate(i => { const f = document.getElementById('feed'); f.scrollTop = i * f.clientHeight; }, i); await page.waitForTimeout(80); }
  const shownCreators = await page.$$eval('#feed .short-slide', (ss) => ss.map(s => VIDEOS.find(v => v.id === s.dataset.id).creator));
  check('ブロックしたクリエイターの動画が出ない', !shownCreators.includes(creator), creator);
  check('検索にも出ない', await page.evaluate(([id, creator]) => !filteredVideos().some(v => v.id === id || v.creator === creator), [first, creator]));

  state.section = '設定';
  await nav(page, 'profile');
  await page.click('#profile-gear');
  await page.waitForTimeout(150);
  check('設定画面が開く', (await active(page)) === 'settings-screen');
  check('ブロック中のクリエイターが並ぶ', (await page.textContent('#settings-blocked')).includes(creator));
  check('興味なしの本数', (await page.textContent('#settings-hidden-count')).includes('1本'));
  await page.click(`[data-unblock="${creator}"]`);
  check('ブロックを解除できる', (await toast(page)).includes('また表示') && !(await page.textContent('#settings-blocked')).includes(creator));
  await page.click('#settings-hidden-reset');
  check('興味なしを戻せる', await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_hidden_videos')).length === 0));
  await page.screenshot({ path: OUT + 'features-settings.png' });

  // バックアップ
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup-export')]);
  const backupPath = OUT + 'backup.json';
  await download.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  check('バックアップを書き出せる', backup.app === 'zonenow' && backup.data.zonenow_study_log.length === 3 && backup.data.zonenow_profile.name === 'テスト');
  await page.evaluate(() => localStorage.setItem('zonenow_study_log', '[]'));
  await page.setInputFiles('#backup-import', backupPath);
  await page.waitForTimeout(200);
  check('読み込む前に確認', (await page.textContent('#confirm-message')).includes('置き換え'));
  await Promise.all([page.waitForNavigation(), page.click('#confirm-ok')]);
  await page.waitForTimeout(300);
  check('バックアップから戻せる', await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_study_log')).length === 3));
  fs.writeFileSync(OUT + 'not-backup.json', JSON.stringify({ hello: 1 }));
  await nav(page, 'profile'); await page.click('#profile-gear'); await page.waitForTimeout(150);
  await page.setInputFiles('#backup-import', OUT + 'not-backup.json');
  await page.waitForTimeout(150);
  check('関係ないファイルは読み込まない', (await toast(page)).includes('バックアップファイルではない'));
  // 同じサイトにある前のプロトタイプのデータ（zonenow_mvp_…）
  await page.evaluate(() => localStorage.setItem('zonenow_mvp_study_log', '[{"min":30}]'));
  await page.click('#settings-delete-all');
  await Promise.all([page.waitForNavigation(), page.click('#confirm-ok')]);
  await page.waitForTimeout(400);
  check('すべて削除すると最初の設定画面に戻る', (await active(page)) === 'onboarding-screen' && await page.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('zonenow_') && !k.startsWith('zonenow_mvp_'))));
  check('前のプロトタイプのデータは消さない', await page.evaluate(() => localStorage.getItem('zonenow_mvp_study_log') === '[{"min":30}]'));
  check('エラーなし（検索・連続記録・設定）', !c.errors.length, c.errors.join(' / '));
  await c.context.close();

  // ========== 読み込み中・読み込めないとき・オフライン ==========
  state.section = '読み込み表示';
  {
    const f = await openApp(browser, { name: 'ヨミコミ' });
    let blockVideos = true;
    await f.context.route('**/*.mp4', route => (blockVideos ? route.abort() : route.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(require('path').join(__dirname, 'assets', 'sample.webm')) })));
    await f.page.reload(); await f.page.waitForTimeout(1200);
    const first = '#feed .short-slide:first-child';
    const isVideo = await f.page.$eval(first, s => !!s.querySelector('video'));
    if (isVideo) {
      check('読み込めない動画には「もう一度読み込む」', await f.page.$eval(first, s => s.classList.contains('is-error')) && await f.page.isVisible(`${first} .video-retry`));
      check('理由を表示', (await f.page.textContent(`${first} .video-status-text`)).includes('読み込めませんでした'));
      blockVideos = false;
      await f.page.click(`${first} .video-retry`);
      check('もう一度読み込むと、読み込めたら表示が消える', await f.page.waitForFunction(s => !document.querySelector(s).classList.contains('is-error') && !document.querySelector(s).classList.contains('is-loading'), first, { timeout: 5000 }).then(() => true).catch(() => false));
    }
    check('最初は「オフライン」の帯を出さない', !(await f.page.isVisible('#offline-banner')));
    await f.context.setOffline(true);
    await f.page.waitForTimeout(200);
    check('電波がなくなると「オフライン」の帯', await f.page.isVisible('#offline-banner'));
    await f.context.setOffline(false);
    await f.page.waitForTimeout(200);
    check('電波が戻ると帯が消える', !(await f.page.isVisible('#offline-banner')));
    await f.page.click('.screen.active [data-nav="profile"]'); await f.page.click('#profile-gear'); await f.page.waitForTimeout(200);
    check('設定にバージョン', (await f.page.textContent('#settings-version')).includes('バージョン 1.0.0（ウェブ）'));
    check('設定からプライバシーポリシーを開ける（公開ページ・別のタブ）', await f.page.$eval('#settings-screen .privacy-link', a => a.href === 'https://ryugo201001037-wq.github.io/zo-ne-NOW/app/privacy.html' && a.target === '_blank'));
    check('登録画面にもプライバシーポリシーへの同意の案内', await f.page.$eval('#onboarding-policy', el => el.textContent.includes('同意') && el.querySelector('a').href.endsWith('/privacy.html')));
    const policy = await f.context.newPage();
    const policyErrors = [];
    policy.on('pageerror', e => policyErrors.push(e.message));
    await policy.goto(APP_URL.replace(/[^/]*$/, '') + 'privacy.html');
    check('プライバシーポリシーのページが開ける', (await policy.textContent('h1')) === 'プライバシーポリシー' && !policyErrors.length);
    check('ポリシーに、投稿がみんなに見えること・削除のしかたが書いてある', /すべての人が見られます/.test(await policy.textContent('main')) && /すべてのデータを削除する/.test(await policy.textContent('main')));
    await policy.close();
    await f.page.click('#feedback-send');
    check('ご意見：空では送らない', (await f.page.textContent('#toast')).includes('入力'));
    await f.page.fill('#feedback-input', 'テストの意見');
    await f.page.click('#feedback-send');
    check('ご意見：サーバーがない画面では送れないと伝える', (await f.page.textContent('#toast')).includes('この画面からは送れません'));
    check('エラーなし（読み込み表示）', !f.errors.length, f.errors.join(' / '));
    await f.context.close();
  }

  // ========== iPhoneでホーム画面追加の案内 ==========
  state.section = 'iPhoneの案内';
  const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const d = await openApp(browser, { name: 'アイ', ua: iphoneUa });
  check('iPhoneのSafariではやり方を案内', await d.page.$eval('#install-banner', el => el.classList.contains('show')) && (await d.page.textContent('#install-banner')).includes('ホーム画面に追加'));
  await d.page.click('#install-close');
  await d.page.reload(); await d.page.waitForTimeout(300);
  check('閉じたらもう出さない', !(await d.page.$eval('#install-banner', el => el.classList.contains('show'))));
  await d.context.close();
  const e = await openApp(browser, { name: 'アン' });
  check('iPhone以外では出さない', !(await e.page.$eval('#install-banner', el => el.classList.contains('show'))));
  await e.context.close();

  report();
  await browser.close();
  server.close();
})();
