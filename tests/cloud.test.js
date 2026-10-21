// アカウント（名前だけ登録）とサーバー保存のテスト（実行：npm test）
// 本物のSupabaseの代わりに、同じ形で答える「にせSupabase」をローカルで動かし、アプリのSupabaseライブラリ（vendor/supabase.js）をそのまま使う
const http = require('http');
const crypto = require('crypto');
const { OUT, APP_URL, startServer, launchBrowser, createChecker } = require('./helpers');
const { check, state, report } = createChecker();

// ---- にせSupabase（ログイン：GoTrue、データ：PostgREST の必要なところだけ） ----
function startFakeSupabase() {
  const fake = { users: new Map(), profiles: new Map(), logs: new Map(), feedback: [], signups: 0, offline: false, rejectNextLog: false, rpcCalls: 0,
    posts: [], files: new Map(), reports: [], failUpload: false, likes: [], saves: [], comments: [], warmed: [] };
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
    const raw = Buffer.concat(chunks);
    const isJson = (req.headers['content-type'] || '').includes('json');
    const body = isJson && raw.length ? JSON.parse(raw.toString() || 'null') : null;
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    const p = url.pathname;

    // ---- Storage（投稿のファイル置き場） ----
    const PUBLIC = '/storage/v1/object/public/posts/';
    if (p.startsWith(PUBLIC) && req.method === 'GET') {
      const file = fake.files.get(decodeURIComponent(p.slice(PUBLIC.length)));
      if (!file) return send(404, { message: 'not found' });
      if (req.headers.range === 'bytes=0-65535') fake.warmed.push(decodeURIComponent(p.slice(PUBLIC.length))); // 先読み
      res.writeHead(200, { ...cors, 'Content-Type': file.type, 'Content-Length': file.body.length });
      res.end(file.body);
      return;
    }
    if (p.startsWith('/storage/v1/object/posts/') && req.method === 'POST') {
      const uidUp = userOf(req);
      const name = p.slice('/storage/v1/object/posts/'.length).split('/').map(decodeURIComponent).join('/');
      if (!uidUp) return send(400, { statusCode: '403', error: 'Unauthorized', message: 'no token' });
      if (fake.failUpload) { req.socket.destroy(); return; }
      if (name.split('/')[0] !== uidUp || name.split('/').length < 2) return send(400, { statusCode: '403', error: 'Unauthorized', message: 'row-level security' });
      if (fake.files.has(name)) return send(400, { statusCode: '409', error: 'Duplicate', message: 'exists' });
      fake.files.set(name, { type: req.headers['content-type'], body: raw, owner: uidUp });
      return send(200, { Key: 'posts/' + name });
    }
    if (p === '/storage/v1/object/posts' && req.method === 'DELETE') {
      const uidDel = userOf(req);
      const removed = [];
      for (const name of (body && body.prefixes) || []) {
        if (fake.files.has(name) && fake.files.get(name).owner === uidDel) { fake.files.delete(name); removed.push({ name }); }
      }
      return send(200, removed);
    }

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
    if (p === '/rest/v1/feedback' && req.method === 'POST') {
      for (const row of [].concat(body)) {
        if (row.user_id && row.user_id !== uid) return send(403, { code: '42501', message: 'row-level security' });
        if (!row.message || row.message.length > 1000) return send(400, { code: '23514', message: 'check violation' });
        fake.feedback.push({ ...row, user_id: uid });
      }
      return send(201);
    }
    if (p === '/rest/v1/posts' && req.method === 'GET') {
      const user = (url.searchParams.get('user_id') || '').replace(/^eq\./, '');
      return send(200, fake.posts.filter(r => !user || r.user_id === user).slice().sort((a, b) => b.created_at.localeCompare(a.created_at)));
    }
    if (p === '/rest/v1/posts' && req.method === 'POST') {
      for (const row of [].concat(body)) {
        if (row.user_id && row.user_id !== uid) return send(403, { code: '42501', message: 'row-level security' });
        if (!row.title || !row.media_paths || !row.media_paths.length || !(row.duration >= 1 && row.duration <= 200)) return send(400, { code: '23514', message: 'check violation' });
        fake.posts.push({ ...row, user_id: uid, created_at: new Date().toISOString() });
      }
      return send(201);
    }
    if (p === '/rest/v1/posts' && req.method === 'DELETE') {
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      if (fake.posts.some(r => r.id === id && r.user_id === uid)) {
        fake.posts = fake.posts.filter(r => r.id !== id);
        for (const key of ['likes', 'saves', 'comments']) fake[key] = fake[key].filter(r => r.post_id !== id);
      }
      return send(204);
    }
    if (p === '/rest/v1/reports' && req.method === 'POST') {
      for (const row of [].concat(body)) {
        if (fake.reports.some(r => r.post_id === row.post_id && r.user_id === uid)) return send(409, { code: '23505', message: 'duplicate' });
        fake.reports.push({ ...row, user_id: uid });
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
    // ---- いいね・保存・コメント ----
    const eqOf = name => (url.searchParams.get(name) || '').replace(/^eq\./, '');
    const wantsObject = (req.headers.accept || '').includes('vnd.pgrst.object');
    if ((p === '/rest/v1/likes' || p === '/rest/v1/saves') && req.method === 'POST') {
      const list = p.endsWith('likes') ? fake.likes : fake.saves;
      for (const row of [].concat(body)) {
        if (row.user_id && row.user_id !== uid) return send(403, { code: '42501', message: 'row-level security' });
        if (list.some(r => r.post_id === row.post_id && r.user_id === uid)) return send(409, { code: '23505', message: 'duplicate' });
        list.push({ post_id: row.post_id, user_id: uid });
      }
      return send(201);
    }
    if ((p === '/rest/v1/likes' || p === '/rest/v1/saves') && req.method === 'DELETE') {
      const key = p.endsWith('likes') ? 'likes' : 'saves';
      fake[key] = fake[key].filter(r => !(r.post_id === eqOf('post_id') && r.user_id === uid));
      return send(204);
    }
    if (p === '/rest/v1/rpc/post_stats' && req.method === 'POST') {
      return send(200, ((body && body.ids) || []).filter(id => fake.posts.some(r => r.id === id)).map(id => ({
        post_id: id, likes: fake.likes.filter(r => r.post_id === id).length, saves: fake.saves.filter(r => r.post_id === id).length,
        comments: fake.comments.filter(r => r.post_id === id).length,
        liked: fake.likes.some(r => r.post_id === id && r.user_id === uid), saved: fake.saves.some(r => r.post_id === id && r.user_id === uid),
      })));
    }
    if (p === '/rest/v1/comments' && req.method === 'GET') {
      return send(200, fake.comments.filter(r => r.post_id === eqOf('post_id')).sort((a, b) => a.created_at.localeCompare(b.created_at)));
    }
    if (p === '/rest/v1/comments' && req.method === 'POST') {
      const row = [].concat(body)[0];
      if (row.user_id && row.user_id !== uid) return send(403, { code: '42501', message: 'row-level security' });
      if (!row.body || !row.body.trim() || row.body.length > 200) return send(400, { code: '23514', message: 'check violation' });
      const saved = { id: crypto.randomUUID(), post_id: row.post_id, user_id: uid, author: row.author, body: row.body, created_at: new Date().toISOString() };
      fake.comments.push(saved);
      return send(201, wantsObject ? saved : [saved]);
    }
    if (p === '/rest/v1/comments' && req.method === 'DELETE') {
      const id = eqOf('id');
      const target = fake.comments.find(r => r.id === id);
      const allowed = target && (target.user_id === uid || fake.posts.some(x => x.id === target.post_id && x.user_id === uid));
      if (!allowed) return send(200, []);
      fake.comments = fake.comments.filter(r => r.id !== id);
      return send(200, [{ id }]);
    }
    if (p === '/rest/v1/rpc/search_users' && req.method === 'POST') {
      const q = String((body && body.q) || '').trim();
      const rows = q ? [...fake.profiles.values()].filter(r => r.name.includes(q)).map(r => ({ id: r.id, name: r.name })) : [];
      rows.sort((x, y) => (y.name === q) - (x.name === q) || x.name.length - y.name.length);
      return send(200, rows.slice(0, 20));
    }
    if (p === '/rest/v1/rpc/delete_my_account' && req.method === 'POST') {
      fake.rpcCalls++;
      fake.users.delete(uid); fake.profiles.delete(uid);
      const gone = fake.posts.filter(r => r.user_id === uid).map(r => r.id);
      fake.posts = fake.posts.filter(r => r.user_id !== uid);
      for (const key of ['likes', 'saves', 'comments']) fake[key] = fake[key].filter(r => r.user_id !== uid && !gone.includes(r.post_id));
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

  async function openApp(init = {}, config = {}, query = '') {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(([url, init, config]) => {
      window.confirm = () => false;
      window.ZONENOW_CONFIG = { supabaseUrl: url, supabaseAnonKey: 'test-anon-key', ...config };
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        Object.entries(init).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
      }
    }, [fake.url, init, config]);
    await page.goto(APP_URL + query);
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
  check('送れたらキューは空', await waitFor(() => page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_sync_queue')).length === 0)));
  await page.click('#settings-back'); await page.waitForTimeout(150); await page.click('#profile-gear'); await page.waitForTimeout(200);
  check('設定に「ログイン中」', (await page.textContent('#settings-account')).includes('ログイン中'));

  state.section = 'ご意見';
  await nav(page, 'profile'); await page.click('#profile-gear'); await page.waitForTimeout(200);
  await page.fill('#feedback-input', 'AIの画面の送信ボタンが押しにくい');
  await page.click('#feedback-send');
  check('ご意見がサーバーに届く（誰からか・バージョン・ウェブ）', await waitFor(() => fake.feedback.length === 1 && fake.feedback[0].user_id === uid && fake.feedback[0].message.includes('押しにくい') && fake.feedback[0].platform === 'web' && fake.feedback[0].app_version === '1.0.0'), JSON.stringify(fake.feedback));
  check('送ったら入力欄は空に', (await page.inputValue('#feedback-input')) === '');
  await page.click('#settings-back'); await page.waitForTimeout(150);

  state.section = '断られた変更';
  fake.rejectNextLog = true;
  await nav(page, 'record');
  await page.click('#manual-subject-chips .chip[data-id="science"]');
  await page.fill('#manual-minutes', '10'); await page.click('#manual-add');
  await page.fill('#manual-minutes', '20'); await page.click('#manual-add');
  // サーバーに届いた直後は、アプリがまだ送信待ちの列から消していないことがあるので、両方そろうまで待つ
  check('サーバーに断られた変更で、後ろの変更が止まらない', await waitFor(async () => logsOf().some(r => r.seconds === 1200) && await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_sync_queue')).length === 0)));
  await page.screenshot({ path: OUT + 'cloud-record.png' });

  // ========== 投稿をみんなに見せる ==========
  state.section = '投稿（動画）';
  const ASSETS = require('path').join(__dirname, 'assets');
  const postVideo = async (pg, title) => {
    await nav(pg, 'create');
    await pg.setInputFiles('#post-file-input', require('path').join(ASSETS, 'sample.webm'));
    await pg.waitForTimeout(500);
    await pg.fill('#post-title', title);
    await pg.click('#post-grade-chips .chip[data-id="high1"]');
    await pg.click('#post-subject-chips .chip[data-id="math"]');
    await pg.click('#post-next'); await pg.waitForTimeout(300);
    // 進み具合の画面に出た文言を記録しておく（小さい動画だと一瞬で終わるため）
    await pg.evaluate(() => {
      window.__uploadTitles = [];
      new MutationObserver(() => window.__uploadTitles.push(document.getElementById('upload-title').textContent))
        .observe(document.getElementById('upload-overlay'), { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await pg.click('#preview-post'); await pg.click('#confirm-ok');
  };
  const uploadTitles = pg => pg.evaluate(() => window.__uploadTitles.join(' / '));
  await postVideo(page, '二次関数の頂点を一瞬で');
  check('送っている間は進み具合を出す（アップロード→仕上げ）', await waitFor(async () => /アップロードしています.*仕上げています/.test(await uploadTitles(page))), await uploadTitles(page));
  check('投稿がサーバーに保存される（ファイル1つ＋内容）', await waitFor(() => fake.posts.length === 1, 8000), JSON.stringify(fake.posts));
  const vpost = fake.posts[0];
  check('投稿の内容（タイトル・教科・学年・名前・自分のアカウント）', vpost && vpost.title === '二次関数の頂点を一瞬で' && vpost.subject === 'math' && vpost.grade === 'high1' && vpost.creator === 'みなと' && vpost.user_id === uid && vpost.media_type === 'video');
  check('ファイルは自分のフォルダに置く', vpost && vpost.media_paths.length === 1 && vpost.media_paths[0].startsWith(`${uid}/${vpost.id}/0.`) && fake.files.has(vpost.media_paths[0]) && fake.files.get(vpost.media_paths[0]).type.startsWith('video/'));
  const sampleBytes = require('fs').readFileSync(require('path').join(ASSETS, 'sample.webm'));
  check('小さい動画は、元のファイルをそのまま送る（中身が同じ）', !!vpost && fake.files.get(vpost.media_paths[0]).body.equals(sampleBytes), vpost && String(fake.files.get(vpost.media_paths[0]).body.length));
  check('投稿したらホームの先頭に出る', await waitFor(async () => (await active(page)) === 'home-screen' && await page.$eval('#feed .short-slide:first-child', el => el.dataset.id) === (vpost && vpost.id)));
  check('「みんなのフィードに流れます」と伝える', (await toast(page)).includes('みんなのフィード'));
  check('進み具合の画面は消える', !(await page.isVisible('#upload-overlay')));

  // 見本の動画は小さいので、普段の設定ではそのまま送られる。ここでは必ず「軽くする」設定で開く
  state.section = '動画を軽くする';
  const small = await openApp({ zonenow_profile: { name: 'みなと2', grade: 'high1', createdAt: 1 } }, { keepAsIsBytesPerSec: 0 });
  await waitFor(() => fake.users.size === 2);
  const uid2 = [...fake.users.keys()].find(id => id !== uid);
  await postVideo(small.page, '軽くした動画');
  check('軽くしている間は「動画を軽くしています」', await waitFor(async () => /動画を軽くしています.*アップロードしています/.test(await uploadTitles(small.page)), 15000));
  check('軽くした動画が送られる', await waitFor(() => fake.posts.some(r => r.title === '軽くした動画'), 15000));
  const spost = fake.posts.find(r => r.title === '軽くした動画');
  const sfile = spost && fake.files.get(spost.media_paths[0]);
  check('軽くした動画はブラウザで再生できる形式', !!sfile && /^video\/(webm|mp4)$/.test(sfile.type) && sfile.body.length > 0, sfile && sfile.type);
  check('軽くした動画は、自分のフォルダ', !!spost && spost.user_id === uid2 && spost.media_paths[0].startsWith(uid2 + '/'));
  check('エラーなし', !small.errors.length, small.errors.join(' / '));
  await small.context.close();

  state.section = '投稿（写真）';
  await nav(page, 'create');
  await page.setInputFiles('#post-file-input', [require('path').join(ASSETS, 'p1.png'), require('path').join(ASSETS, 'p2.png')]);
  await page.waitForTimeout(300);
  await page.fill('#post-title', '英単語まとめ');
  await page.click('#post-grade-chips .chip[data-id="everyone"]');
  await page.click('#post-next'); await page.waitForTimeout(300);
  await page.click('#preview-post'); await page.click('#confirm-ok');
  check('写真2枚の投稿も保存される', await waitFor(() => fake.posts.some(r => r.title === '英単語まとめ'), 6000));
  const ppost = fake.posts.find(r => r.title === '英単語まとめ');
  check('写真は縮小してJPEGで送る', !!ppost && ppost.media_type === 'image' && ppost.media_paths.length === 2 && ppost.media_paths.every(x => x.endsWith('.jpg') && fake.files.get(x).type === 'image/jpeg'));

  state.section = '送れなかったとき';
  fake.failUpload = true;
  const postsBefore = fake.posts.length;
  await nav(page, 'create');
  await page.setInputFiles('#post-file-input', require('path').join(ASSETS, 'p3.png'));
  await page.waitForTimeout(300);
  await page.fill('#post-title', '送れない投稿');
  await page.click('#post-grade-chips .chip[data-id="everyone"]');
  await page.click('#post-next'); await page.waitForTimeout(300);
  await page.click('#preview-post'); await page.click('#confirm-ok');
  check('送れなかったら伝えて、プレビューに残る', await waitFor(async () => /できませんでした/.test(await toast(page)) && (await active(page)) === 'preview-screen'));
  check('中途半端な投稿は残らない', fake.posts.length === postsBefore);
  check('進み具合の画面は消える', !(await page.isVisible('#upload-overlay')));
  fake.failUpload = false;
  await page.click('#preview-post'); await page.click('#confirm-ok');
  check('電波が戻れば、もう一度押して投稿できる', await waitFor(() => fake.posts.some(r => r.title === '送れない投稿'), 6000));

  state.section = 'ほかの人のフィード';
  const usersBeforeOther = new Set(fake.users.keys());
  const otherUid = () => [...fake.users.keys()].find(id => !usersBeforeOther.has(id));
  const other = await openApp({}, {}, `?v=${vpost.id}`);
  await other.page.fill('#onboarding-name', 'ゆい');
  await other.page.click('#onboarding-grade-chips .chip[data-id="high1"]');
  await other.page.click('#onboarding-submit');
  const op = other.page;
  check('ほかの人にもみんなの投稿が届く', await waitFor(() => op.evaluate(() => VIDEOS.filter(v => v.cloud).length === 4)));
  check('共有リンクの投稿が先頭に出る', await waitFor(() => op.$eval('#feed .short-slide:first-child', el => el.dataset.id).then(id => id === vpost.id)));
  const src = await op.$eval('#feed .short-slide:first-child video', el => el.dataset.src);
  check('動画はサーバーの公開URLから読む', src.startsWith(fake.url + '/storage/v1/object/public/posts/'));
  check('サーバーの動画を再生できる', await op.evaluate(async u => (await fetch(u)).ok, src));
  check('ほかの人の投稿にはフォローボタン', await op.isVisible('#feed .short-slide:first-child [data-role="follow"]'));
  // 先読み：次に出るみんなの投稿の動画は、先頭だけ読んで配信の一時保存に入れておく
  const spostUrl = await op.evaluate(id => VIDEOS.find(v => v.id === id).short, spost.id);
  fake.warmed = [];
  await op.evaluate(url => { WARMED_VIDEOS.clear(); warmVideo(url); warmVideo(url); }, spostUrl); // フィードがもう先読みしていることがあるので、記録を空にしてから
  check('次の動画を先読みする（先頭64KBだけ・同じ動画は1回だけ）', await waitFor(() => fake.warmed.length === 1 && fake.warmed[0] === spost.media_paths[0]), JSON.stringify(fake.warmed));
  fake.warmed = [];
  const ahead = await op.evaluate(() => {
    WARMED_VIDEOS.clear();
    const slides = [...feedEl.children];
    syncFeedMedia(slides[0]);
    return slides.slice(1, 3).map(sl => sl.querySelector('video')).filter(v => v && v.dataset.src.startsWith(SUPABASE_URL)).length;
  });
  check('フィードでは、次の2本までのみんなの動画を先読みする', await waitFor(() => fake.warmed.length === ahead), `${fake.warmed.length}本（${ahead}本のはず）`);
  check('本物の投稿は見本の動画より出やすい', await op.evaluate(() => feedWeight(VIDEOS.find(v => v.cloud), 'high1') > feedWeight(VIDEOS.find(v => !v.cloud && v.grade === 'high1'), 'high1')));

  state.section = 'いいね・保存・コメント';
  const first = '#feed .short-slide:first-child';
  const countOf = (pg, sel, role) => pg.$eval(`${sel} [data-role="${role}"] .action-count`, el => el.textContent);
  await op.click(`${first} [data-role="like"]`);
  check('いいねがサーバーに届く', await waitFor(() => fake.likes.some(r => r.post_id === vpost.id && r.user_id === otherUid())));
  check('いいねの数が1になり、押した状態になる', (await countOf(op, first, 'like')) === '1' && await op.$eval(`${first} [data-role="like"]`, el => el.classList.contains('active')));
  await op.click(`${first} [data-role="bookmark"]`);
  check('保存もサーバーに届き、数が出る', await waitFor(() => fake.saves.some(r => r.post_id === vpost.id)) && (await countOf(op, first, 'bookmark')) === '1');
  check('保存した投稿は、プロフィールの「保存」にも並ぶ', await op.evaluate(id => JSON.parse(localStorage.getItem('zonenow_saves')).includes(id), vpost.id));
  await op.click(`${first} [data-role="comment"]`);
  check('コメント欄を開ける（まだ0件）', await waitFor(async () => (await op.textContent('#comment-sheet-title')) === 'コメント 0件'));
  await op.fill('#comment-input', 'わかりやすい！');
  await op.click('#comment-send');
  check('コメントがサーバーに届く（書いた人の名前つき）', await waitFor(() => fake.comments.some(r => r.post_id === vpost.id && r.body === 'わかりやすい！' && r.author === 'ゆい')));
  check('コメントの数が出て、自分のコメントは削除できる', await waitFor(async () => (await op.textContent('#comment-sheet-title')) === 'コメント 1件') && (await op.$$('#comment-list [data-delete-comment]')).length === 1);
  // 名前を変えても、自分のコメントは消せる（前は名前で見分けていたので消せなかった）
  await op.click('#comment-sheet-close');
  await op.evaluate(() => { const p = JSON.parse(localStorage.getItem('zonenow_profile')); p.name = 'ゆい改'; localStorage.setItem('zonenow_profile', JSON.stringify(p)); });
  await op.click(`${first} [data-role="comment"]`);
  check('名前を変えたあとでも、自分のコメントは削除できる', await waitFor(async () => (await op.$$('#comment-list [data-delete-comment]')).length === 1));
  await op.click('#comment-sheet-close');
  check('コメントの数もフィードに出る', (await countOf(op, first, 'comment')) === '1');

  // 投稿した本人（みなと）の画面：ほかの人のいいね・コメントの数が見える。自分の投稿についたコメントは消せる
  await page.evaluate(() => loadCloudPosts());
  await page.evaluate(id => jumpToShort(id), vpost.id);
  check('投稿した人にも、ほかの人のいいね・保存・コメントの数が見える', await waitFor(async () => (await countOf(page, first, 'like')) === '1' && (await countOf(page, first, 'bookmark')) === '1' && (await countOf(page, first, 'comment')) === '1'));
  check('自分は押していないので、いいねは押した状態にならない', !(await page.$eval(`${first} [data-role="like"]`, el => el.classList.contains('active'))));
  await page.click(`${first} [data-role="comment"]`);
  check('ほかの人のコメントが読める', await waitFor(async () => (await page.textContent('#comment-list')).includes('わかりやすい！')));
  check('自分の投稿についたコメントは消せる', (await page.$$('#comment-list [data-delete-comment]')).length === 1);
  await page.click('#comment-list [data-delete-comment]'); await page.click('#confirm-ok');
  check('消すとサーバーからも消える', await waitFor(() => !fake.comments.some(r => r.post_id === vpost.id)));
  await page.click('#comment-sheet-close');
  await op.click(`${first} [data-role="like"]`);
  check('いいねを取り消すと、サーバーからも消える', await waitFor(() => !fake.likes.some(r => r.post_id === vpost.id)) && (await countOf(op, first, 'like')) === '0');

  state.section = '通報';
  await op.click('#feed .short-slide:first-child [data-role="share"]');
  check('ほかの人の投稿には「通報する」', await op.isVisible('#share-report'));
  await op.click('#share-report');
  check('理由を選ぶ画面が出る', await op.isVisible('#report-sheet .sheet-card'));
  await op.click('#report-reasons [data-reason="spam"]');
  check('通報がサーバーに届く（どの投稿か・理由・誰から）', await waitFor(() => fake.reports.length === 1 && fake.reports[0].post_id === vpost.id && fake.reports[0].reason === 'spam' && fake.reports[0].user_id === otherUid()), JSON.stringify(fake.reports));
  check('通報した投稿はもう出ない', (await toast(op)).includes('通報しました') && !(await op.$$eval('#feed .short-slide', (els, id) => els.some(el => el.dataset.id === id), vpost.id)));
  await op.click('#feed .short-slide:first-child [data-role="share"]');
  const firstCloud = await op.$eval('#feed .short-slide:first-child', el => VIDEOS.find(v => v.id === el.dataset.id).cloud);
  check('見本の動画には「通報する」を出さない', firstCloud || !(await op.isVisible('#share-report')));
  await op.click('#share-sheet-close');

  state.section = 'ユーザー検索';
  await op.click('#search-open-btn'); await op.waitForTimeout(200);
  await op.fill('#search-input', 'みな');
  check('名前の一部で、登録した人が見つかる', await waitFor(async () => (await op.$$eval('#user-results-list .user-row-name', els => els.map(e => e.textContent))).join(',') === 'みなと,みなと2'), await op.textContent('#user-results-list'));
  await op.screenshot({ path: OUT + 'cloud-user-search.png' });
  await op.click('#user-results-list .user-row:first-child [data-follow-key]');
  check('検索結果からフォローできる（アカウントで覚える）', (await op.textContent('#user-results-list .user-row:first-child [data-follow-key]')) === 'フォロー中'
    && await op.evaluate(id => JSON.parse(localStorage.getItem('zonenow_following')).some(e => e.id === id && e.name === 'みなと'), uid));
  await op.click('#user-results-list .user-row:first-child');
  const visiblePosts = fake.posts.filter(r => r.user_id === uid && r.id !== vpost.id).length; // 通報した投稿は出さない
  check('押すと、その人の投稿一覧', await waitFor(async () => (await op.$eval('.screen.active', el => el.id)) === 'user-screen' && (await op.textContent('#user-title')) === 'みなと'
    && (await op.$$('#user-grid .result-card')).length === visiblePosts), `${visiblePosts}件のはず`);
  check('その画面でもフォロー中と分かる', (await op.textContent('#user-follow')) === 'フォロー中');
  await op.waitForTimeout(300);
  await op.screenshot({ path: OUT + 'cloud-user-profile.png' });
  const firstCard = await op.$eval('#user-grid .result-card', el => el.dataset.id);
  await op.click('#user-grid .result-card');
  check('投稿を押すと、その投稿から再生', await waitFor(async () => (await op.$eval('.screen.active', el => el.id)) === 'home-screen' && await op.$eval('#feed .short-slide:first-child', el => el.dataset.id) === firstCard));
  check('フィードでもフォロー中になっている', await op.$eval('#feed .short-slide:first-child [data-role="follow"]', el => el.classList.contains('active')));
  await op.click('#feed .short-slide:first-child .avatar');
  check('フィードのアイコンを押しても、その人の投稿一覧', await waitFor(async () => (await op.$eval('.screen.active', el => el.id)) === 'user-screen' && (await op.textContent('#user-title')) === 'みなと'));
  await op.click('#user-follow');
  check('ユーザー画面でフォローを外せる', (await op.textContent('#user-follow')) === 'フォローする' && await op.evaluate(() => JSON.parse(localStorage.getItem('zonenow_following')).length === 0));
  await op.click('#user-follow');
  await op.click('#user-back'); await op.waitForTimeout(200);
  await op.click('.screen.active [data-nav="profile"]'); await op.waitForTimeout(200);
  await op.click('[data-people-tab="following"]'); await op.waitForTimeout(200);
  check('フォロー中の一覧に出る', (await op.textContent('#people-list')).includes('みなと'));
  await op.click('#people-list .people-row.is-user .people-name');
  check('フォロー中の一覧から、その人の投稿一覧へ', await waitFor(async () => (await op.$eval('.screen.active', el => el.id)) === 'user-screen'));
  await op.click('#user-back'); await op.waitForTimeout(200);
  check('戻ると元の画面（フォロー中の一覧）', (await op.$eval('.screen.active', el => el.id)) === 'people-screen');
  await op.evaluate(() => showScreen('search'));
  await op.fill('#search-input', 'だれもいない名前');
  check('見つからないときはそう伝える', await waitFor(async () => (await op.textContent('#user-results-list')).includes('見つかりませんでした')));
  await op.fill('#search-input', '#数学');
  await op.waitForTimeout(500);
  check('「#」で始まるとき（ハッシュタグ探し）は、ユーザーは探さない', await op.$eval('#user-results', el => el.hidden));
  check('エラーなし', !other.errors.length, other.errors.join(' / '));
  await other.context.close();

  state.section = '自分の投稿を消す';
  await nav(page, 'profile');
  check('プロフィールに自分の投稿（3件）', (await page.textContent('#profile-posts-count')) === '3');
  await page.click(`[data-delete-post="${vpost.id}"]`); await page.click('#confirm-ok');
  check('消すとサーバーの投稿もファイルも消える', await waitFor(() => !fake.posts.some(r => r.id === vpost.id) && !fake.files.has(vpost.media_paths[0])));
  check('ほかの人の投稿・ファイルは残る', !!fake.posts.find(r => r.id === spost.id) && fake.files.has(spost.media_paths[0]));

  // ========== すべて削除（退会） ==========
  state.section = '退会';
  await nav(page, 'profile'); await page.click('#profile-gear'); await page.waitForTimeout(200);
  await page.click('#settings-delete-all');
  check('確認にアカウントの削除も書いてある', (await page.textContent('#confirm-message')).includes('アカウント'));
  await Promise.all([page.waitForNavigation(), page.click('#confirm-ok')]);
  await page.waitForTimeout(400);
  check('サーバーのアカウントとデータも消える', fake.rpcCalls === 1 && !fake.users.has(uid) && !fake.profiles.has(uid) && logsOf().every(r => r.user_id !== uid));
  check('投稿とそのファイルも消える', !fake.posts.some(r => r.user_id === uid) && ![...fake.files.keys()].some(k => k.startsWith(uid + '/')));
  check('最初の登録画面に戻る', (await active(page)) === 'onboarding-screen' && await page.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('zonenow_'))));
  check('エラーなし', !errors.length, errors.join(' / '));
  await context.close();

  // ========== 前から使っていた人 ==========
  state.section = '前から使っていた人';
  const today = new Date(); const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const usersBefore = new Set(fake.users.keys());
  const old = await openApp({
    zonenow_profile: { name: 'さくら', grade: 'junior3', createdAt: 1 },
    zonenow_study_log: [{ id: 'old1', subject: 'japanese', subjectOther: '', seconds: 1500, date: key, source: 'timer', createdAt: 1 }],
  });
  check('登録画面は出さずに使える', (await active(old.page)) === 'home-screen');
  check('自動でアカウントを作り、端末の記録を送る', await waitFor(() => {
    const id = [...fake.users.keys()].find(k => !usersBefore.has(k));
    return id && fake.profiles.get(id) && fake.profiles.get(id).name === 'さくら' && logsOf().some(r => r.id === 'old1' && r.user_id === id);
  }));
  check('エラーなし', !old.errors.length, old.errors.join(' / '));
  await old.context.close();

  // ========== 見本の動画は、サーバーにつながるときは出さない ==========
  state.section = '見本の動画';
  const seedPosts = n => {
    fake.posts = [];
    const owner = [...fake.users.keys()][0];
    fake.files.set(`${owner}/seed/0.jpg`, { type: 'image/jpeg', body: require('fs').readFileSync(require('path').join(ASSETS, 'p1.png')), owner });
    for (let i = 0; i < n; i++) {
      fake.posts.push({ id: crypto.randomUUID(), user_id: owner, creator: 'クリエイター', title: `本物の投稿${i + 1}`, kind: 'lesson', kind_other: '', subject: 'math', subject_other: '',
        grade: 'everyone', grade_other: '', unit: '', hashtags: [], music_id: '', media_type: 'image', media_paths: [`${owner}/seed/0.jpg`], duration: 8,
        created_at: new Date(Date.now() - i * 1000).toISOString() });
    }
  };
  const feedKinds = pg => pg.$$eval('#feed .short-slide', els => els.map(el => VIDEOS.find(v => v.id === el.dataset.id)).map(v => (v.cloud ? 'real' : 'sample')));
  const searchHasSample = pg => pg.evaluate(() => filteredVideos().some(v => !v.cloud && !v.own));
  const profileOf = name => ({ zonenow_profile: { name, grade: 'high1', createdAt: 1 } });
  seedPosts(3);
  const few = await openApp(profileOf('すこし'));
  check('投稿が少なくても、フィードは本物の投稿だけ（開いた直後の1本目も）', await waitFor(async () => { const k = await feedKinds(few.page); return k.length > 0 && k.every(x => x === 'real'); }), (await feedKinds(few.page)).join(','));
  check('検索にも見本は出ない', !(await searchHasSample(few.page)));
  check('動画があるときは案内を出さない', await few.page.$eval('#feed-empty', el => el.hidden));
  check('エラーなし', !few.errors.length, few.errors.join(' / '));
  await few.context.close();

  seedPosts(0);
  const none = await openApp(profileOf('ゼロ'));
  check('投稿が0件なら「まだ見られる動画がありません」（真っ黒にしない）', await waitFor(async () => !(await none.page.$eval('#feed-empty', el => el.hidden)) && (await none.page.textContent('#feed-empty-text')).includes('まだ見られる動画がありません')));
  check('0件でも見本は出ない', (await feedKinds(none.page)).length === 0);
  await none.context.close();

  seedPosts(2);
  fake.offline = true;
  const off = await openApp(profileOf('でんぱなし'));
  check('読み込めないときは「読み込めませんでした」と、もう一度読み込むボタン', await waitFor(async () => (await off.page.textContent('#feed-empty-text')).includes('読み込めませんでした') && await off.page.isVisible('#feed-empty-retry'), 8000));
  fake.offline = false;
  await off.page.click('#feed-empty-retry');
  check('電波が戻って押すと、本物の投稿が出る', await waitFor(async () => { const k = await feedKinds(off.page); return k.length > 0 && k.every(x => x === 'real'); }) && await off.page.$eval('#feed-empty', el => el.hidden));
  await off.context.close();

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

  // ========== claude.ai のプレビューの中 ==========
  state.section = 'プレビュー';
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const realRequests = [];
  await ctx3.route('**/*.supabase.co/**', route => { realRequests.push(route.request().url()); route.abort(); });
  const p3 = await ctx3.newPage();
  // テスト用の「つながない」設定を外し、アプリ本来の設定（本物のSupabase）のまま、プレビューの中として開く
  await p3.addInitScript(() => { delete window.ZONENOW_CONFIG; window.claude = { use: async () => null }; });
  await p3.goto(APP_URL); await p3.waitForTimeout(300);
  check('アプリには本物のSupabaseが設定されている', await p3.evaluate(() => SUPABASE_URL_DEFAULT.endsWith('.supabase.co') && SUPABASE_ANON_KEY_DEFAULT.startsWith('sb_publishable_')));
  await p3.fill('#onboarding-name', 'プレビュー'); await p3.click('#onboarding-grade-chips .chip[data-id="junior1"]'); await p3.click('#onboarding-submit');
  await p3.waitForTimeout(300);
  check('プレビューの中ではサーバーにつながず、そのまま使える', (await active(p3)) === 'home-screen' && realRequests.length === 0, realRequests.join(', '));
  await ctx3.close();

  report();
  fake.close();
  await browser.close();
  server.close();
})();
