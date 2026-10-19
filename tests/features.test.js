// 追加機能のテスト：キーワード検索・目標と連続記録・興味なし・通知・設定・iPhoneの案内（実行：npm test）
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

  // ========== 検索・目標・興味なし ==========
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

  state.section = '目標と連続記録';
  await nav(page, 'record');
  check('目標なしでは進み具合を出さない', await page.$eval('#goal-bar', el => el.hidden));
  check('連続日数（昨日まで2日）', (await page.textContent('#streak-badge')).includes('連続2日'));
  await page.selectOption('#goal-select', '60');
  check('目標を決めると残りを表示', (await page.textContent('#goal-text')) === '目標1時間まで、あと1時間' && !(await page.$eval('#goal-bar', el => el.hidden)));
  await page.click('#manual-subject-chips .chip[data-id="english"]');
  await page.fill('#manual-minutes', '60');
  await page.click('#manual-add');
  await page.waitForTimeout(150);
  check('目標達成の表示', (await page.textContent('#goal-text')) === '今日の目標を達成！');
  check('今日も勉強して連続3日', (await page.textContent('#streak-badge')).includes('連続3日'));
  const notes2 = await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_notifications')).map(n => n.text));
  check('目標達成と連続3日の通知', notes2.some(t => t.includes('目標（1時間）を達成')) && notes2.some(t => t.includes('3日連続')), notes2.join(' / '));
  check('新しい通知の印（プロフィール）', await page.$eval('.screen.active .nav-btn[data-nav="profile"]', el => el.classList.contains('has-unread')));
  await page.reload(); await page.waitForTimeout(300);
  await nav(page, 'record');
  check('目標は保存される', (await page.inputValue('#goal-select')) === '60');
  state.section = '通知';
  await nav(page, 'profile');
  check('ベルに未読の印', await page.$eval('#profile-bell', el => el.classList.contains('has-unread')));
  await page.click('#profile-bell');
  await page.waitForTimeout(150);
  check('通知の一覧', (await page.$$('.notify-row')).length === 2 && (await page.textContent('#notify-list')).includes('3日連続'));
  check('開くと既読になり印が消える', !(await page.$eval('#profile-bell', el => el.classList.contains('has-unread'))));
  await page.click('#notifications-back');
  await page.waitForTimeout(150);
  check('友達は準備中と表示', (await page.textContent('#profile-screen .friends-title')).includes('準備中') && (await page.textContent('#profile-friends-count')) === '0');
  await page.screenshot({ path: OUT + 'features-goal.png' });

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
  check('バックアップを書き出せる', backup.app === 'zonenow' && backup.data.zonenow_study_log.length === 3 && backup.data.zonenow_goal_minutes === 60);
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
  await page.click('#settings-delete-all');
  await Promise.all([page.waitForNavigation(), page.click('#confirm-ok')]);
  await page.waitForTimeout(400);
  check('すべて削除すると最初の設定画面に戻る', (await active(page)) === 'onboarding-screen' && await page.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('zonenow_'))));
  check('エラーなし（検索・目標・設定）', !c.errors.length, c.errors.join(' / '));
  await c.context.close();

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
