// 本物のSupabaseでの確認（npm test には含めない。手で実行する：npm run check:live）
// 確認用のアカウントを2つ作り、「自分のデータは読み書きできる・他人のデータは読めない書けない・投稿はみんなが読める・退会で消える」を確かめ、
// 最後に確認用アカウントを消す。接続先は index.html に書いてある本番の設定
// ※ プロキシ経由の環境では NODE_USE_ENV_PROXY=1 を付けて実行する
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { createChecker } = require('./helpers');
const { check, state, report } = createChecker();

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const URL_ = (/const SUPABASE_URL_DEFAULT = '([^']*)'/.exec(html) || [])[1];
const KEY = (/const SUPABASE_ANON_KEY_DEFAULT = '([^']*)'/.exec(html) || [])[1];
const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const today = new Date().toISOString().slice(0, 10);

(async () => {
  if (!URL_ || !KEY) { console.log('index.html にSupabaseの設定がありません'); process.exit(1); }
  const a = client(), b = client(), guest = client();
  const created = [];
  try {
    state.section = '登録';
    const ra = await a.auth.signInAnonymously();
    const rb = await b.auth.signInAnonymously();
    check('名前だけ登録（匿名ログイン）ができる', !ra.error && !rb.error, (ra.error || rb.error || {}).message);
    const A = ra.data.user && ra.data.user.id, B = rb.data.user && rb.data.user.id;
    if (A) created.push(a); if (B) created.push(b);
    check('登録した人は「名前だけ（匿名）」の扱い', ra.data.user && ra.data.user.is_anonymous === true);

    state.section = '自分のデータ';
    const pa = await a.from('profiles').upsert({ id: A, name: '確認用A', grade: 'junior2', grade_other: '', goal_minutes: 60 });
    check('自分のプロフィールを保存できる', !pa.error, pa.error && pa.error.message);
    await b.from('profiles').upsert({ id: B, name: '確認用B', grade: 'high1', grade_other: '', goal_minutes: 0 });
    const la = await a.from('study_logs').upsert([
      { user_id: A, id: 'live1', subject: 'math', subject_other: '', seconds: 1800, date: today, source: 'timer' },
      { user_id: A, id: 'live2', subject: 'other', subject_other: '情報', seconds: 600, date: today, source: 'manual' },
    ]);
    check('自分の記録を保存できる', !la.error, la.error && la.error.message);
    await b.from('study_logs').upsert([{ user_id: B, id: 'live1', subject: 'english', subject_other: '', seconds: 900, date: today, source: 'manual' }]);
    const myLogs = await a.from('study_logs').select('id, seconds').order('id');
    check('自分の記録を読める（自分の分だけ）', !myLogs.error && myLogs.data.length === 2 && myLogs.data[0].seconds === 1800, JSON.stringify(myLogs.data || myLogs.error));
    const upd = await a.from('profiles').update({ goal_minutes: 90 }).eq('id', A).select('goal_minutes');
    check('自分のプロフィールを変えられる', !upd.error && upd.data[0].goal_minutes === 90);

    state.section = '他人のデータ';
    const bp = await b.from('profiles').select('id, name');
    check('他人のプロフィールは見えない', !bp.error && bp.data.length === 1 && bp.data[0].id === B, JSON.stringify(bp.data));
    const bl = await b.from('study_logs').select('user_id, id');
    check('他人の記録は見えない', !bl.error && bl.data.every(r => r.user_id === B), JSON.stringify(bl.data));
    const evilUpd = await b.from('study_logs').update({ seconds: 1 }).eq('user_id', A).select();
    check('他人の記録は書き換えられない', !evilUpd.error && evilUpd.data.length === 0);
    const evilDel = await b.from('study_logs').delete().eq('user_id', A).select();
    check('他人の記録は消せない', !evilDel.error && evilDel.data.length === 0);
    const evilIns = await b.from('study_logs').insert({ user_id: A, id: 'evil1', subject: 'math', seconds: 60, date: today });
    check('他人になりすまして記録を足せない', !!evilIns.error);
    const evilProfile = await b.from('profiles').upsert({ id: A, name: 'のっとり', grade: 'junior1' });
    check('他人のプロフィールを乗っ取れない', !!evilProfile.error);
    const stillA = await a.from('study_logs').select('seconds').eq('id', 'live1');
    check('Aの記録はそのまま', stillA.data && stillA.data[0].seconds === 1800);

    state.section = 'ご意見';
    const fb = await a.from('feedback').insert({ message: '確認用のご意見（自動で消えます）', app_version: 'check', platform: 'web' });
    check('ご意見を送れる（supabase/schema.sql の feedback を実行済みか）', !fb.error, fb.error && fb.error.message);
    const fbRead = await a.from('feedback').select('id');
    check('ご意見はアプリからは読めない', !fbRead.error && fbRead.data.length === 0, JSON.stringify(fbRead.data || fbRead.error));

    state.section = '投稿';
    const pid = crypto.randomUUID();
    const path_ = `${A}/${pid}/0.jpg`;
    const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z', 'base64');
    const up = await a.storage.from('posts').upload(path_, jpg, { contentType: 'image/jpeg' });
    check('自分のフォルダにファイルを置ける（supabase/schema.sql の Storage 部分を実行済みか）', !up.error, up.error && up.error.message);
    created.files = [path_];
    const pub = await fetch(`${URL_}/storage/v1/object/public/posts/${path_}`);
    check('置いたファイルは公開URLで見られる', pub.ok, String(pub.status));
    const evilUp = await b.storage.from('posts').upload(`${A}/${pid}/1.jpg`, jpg, { contentType: 'image/jpeg' });
    check('他人のフォルダには置けない', !!evilUp.error);
    const overwrite = await b.storage.from('posts').upload(path_, jpg, { contentType: 'image/jpeg', upsert: true });
    check('他人のファイルは上書きできない', !!overwrite.error);
    await b.storage.from('posts').remove([path_]);
    // 配信の一時保存（CDN）を通さずに確かめる（毎回ちがうURLにする）
    const stillThere = await fetch(`${URL_}/storage/v1/object/public/posts/${path_}?check=${Date.now()}`);
    check('他人のファイルは消せない', stillThere.ok);
    const badType = await a.storage.from('posts').upload(`${A}/${pid}/x.html`, Buffer.from('<script>alert(1)</script>'), { contentType: 'text/html' });
    check('動画・写真以外のファイルは置けない', !!badType.error);
    if (!badType.error) created.files.push(`${A}/${pid}/x.html`);
    const post = await a.from('posts').insert({ id: pid, creator: '確認用A', title: '確認用の投稿', grade: 'high1', media_type: 'image', media_paths: [path_], duration: 8 });
    check('投稿できる', !post.error, post.error && post.error.message);
    const seen = await b.from('posts').select('id, title').eq('id', pid);
    check('他の人の投稿も読める', !seen.error && seen.data.length === 1, JSON.stringify(seen.data || seen.error));
    const evilPostDel = await b.from('posts').delete().eq('id', pid).select();
    check('他人の投稿は消せない', !evilPostDel.error && evilPostDel.data.length === 0);
    const rep = await b.from('reports').insert({ post_id: pid, reason: 'spam' });
    check('通報できる', !rep.error, rep.error && rep.error.message);
    const repRead = await b.from('reports').select('id');
    check('通報はアプリからは読めない', !repRead.error && repRead.data.length === 0);
    const gpost = await guest.from('posts').select('id');
    check('ログインしていないと投稿は見えない', (gpost.data || []).length === 0);
    const myDel = await a.from('posts').delete().eq('id', pid).select();
    const fileDel = await a.storage.from('posts').remove(created.files);
    check('自分の投稿とファイルは消せる', !myDel.error && myDel.data.length === 1 && !fileDel.error && fileDel.data.length === created.files.length, JSON.stringify(fileDel.error || fileDel.data));
    if (!fileDel.error) created.files = [];
    const afterDel = await fetch(`${URL_}/storage/v1/object/public/posts/${path_}?check=${Date.now()}`);
    check('消したファイルはもう見られない', !afterDel.ok, String(afterDel.status));

    state.section = 'ユーザー検索';
    const su = await b.rpc('search_users', { q: '確認用A' });
    check('名前で、ほかの人を探せる（supabase/schema.sql の search_users を実行済みか）', !su.error && su.data.some(r => r.id === A && r.name === '確認用A'), su.error && su.error.message);
    check('検索で見えるのは、アカウントIDと名前だけ', !su.error && su.data.every(r => Object.keys(r).sort().join(',') === 'id,name'));
    const sg = await guest.rpc('search_users', { q: '確認用' });
    check('ログインしていないと検索できない', !!sg.error || (sg.data || []).length === 0);

    state.section = 'ログインしていない人';
    const gp = await guest.from('profiles').select('id');
    const gl = await guest.from('study_logs').select('id');
    check('ログインしていないと何も見えない', (gp.data || []).length === 0 && (gl.data || []).length === 0);
    const gi = await guest.from('study_logs').insert({ user_id: A, id: 'guest1', subject: 'math', seconds: 60, date: today });
    check('ログインしていないと書き込めない', !!gi.error);

    state.section = '値のチェック';
    const bad = await a.from('study_logs').insert({ user_id: A, id: 'bad id!', subject: 'math', seconds: 0, date: today });
    check('おかしな値は入らない', !!bad.error);

    state.section = '退会';
    const del = await a.rpc('delete_my_account');
    check('退会できる', !del.error, del.error && del.error.message);
    created.splice(created.indexOf(a), 1);
    const afterA = await b.from('study_logs').select('id');
    check('退会しても他の人のデータは残る', afterA.data && afterA.data.length === 1);
  } catch (e) {
    check('途中でエラー', false, e.message);
  } finally {
    // 確認用のファイルとアカウントを消す（残っていたら）
    if (created.files && created.files.length) { try { await a.storage.from('posts').remove(created.files); } catch (e) {} }
    for (const c of created) { try { await c.rpc('delete_my_account'); } catch (e) {} }
  }
  report();
})();
