// 画面サイズのテスト：小さいスマホ〜大きいスマホ〜パソコンで、各画面が崩れないか（実行：npm test）
// ・横にはみ出す要素がない ・入力欄の文字が16px以上（iPhoneの自動拡大を防ぐ）
// ・押すボタンが指で押せる大きさ ・パソコンではスマホの幅で真ん中に表示
const { ASSETS, OUT, APP_URL, startServer, launchBrowser, createChecker } = require('./helpers');
const { check, state, report } = createChecker();

const VIEWPORTS = [
  { w: 320, h: 568, name: 'iPhone SE(第1世代)' },
  { w: 375, h: 667, name: 'iPhone SE' },
  { w: 390, h: 844, name: 'iPhone 14' },
  { w: 430, h: 932, name: 'iPhone Pro Max' },
  { w: 360, h: 740, name: 'Android' },
  { w: 1280, h: 800, name: 'パソコン' },
];
const MIN_TAP = 40; // 押せる大きさの下限（px）

(async () => {
  const server = await startServer();
  const browser = await launchBrowser();

  for (const vp of VIEWPORTS) {
    state.section = `${vp.name} ${vp.w}x${vp.h}`;
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.confirm = () => false;
      localStorage.setItem('zonenow_profile', JSON.stringify({ name: 'ゾーン花子テスト長い名前', grade: 'junior2', createdAt: 1 }));
      const d = new Date(); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      localStorage.setItem('zonenow_study_log', JSON.stringify([{ id: 'a', subject: 'math', seconds: 3600, date: k, source: 'manual', createdAt: 1 }]));
    });
    await page.goto(APP_URL);
    await page.waitForTimeout(400);

    // 今の画面を調べる：はみ出し・小さい入力文字・小さいボタン
    const inspect = () => page.evaluate(minTap => {
      const scr = document.querySelector('.screen.active');
      const app = document.getElementById('app').getBoundingClientRect();
      const overflow = [], smallFont = [], smallTap = [];
      const name = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList].join('.') : ''}`;
      scr.querySelectorAll('*').forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        // 横スクロールする入れ物の中身は対象外
        for (let p = el.parentElement; p && p !== scr; p = p.parentElement) {
          if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(p).overflowX)) return;
        }
        if (r.right > app.right + 1 || r.left < app.left - 1) overflow.push(name(el));
      });
      scr.querySelectorAll('input:not([type=file]):not([type=hidden]), textarea, select').forEach(el => {
        if (el.getBoundingClientRect().width && parseFloat(getComputedStyle(el).fontSize) < 16) smallFont.push(name(el));
      });
      scr.querySelectorAll('button').forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const after = getComputedStyle(el, '::after');
        const expanded = after.content !== 'none' && after.position === 'absolute'; // 見えない範囲で押せる所を広げている
        // チップとカレンダーの日付は、並べて使う（1行に7日など）ので少し小さくてもよい
        const minSide = el.classList.contains('chip') ? 38 : el.classList.contains('cal-day') ? 34 : minTap;
        if (!expanded && (r.width < minSide || r.height < minSide)) smallTap.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
      return { overflow: [...new Set(overflow)], smallFont, smallTap };
    }, MIN_TAP);

    const screens = [];
    const capture = async label => { screens.push([label, await inspect()]); await page.screenshot({ path: `${OUT}layout-${vp.w}x${vp.h}-${label}.png` }); };
    const nav = async n => { await page.click(`.screen.active [data-nav="${n}"]`); await page.waitForTimeout(420); };
    await capture('ホーム');
    await page.click('#search-open-btn'); await page.waitForTimeout(420); await capture('検索');
    await page.click('#search-back'); await page.waitForTimeout(300);
    await nav('create'); await capture('投稿');
    await page.setInputFiles('#post-file-input', [ASSETS + 'p1.png', ASSETS + 'p2.png']);
    await page.fill('#post-title', 'タイトルがちょっと長い場合の表示確認');
    await page.click('#post-grade-chips .chip[data-id="junior2"]');
    await page.click('#post-next'); await page.waitForTimeout(420); await capture('プレビュー');
    await page.click('#preview-back'); await page.waitForTimeout(300);
    await nav('record'); await capture('記録');
    await page.click('#history-open'); await page.waitForTimeout(420); await capture('カレンダー');
    await page.click('#history-back'); await page.waitForTimeout(300);
    await nav('profile'); await capture('プロフィール');
    await page.click('[data-people-tab="following"]'); await page.waitForTimeout(420); await capture('フォロー一覧');
    await page.click('#people-back'); await page.waitForTimeout(300);
    await nav('ai'); await page.click('[data-ai-suggest="今日の勉強プランを作って"]'); await capture('AI');

    for (const [label, r] of screens) {
      check(`${label}：横にはみ出さない`, !r.overflow.length, r.overflow.slice(0, 5).join(', '));
      if (r.smallFont.length) check(`${label}：入力欄の文字は16px以上`, false, r.smallFont.join(', '));
      check(`${label}：ボタンが押せる大きさ`, !r.smallTap.length, r.smallTap.slice(0, 5).join(', '));
    }
    const navOk = await page.$$eval('.screen.active .bottom-nav .nav-text', els => els.every(e => e.getBoundingClientRect().height < 16));
    check('ナビの文字が1行に収まる', navOk);
    const appBox = await page.$eval('#app', el => el.getBoundingClientRect().toJSON());
    if (vp.w >= 600) {
      check('パソコンではスマホの幅（430px）で真ん中に表示', Math.round(appBox.width) === 430 && Math.abs(appBox.left + appBox.width / 2 - vp.w / 2) < 2, JSON.stringify(appBox));
    } else {
      check('スマホでは画面いっぱいに表示', Math.round(appBox.width) === vp.w && Math.round(appBox.height) === vp.h, JSON.stringify(appBox));
    }
    check('エラーなし', !errors.length, errors.join(' / '));
    await page.close();
  }

  report();
  await browser.close();
  server.close();
})();
