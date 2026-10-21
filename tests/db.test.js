// データベース設計（supabase/schema.sql）のテスト：本物のPostgreSQLで「他人のデータを読めない・書けない」を確かめる
// 実行：npm run test:db（psql で接続できるPostgreSQLが必要。PGHOST などの環境変数で接続先を指定できる）
// Supabase のログインの仕組み（auth.uid() と authenticated / anon の役割）を、テスト用に最小限まねして動かす
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createChecker } = require('./helpers');
const { check, state, report } = createChecker();

const DB = process.env.ZONENOW_TEST_DB || 'zonenow_schema_test';
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function psql(sql, db = DB) {
  return execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', db], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
// ユーザーとして実行（user=null は未ログイン）。成功なら { ok:true, out }、エラーなら { ok:false, err }
function as(user, sql) {
  const role = user ? 'authenticated' : 'anon';
  const claim = user ? `set local request.jwt.claim.sub = '${user}';` : '';
  try {
    return { ok: true, out: psql(`begin; set local role ${role}; ${claim} ${sql}; commit;`) };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message) };
  }
}

try {
  psql(`drop database if exists ${DB}; create database ${DB};`, 'postgres');
} catch (e) {
  console.log('PostgreSQLに接続できないので、データベースのテストは行いません：' + String(e.stderr || e.message).split('\n')[0]);
  process.exit(0);
}

// ---- Supabase のまね ----
psql(`
  do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  -- Storage（ファイル置き場）：バケットとファイルの表、フォルダ名を取り出す関数だけ同じ形で用意する
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner uuid default auth.uid(), unique (bucket_id, name));
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language plpgsql as $f$
    declare _parts text[]; begin select string_to_array(name, '/') into _parts; return _parts[1:array_length(_parts, 1) - 1]; end $f$;
  grant usage on schema storage to anon, authenticated;
  grant all on storage.objects to anon, authenticated;
  grant select on storage.buckets to anon, authenticated;
  insert into auth.users values ('${A}'), ('${B}');
`);

state.section = '作成';
let loaded = true;
try { psql(SCHEMA); psql(SCHEMA); } catch (e) { loaded = false; console.log(e.stderr || e.message); }
check('schema.sql を実行できる（2回実行しても大丈夫）', loaded);

state.section = 'プロフィール';
check('自分のプロフィールを作れる', as(A, `insert into profiles (id, name, grade) values ('${A}', 'あおい', 'junior2')`).ok);
check('他人のIDではプロフィールを作れない', !as(A, `insert into profiles (id, name, grade) values ('${B}', 'なりすまし', 'junior2')`).ok);
as(B, `insert into profiles (id, name, grade) values ('${B}', 'ひかる', 'high1')`);
check('自分のプロフィールしか見えない', as(A, 'select name from profiles').out === 'あおい');
const upsert = as(A, `insert into profiles (id, name, grade) values ('${A}', 'あおい2', 'junior3') on conflict (id) do update set name = excluded.name, grade = excluded.grade returning name`);
check('上書き保存（upsert）できる', upsert.ok && upsert.out.startsWith('あおい2'), upsert.err);
check('他人のプロフィールは変えられない', as(A, `update profiles set name = 'x' where id = '${B}' returning id`).out === '');
check('他人のプロフィールは消せない', as(A, `delete from profiles where id = '${B}' returning id`).out === '');
check('名前は20文字まで', !as(A, `update profiles set name = '${'あ'.repeat(21)}' where id = '${A}'`).ok);
check('名前は空にできない', !as(A, `update profiles set name = '' where id = '${A}'`).ok);
const before = psql(`select updated_at from profiles where id = '${A}'`);
as(A, `update profiles set goal_minutes = 60 where id = '${A}'`);
check('更新すると updated_at が変わる', psql(`select updated_at from profiles where id = '${A}'`) !== before);

state.section = '勉強の記録';
const ins = as(A, `insert into study_logs (id, subject, seconds, date, source) values ('abc123', 'math', 1800, '2026-10-19', 'timer')`);
check('自分の記録を追加できる（user_id は自動で自分）', ins.ok && psql(`select user_id from study_logs where id = 'abc123'`) === A, ins.err);
check('他人として記録を追加できない', !as(A, `insert into study_logs (user_id, id, subject, seconds, date) values ('${B}', 'evil1', 'math', 60, '2026-10-19')`).ok);
as(B, `insert into study_logs (id, subject, seconds, date) values ('abc123', 'english', 600, '2026-10-19')`);
check('同じIDでも別のユーザーなら別の記録', psql(`select count(*) from study_logs where id = 'abc123'`) === '2');
check('自分の記録しか見えない', as(A, 'select subject from study_logs').out === 'math');
check('他人の記録は変えられない', as(A, `update study_logs set seconds = 1 where user_id = '${B}' returning id`).out === '');
check('他人の記録は消せない', as(A, `delete from study_logs where user_id = '${B}' returning id`).out === '');
check('自分の記録は消せる', as(A, `delete from study_logs where id = 'abc123' returning id`).out === 'abc123');
check('0秒の記録は入らない', !as(A, `insert into study_logs (id, subject, seconds, date) values ('z1', 'math', 0, '2026-10-19')`).ok);
check('おかしなIDは入らない', !as(A, `insert into study_logs (id, subject, seconds, date) values ('a b;', 'math', 60, '2026-10-19')`).ok);
check('記録の種類は timer / manual だけ', !as(A, `insert into study_logs (id, subject, seconds, date, source) values ('z2', 'math', 60, '2026-10-19', 'hack')`).ok);
check('長い時間（上限なし）も入る', as(A, `insert into study_logs (id, subject, seconds, date) values ('long1', 'math', 200000, '2026-10-19')`).ok);

state.section = 'ご意見';
check('ご意見を送れる（送った人は自動で自分）', as(A, `insert into feedback (message, app_version, platform) values ('使いやすい', '1.0.0', 'ios')`).ok && psql(`select user_id from feedback`) === A);
check('自分が送ったご意見も、アプリからは読めない', as(A, 'select count(*) from feedback').out === '0');
check('他人の名前では送れない', !as(A, `insert into feedback (user_id, message) values ('${B}', 'なりすまし')`).ok);
check('空のご意見は送れない', !as(A, `insert into feedback (message) values ('')`).ok);
check('ログインしていないと送れない', !as(null, `insert into feedback (message) values ('匿名')`).ok);

state.section = '投稿';
// userId を渡すと、その人として投稿しようとする（なりすましの確認用）
const postSql = (paths, userId) => `insert into posts (${userId ? 'user_id, ' : ''}creator, title, grade, media_type, media_paths, duration)
  values (${userId ? `'${userId}', ` : ''}'あおい', '二次関数', 'high1', 'video', array[${paths.map(x => `'${x}'`).join(',')}], 60) returning id`;
const postA = as(A, postSql([`${A}/p1/0.mp4`]));
check('投稿できる（user_id は自動で自分）', postA.ok && psql(`select user_id from posts`) === A, postA.err);
const postId = postA.out.split('\n')[0];
check('他の人の投稿も読める（フィードに流すため）', as(B, 'select title from posts').out === '二次関数');
check('他人の名前では投稿できない', !as(A, postSql([`${B}/x/0.mp4`], B)).ok);
check('他人の投稿は消せない', as(B, `delete from posts where id = '${postId}' returning id`).out === '');
check('他人の投稿は書き換えられない', as(B, `update posts set title = 'のっとり' where id = '${postId}' returning id`).out === '');
check('自分の投稿も書き換えはできない（消して投稿し直す）', as(A, `update posts set title = 'x' where id = '${postId}' returning id`).out === '');
check('タイトルは60文字まで', !as(A, `insert into posts (creator, title, grade, media_type, media_paths, duration) values ('あおい', '${'あ'.repeat(61)}', 'high1', 'video', array['${A}/p/0.mp4'], 60)`).ok);
check('ファイルは10個まで', !as(A, postSql(Array.from({ length: 11 }, (_, i) => `${A}/p/${i}.jpg`))).ok);
check('動画か写真だけ', !as(A, `insert into posts (creator, title, grade, media_type, media_paths, duration) values ('あおい', 't', 'high1', 'gif', array['${A}/p/0.gif'], 5)`).ok);
check('ログインしていないと投稿は見えない', as(null, 'select count(*) from posts').out === '0');

state.section = '通報';
check('他の人の投稿を通報できる', as(B, `insert into reports (post_id, reason) values ('${postId}', 'spam')`).ok);
check('同じ投稿は1人1回だけ', !as(B, `insert into reports (post_id, reason) values ('${postId}', 'spam')`).ok);
check('通報はアプリからは読めない（通報した人にも、された人にも）', as(B, 'select count(*) from reports').out === '0' && as(A, 'select count(*) from reports').out === '0');
check('他人の名前では通報できない', !as(B, `insert into reports (post_id, user_id, reason) values ('${postId}', '${A}', 'x')`).ok);

state.section = '投稿のファイル置き場';
check('posts バケットができる（公開・50MBまで）', psql(`select public, file_size_limit from storage.buckets where id = 'posts'`) === 't|52428800');
check('自分のフォルダにファイルを置ける', as(A, `insert into storage.objects (bucket_id, name) values ('posts', '${A}/p1/0.mp4')`).ok);
check('他人のフォルダには置けない', !as(A, `insert into storage.objects (bucket_id, name) values ('posts', '${B}/evil/0.mp4')`).ok);
check('フォルダの外（いちばん上）には置けない', !as(A, `insert into storage.objects (bucket_id, name) values ('posts', 'top.mp4')`).ok);
check('ほかのバケットには置けない', psql(`insert into storage.buckets (id, name) values ('other', 'other') on conflict do nothing; select 1`) === '1' && !as(A, `insert into storage.objects (bucket_id, name) values ('other', '${A}/x.mp4')`).ok);
check('他人のファイルは消せない', as(B, `delete from storage.objects where name = '${A}/p1/0.mp4' returning name`).out === '');
check('他人のファイルは上書きできない', as(B, `update storage.objects set name = '${B}/x.mp4' where name = '${A}/p1/0.mp4' returning name`).out === '');
check('自分のファイルは消せる', as(A, `delete from storage.objects where name = '${A}/p1/0.mp4' returning name`).out === `${A}/p1/0.mp4`);
check('ログインしていないと置けない', !as(null, `insert into storage.objects (bucket_id, name) values ('posts', '${A}/anon.mp4')`).ok);

state.section = 'ユーザー検索';
// このとき：A＝あおい2、B＝ひかる。わざと % や _ を含む名前も入れて、そのままの文字として探せるか確かめる
const C = '33333333-3333-3333-3333-333333333333', D = '44444444-4444-4444-4444-444444444444';
psql(`insert into auth.users values ('${C}'), ('${D}'); insert into profiles (id, name, grade) values ('${C}', '100%_勉強', 'high3'), ('${D}', 'ひかるん', 'junior1');`);
const found = as(A, `select name from public.search_users('ひかる')`);
check('名前の一部で、ほかの人を探せる', found.ok && found.out.split('\n').join(',') === 'ひかる,ひかるん', found.out || found.err);
check('名前がぴったり同じ人がいちばん上', found.out.split('\n')[0] === 'ひかる');
check('返すのはアカウントIDと名前だけ（学年などは返さない）', as(A, `select * from public.search_users('ひかる') limit 1`).out === `${B}|ひかる`);
check('「%」は何にでも当たる記号ではなく、文字として探す', as(A, `select count(*) from public.search_users('%')`).out === '1' && as(A, `select name from public.search_users('0%_')`).out === '100%_勉強');
check('空の検索では誰も出ない', as(A, `select count(*) from public.search_users('  ')`).out === '0');
check('ログインしていないと検索できない', !as(null, `select * from public.search_users('ひかる')`).ok);
check('プロフィールの表は、今まで通り本人しか読めない', as(A, 'select count(*) from profiles').out === '1');
psql(`delete from auth.users where id in ('${C}', '${D}'); delete from profiles where id in ('${C}', '${D}');`);

state.section = '未ログイン';
check('ログインしていないと何も見えない', as(null, 'select count(*) from profiles').out === '0' && as(null, 'select count(*) from study_logs').out === '0');
check('ログインしていないと書き込めない', !as(null, `insert into study_logs (user_id, id, subject, seconds, date) values ('${A}', 'anon1', 'math', 60, '2026-10-19')`).ok);

state.section = '退会';
check('ログインしていないと退会の関数は使えない', !as(null, 'select public.delete_my_account()').ok);
check('退会できる', as(A, 'select public.delete_my_account()').ok);
check('退会すると自分のアカウントとデータが消える', psql(`select count(*) from auth.users where id = '${A}'`) === '0'
  && psql(`select count(*) from feedback where user_id = '${A}'`) === '0' && psql(`select count(*) from posts where user_id = '${A}'`) === '0'
  && psql(`select count(*) from reports`) === '0'
  && psql(`select count(*) from profiles where id = '${A}'`) === '0' && psql(`select count(*) from study_logs where user_id = '${A}'`) === '0');
check('他の人のアカウントとデータは残る', psql(`select count(*) from auth.users where id = '${B}'`) === '1' && psql(`select count(*) from study_logs where user_id = '${B}'`) === '1');

psql(`drop database if exists ${DB};`, 'postgres');
report();
