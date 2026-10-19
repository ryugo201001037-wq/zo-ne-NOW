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

state.section = '未ログイン';
check('ログインしていないと何も見えない', as(null, 'select count(*) from profiles').out === '0' && as(null, 'select count(*) from study_logs').out === '0');
check('ログインしていないと書き込めない', !as(null, `insert into study_logs (user_id, id, subject, seconds, date) values ('${A}', 'anon1', 'math', 60, '2026-10-19')`).ok);

state.section = '退会';
check('ログインしていないと退会の関数は使えない', !as(null, 'select public.delete_my_account()').ok);
check('退会できる', as(A, 'select public.delete_my_account()').ok);
check('退会すると自分のアカウントとデータが消える', psql(`select count(*) from auth.users where id = '${A}'`) === '0'
  && psql(`select count(*) from profiles where id = '${A}'`) === '0' && psql(`select count(*) from study_logs where user_id = '${A}'`) === '0');
check('他の人のアカウントとデータは残る', psql(`select count(*) from auth.users where id = '${B}'`) === '1' && psql(`select count(*) from study_logs where user_id = '${B}'`) === '1');

psql(`drop database if exists ${DB};`, 'postgres');
report();
