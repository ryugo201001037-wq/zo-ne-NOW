// 追加機能のテスト：友達・キーワード検索・目標と連続記録・興味なし・通知・設定・iPhoneの案内（実行：npm test）
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

  // ========== 友達 ==========
  state.section = '友達';
  const a = await openApp(browser, { name: 'あおい', log: [entry('a1', 'math', 90, 0), entry('a2', 'english', 60, 2)] });
  await nav(a.page, 'profile');
  check('プロフィールに「自分の記録を送る」', await a.page.isVisible('#friends-send'));
  await a.page.click('#friends-send');
  check('送るシートが開く', (await a.page.textContent('#share-sheet-title')) === '自分の記録を友達に送る');
  check('記録を送るときは「興味なし」を出さない', !(await a.page.isVisible('#share-hide-options')));
  await a.page.click('#share-sheet-close');
  const linkA1 = await a.page.evaluate(() => friendLinkUrl());
  check('リンクに記録カードが入る', /\?friend=[A-Za-z0-9_-]+$/.test(linkA1) && linkA1.length < 1500, linkA1.length);
  await a.page.goto(linkA1);
  await a.page.waitForTimeout(400);
  check('自分のリンクを開くと「あなた自身」', (await toast(a.page)).includes('あなた自身'));

  const b = await openApp(browser, { name: 'ひかる', log: [entry('b1', 'japanese', 30, 0)] });
  await b.page.goto(linkA1);
  await b.page.waitForTimeout(400);
  check('友達リンクで確認が出る', (await b.page.textContent('#confirm-message')).includes('あおいさん（中学2年）の勉強記録が届きました'));
  await b.page.click('#confirm-ok');
  await b.page.waitForTimeout(300);
  check('友達一覧（ランキング）が開く', (await active(b.page)) === 'people-screen' && (await b.page.textContent('.people-tab.active')) === '友達');
  const rows = await b.page.$$eval('#people-list .friend-row', rs => rs.map(r => r.querySelector('.friend-name').textContent + '|' + r.querySelector('.friend-week').textContent + '|' + r.querySelector('.friend-today').textContent));
  check('友達の勉強時間が見える（多い順）', rows[0] === 'あおい|2時間30分|今日 1時間30分' && rows[1] === 'ひかるあなた|30分|今日 30分', rows.join(' / '));
  check('URLから友達リンクが消える（再読み込みで二重にならない）', !b.page.url().includes('friend='));
  await b.page.screenshot({ path: OUT + 'features-friends.png' });
  await nav(b.page, 'profile');
  check('プロフィールの友達の数', (await b.page.textContent('#profile-friends-count')) === '1');
  check('プロフィールにランキング', (await b.page.$$('#profile-friends-ranking .friend-row')).length === 2);
  check('新しい通知の印', await b.page.$eval('#profile-bell', el => el.classList.contains('has-unread')));

  await b.page.goto(linkA1);
  await b.page.waitForTimeout(400);
  check('同じリンクをもう一度開くと「最新です」', (await toast(b.page)).includes('最新'));
  // あおいが勉強を足して送り直す
  await a.page.evaluate(() => { const log = JSON.parse(localStorage.getItem('zonenow_study_log')); log.push({ id: 'a3', subject: 'science', subjectOther: '', seconds: 1800, date: log[0].date, source: 'manual', createdAt: Date.now() }); localStorage.setItem('zonenow_study_log', JSON.stringify(log)); });
  await a.page.waitForTimeout(20);
  const linkA2 = await a.page.evaluate(() => friendLinkUrl());
  await b.page.goto(linkA2);
  await b.page.waitForTimeout(400);
  check('新しいリンクで記録が更新される', (await toast(b.page)).includes('更新しました') && (await b.page.$eval('#people-list .friend-row .friend-week', e => e.textContent)) === '3時間');

  await b.page.goto(APP_URL + '?friend=abc');
  await b.page.waitForTimeout(400);
  check('壊れたリンクは読み取れないと伝える', (await toast(b.page)).includes('読み取れません'));
  // 名前にタグを仕込んだカード
  const evil = await b.page.evaluate(() => toBase64Url(JSON.stringify({ v: 1, id: 'evil-id-0123456789abc', n: '<img src=x onerror=alert(1)>', g: '', t: Date.now(), d: [], s: {} })));
  await b.page.goto(APP_URL + '?friend=' + evil);
  await b.page.waitForTimeout(400);
  await b.page.click('#confirm-ok');
  await b.page.waitForTimeout(300);
  check('名前のタグは文字として表示（実行されない）', (await b.page.$$('#people-list img')).length === 0 && (await b.page.textContent('#people-list')).includes('<img src=x'));
  await b.page.click('[data-remove-friend="evil-id-0123456789abc"]');
  await b.page.click('#confirm-ok');
  check('友達から外せる', (await b.page.$$('#people-list .friend-row')).length === 2);

  // 通知
  state.section = '通知';
  await nav(b.page, 'profile');
  await b.page.click('#profile-bell');
  await b.page.waitForTimeout(150);
  const notes = await b.page.$$eval('.notify-row .notify-text', ns => ns.map(n => n.textContent));
  check('友達追加・更新・抜かれた通知', notes.some(t => t.includes('あおいさんと友達になりました')) && notes.some(t => t.includes('更新されました')), notes.join(' / '));
  check('開くと既読になり印が消える', !(await b.page.$eval('#profile-bell', el => el.classList.contains('has-unread'))));
  check('エラーなし（友達）', !a.errors.length && !b.errors.length, [...a.errors, ...b.errors].join(' / '));
  await a.context.close(); await b.context.close();

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
  await page.reload(); await page.waitForTimeout(300);
  await nav(page, 'record');
  check('目標は保存される', (await page.inputValue('#goal-select')) === '60');
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
  check('すべて削除すると最初の設定画面に戻る', (await active(page)) === 'onboarding-screen' && await page.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('zonenow_') && k !== 'zonenow_user_id' && k !== 'zonenow_notifications')));
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
