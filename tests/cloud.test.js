// アカウント（名前だけ登録）とサーバー保存のテスト（実行：npm test）
// 本物のSupabaseの代わりに、同じ形で答える「にせSupabase」をローカルで動かし、アプリのSupabaseライブラリ（vendor/supabase.js）をそのまま使う
const http = require('http');
const crypto = require('crypto');
const { OUT, APP_URL, startServer, launchBrowser, createChecker } = require('./helpers');
const { check, state, report } = createChecker();

// ---- にせSupabase（ログイン：GoTrue、データ：PostgREST の必要なところだけ） ----
function startFakeSupabase() {
  const fake = { users: new Map(), profiles: new Map(), logs: new Map(), signups: 0, offline: false, rejectNextLog: false, rpcCalls: 0 };
  const userOf = req => {
    const m = /^Bearer tok-(.+)$/.exec(req.headers.authorization || '');
    return m && fake.users.has(m[1]) ? m[1] : null;
  };
  const server = http.createServer(async (req, res) => {
    if (fake.offline) { req.socket.destroy(); return; }
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
      'Access-Control-Expose-Headers': '*',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || 'null') : null;
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    const p = url.pathname;

    if (p === '/auth/v1/signup' && req.method === 'POST') {
      fake.signups++;
      const id = crypto.randomUUID();
      const user = { id, aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
      fake.users.set(id, user);
      return send(200, { access_token: 'tok-' + id, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'ref-' + id, user });
    }
    if (p === '/auth/v1/logout') return send(204);
    if (p === '/auth/v1/user') { const u = userOf(req); return u ? send(200, fake.users.get(u)) : send(401, { message: 'invalid' }); }

    const uid = userOf(req);
    if (p.startsWith('/rest/v1/') && !uid) return send(401, { message: 'JWT required' });
    if (p === '/rest/v1/profiles' && req.method === 'POST') {
      for (const row of [].concat(body)) {
        if (row.id !== uid) return send(403, { code: '42501', message: 'row-level security' });
        fake.profiles.set(uid, row);
      }
      return send(201);
    }
    if (p === '/rest/v1/study_logs' && req.method === 'POST') {
      if (fake.rejectNextLog) { fake.rejectNextLog = false; return send(400, { code: '23514', message: 'check violation' }); }
      for (const row of [].concat(body)) {
        if (row.user_id !== uid) return send(403, { code: '42501', message: 'row-level security' });
        if (!(row.seconds > 0)) return send(400, { code: '23514', message: 'check violation' });
        fake.logs.set(`${uid}/${row.id}`, row);
      }
      return send(201);
    }
    if (p === '/rest/v1/study_logs' && req.method === 'DELETE') {
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      const user = (url.searchParams.get('user_id') || '').replace(/^eq\./, '');
      for (const [k, row] of fake.logs) {
        if (row.user_id === uid && (!id || row.id === id) && (!user || row.user_id === user)) fake.logs.delete(k);
      }
      return send(204);
    }
    if (p === '/rest/v1/rpc/delete_my_account' && req.method === 'POST') {
      fake.rpcCalls++;
      fake.users.delete(uid); fake.profiles.delete(uid);
      for (const [k, row] of fake.logs) if (row.user_id === uid) fake.logs.delete(k);
      return send(204);
    }
    send(404, { message: 'not found: ' + p });
  });
  return new Promise(r => server.listen(0, () => { fake.url = `http://localhost:${server.address().port}`; fake.close = () => { server.closeAllConnections(); server.close(); }; r(fake); }));
}

(async () => {
  const server = await startServer();
  const browser = await launchBrowser();
  const fake = await startFakeSupabase();
  const logsOf = () => [...fake.logs.values()];
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

  async function openApp(init = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(([url, init]) => {
      window.confirm = () => false;
      window.ZONENOW_CONFIG = { supabaseUrl: url, supabaseAnonKey: 'test-anon-key' };
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        Object.entries(init).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
      }
    }, [fake.url, init]);
    await page.goto(APP_URL);
    await page.waitForTimeout(400);
    return { context, page, errors };
  }
  const toast = page => page.textContent('#toast').catch(() => '');
  const active = page => page.$eval('.screen.active', el => el.id);
  const nav = async (page, n) => { await page.click(`.screen.active [data-nav="${n}"]`); await page.waitForTimeout(150); };

  // ========== 名前だけで登録 ==========
  state.section = '登録';
  const { context, page, errors } = await openApp();
  check('最初は登録画面', (await active(page)) === 'onboarding-screen');
  fake.offline = true;
  await page.fill('#onboarding-name', 'みなと');
  await page.click('#onboarding-grade-chips .chip[data-id="high1"]');
  await page.click('#onboarding-submit');
  await page.waitForTimeout(800);
  check('電波がないと登録できず、そのまま待つ', (await toast(page)).includes('登録できませんでした') && (await active(page)) === 'onboarding-screen');
  fake.offline = false;
  await page.click('#onboarding-submit');
  check('名前と学年だけで登録できる', await waitFor(async () => (await active(page)) === 'home-screen'));
  const uid = [...fake.users.keys()][0];
  check('サーバーにアカウントができる（1つだけ）', fake.signups === 1 && fake.users.size === 1);
  check('サーバーにプロフィールが保存される', await waitFor(() => fake.profiles.get(uid) && fake.profiles.get(uid).name === 'みなと' && fake.profiles.get(uid).grade === 'high1'), JSON.stringify(fake.profiles.get(uid)));
  check('ログイン情報が端末に保存される', await page.evaluate(() => !!localStorage.getItem('zonenow_auth')));
  await page.reload(); await page.waitForTimeout(500);
  check('次からは自動でログイン（登録し直さない）', (await active(page)) === 'home-screen' && fake.signups === 1);

  // ========== 記録をサーバーにも保存 ==========
  state.section = '記録の保存';
  await nav(page, 'record');
  await page.click('#manual-subject-chips .chip[data-id="math"]');
  await page.fill('#manual-minutes', '45');
  await page.click('#manual-add');
  check('記録がサーバーに保存される', await waitFor(() => logsOf().length === 1 && logsOf()[0].seconds === 2700 && logsOf()[0].subject === 'math' && logsOf()[0].user_id === uid), JSON.stringify(logsOf()));
  await page.click('#today-list .study-row-delete'); await page.click('#confirm-ok');
  check('記録を消すとサーバーからも消える', await waitFor(() => logsOf().length === 0));
  await page.selectOption('#goal-select', '90');
  check('目標もサーバーに保存', await waitFor(() => fake.profiles.get(uid).goal_minutes === 90));

  state.section = '電波がないとき';
  fake.offline = true;
  await page.click('#manual-subject-chips .chip[data-id="english"]');
  await page.fill('#manual-minutes', '30');
  await page.click('#manual-add');
  await page.waitForTimeout(800);
  check('電波がなくても記録はできる（端末に保存）', (await page.textContent('#study-today')) === '30分');
  check('送れなかった変更は残しておく', await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_sync_queue')).length === 1));
  await nav(page, 'profile'); await page.click('#profile-gear'); await page.waitForTimeout(200);
  check('設定に「まだ送れていない変更」', (await page.textContent('#settings-account')).includes('まだ送れていない変更：1件'), await page.textContent('#settings-account'));
  fake.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  check('つながったら自動で送る', await waitFor(() => logsOf().length === 1 && logsOf()[0].subject === 'english'));
  check('送れたらキューは空', await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_sync_queue')).length === 0));
  await page.click('#settings-back'); await page.waitForTimeout(150); await page.click('#profile-gear'); await page.waitForTimeout(200);
  check('設定に「ログイン中」', (await page.textContent('#settings-account')).includes('ログイン中'));

  state.section = '断られた変更';
  fake.rejectNextLog = true;
  await nav(page, 'record');
  await page.click('#manual-subject-chips .chip[data-id="science"]');
  await page.fill('#manual-minutes', '10'); await page.click('#manual-add');
  await page.fill('#manual-minutes', '20'); await page.click('#manual-add');
  check('サーバーに断られた変更で、後ろの変更が止まらない', await waitFor(() => logsOf().some(r => r.seconds === 1200)) && await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_sync_queue')).length === 0));
  await page.screenshot({ path: OUT + 'cloud-record.png' });

  // ========== すべて削除（退会） ==========
  state.section = '退会';
  await nav(page, 'profile'); await page.click('#profile-gear'); await page.waitForTimeout(200);
  await page.click('#settings-delete-all');
  check('確認にアカウントの削除も書いてある', (await page.textContent('#confirm-message')).includes('アカウント'));
  await Promise.all([page.waitForNavigation(), page.click('#confirm-ok')]);
  await page.waitForTimeout(400);
  check('サーバーのアカウントとデータも消える', fake.rpcCalls === 1 && !fake.users.has(uid) && !fake.profiles.has(uid) && logsOf().every(r => r.user_id !== uid));
  check('最初の登録画面に戻る', (await active(page)) === 'onboarding-screen' && await page.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('zonenow_'))));
  check('エラーなし', !errors.length, errors.join(' / '));
  await context.close();

  // ========== 前から使っていた人 ==========
  state.section = '前から使っていた人';
  const today = new Date(); const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const old = await openApp({
    zonenow_profile: { name: 'さくら', grade: 'junior3', createdAt: 1 },
    zonenow_study_log: [{ id: 'old1', subject: 'japanese', subjectOther: '', seconds: 1500, date: key, source: 'timer', createdAt: 1 }],
  });
  check('登録画面は出さずに使える', (await active(old.page)) === 'home-screen');
  const oldUid = [...fake.users.keys()].find(id => id !== uid);
  check('自動でアカウントを作り、端末の記録を送る', await waitFor(() => !!oldUid || fake.users.size === 1) && await waitFor(() => {
    const id = [...fake.users.keys()][0];
    return id && fake.profiles.get(id) && fake.profiles.get(id).name === 'さくら' && logsOf().some(r => r.id === 'old1' && r.user_id === id);
  }));
  check('エラーなし', !old.errors.length, old.errors.join(' / '));
  await old.context.close();

  // ========== サーバー未設定なら今まで通り ==========
  state.section = 'サーバー未設定';
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx.newPage();
  await p2.goto(APP_URL); await p2.waitForTimeout(300);
  await p2.fill('#onboarding-name', 'ローカル'); await p2.click('#onboarding-grade-chips .chip[data-id="junior1"]'); await p2.click('#onboarding-submit');
  await p2.waitForTimeout(300);
  check('サーバーなしでも登録して使える', (await active(p2)) === 'home-screen');
  check('Supabaseのライブラリは読み込まない', await p2.evaluate(() => !window.supabase));
  await ctx.close();

  report();
  fake.close();
  await browser.close();
  server.close();
})();
