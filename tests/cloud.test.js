// アカウント（名前だけ登録）とサーバー保存のテスト（実行：npm test）
// 本物のSupabaseの代わりに、同じ形で答える「にせSupabase」をローカルで動かし、アプリのSupabaseライブラリ（vendor/supabase.js）をそのまま使う
const http = require('http');
const crypto = require('crypto');
const { OUT, APP_URL, startServer, launchBrowser, createChecker } = require('./helpers');
const { check, state, report } = createChecker();

// ---- にせSupabase（ログイン：GoTrue、データ：PostgREST の必要なところだけ） ----
function startFakeSupabase() {
  const fake = { users: new Map(), profiles: new Map(), logs: new Map(), feedback: [], signups: 0, offline: false, rejectNextLog: false, rpcCalls: 0,
    posts: [], files: new Map(), reports: [], failUpload: false };
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
      fake.posts = fake.posts.filter(r => !(r.id === id && r.user_id === uid));
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
    if (p === '/rest/v1/rpc/delete_my_account' && req.method === 'POST') {
      fake.rpcCalls++;
      fake.users.delete(uid); fake.profiles.delete(uid);
      fake.posts = fake.posts.filter(r => r.user_id !== uid);
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
  check('サーバーに断られた変更で、後ろの変更が止まらない', await waitFor(() => logsOf().some(r => r.seconds === 1200)) && await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_sync_queue')).length === 0));
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
  check('本物の投稿は見本の動画より出やすい', await op.evaluate(() => feedWeight(VIDEOS.find(v => v.cloud), 'high1') > feedWeight(VIDEOS.find(v => !v.cloud && v.grade === 'high1'), 'high1')));

  state.section = '通報';
  await op.click('#feed .short-slide:first-child [data-role="share"]');
  check('ほかの人の投稿には「通報する」', await op.isVisible('#share-report'));
  await op.click('#share-report');
  check('理由を選ぶ画面が出る', await op.isVisible('#report-sheet .sheet-card'));
  await op.click('#report-reasons [data-reason="spam"]');
  const otherUid = [...fake.users.keys()].find(id => id !== uid && id !== uid2);
  check('通報がサーバーに届く（どの投稿か・理由・誰から）', await waitFor(() => fake.reports.length === 1 && fake.reports[0].post_id === vpost.id && fake.reports[0].reason === 'spam' && fake.reports[0].user_id === otherUid), JSON.stringify(fake.reports));
  check('通報した投稿はもう出ない', (await toast(op)).includes('通報しました') && !(await op.$$eval('#feed .short-slide', (els, id) => els.some(el => el.dataset.id === id), vpost.id)));
  await op.click('#feed .short-slide:first-child [data-role="share"]');
  const firstCloud = await op.$eval('#feed .short-slide:first-child', el => VIDEOS.find(v => v.id === el.dataset.id).cloud);
  check('見本の動画には「通報する」を出さない', firstCloud || !(await op.isVisible('#share-report')));
  await op.click('#share-sheet-close');
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
