-- ゾーンNOW のデータベース（Supabase / PostgreSQL）
-- 使い方：Supabase の「SQL Editor」にこのファイルの中身を全部貼り付けて「Run」。何度実行しても大丈夫
-- （消す命令を含まないので、確認の画面は出ずにそのまま実行される）
--
-- 守り方：Row Level Security（行ごとの権限）で「自分のデータだけ読み書きできる」をDBが強制する。
-- アプリ側にバグがあっても、他人のデータは読めないし書き換えられない。
-- 友達機能を作るときに「友達の勉強時間は読める」ルールを足す。
-- 例外は投稿（posts）：みんなのフィードに流すため、ログインしている人は全員の投稿を読める。作る・消すは自分の分だけ。
-- また、ユーザー検索（search_users）では、ログインしている人が全員の「名前」で探せる（学年などは見えない）。
-- いいね・保存は、だれが押したかは本人だけが見え、数だけを post_stats で全員が見られる。コメントは全員が読める。

-- ---- プロフィール（ログインしたユーザー1人につき1行） ----
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 20),
  grade        text not null check (char_length(grade) between 1 and 20),
  grade_other  text not null default '' check (char_length(grade_other) <= 20),
  goal_minutes integer not null default 0 check (goal_minutes between 0 and 1440),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---- 勉強の記録（タイマー・手入力の1回ごとに1行） ----
-- id はアプリが端末で作るID。ユーザーごとに重ならなければよい
create table if not exists public.study_logs (
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id            text not null check (id ~ '^[A-Za-z0-9]{1,40}$'),
  subject       text not null default '' check (char_length(subject) <= 20),
  subject_other text not null default '' check (char_length(subject_other) <= 40),
  seconds       integer not null check (seconds > 0),
  date          date not null,
  source        text not null default 'manual' check (source in ('timer', 'manual')),
  created_at    timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists study_logs_user_date on public.study_logs (user_id, date);

-- ---- ご意見・不具合（アプリの設定画面から送られる） ----
-- 送るだけで、アプリからは読めない。運営は Supabase の Table Editor で読む
create table if not exists public.feedback (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  message     text not null check (char_length(message) between 1 and 1000),
  app_version text not null default '' check (char_length(app_version) <= 20),
  platform    text not null default '' check (platform in ('', 'web', 'ios')),
  created_at  timestamptz not null default now()
);

-- ---- 投稿（動画1本か写真1〜10枚。ファイル本体は Storage の posts バケットに置き、ここには置き場所だけ書く） ----
-- media_paths は「<user_id>/<投稿id>/<番号>.<拡張子>」。名前は投稿した時点のものを持っておく（フィードで毎回引かなくて済むように）
create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  creator       text not null check (char_length(creator) between 1 and 20),
  title         text not null check (char_length(title) between 1 and 60),
  kind          text not null default 'lesson' check (char_length(kind) between 1 and 20),
  kind_other    text not null default '' check (char_length(kind_other) <= 40),
  subject       text not null default '' check (char_length(subject) <= 20),
  subject_other text not null default '' check (char_length(subject_other) <= 40),
  grade         text not null check (char_length(grade) between 1 and 20),
  grade_other   text not null default '' check (char_length(grade_other) <= 40),
  unit          text not null default '' check (char_length(unit) <= 20),
  hashtags      text[] not null default '{}' check (cardinality(hashtags) <= 5),
  music_id      text not null default '' check (char_length(music_id) <= 40),
  media_type    text not null check (media_type in ('video', 'image')),
  media_paths   text[] not null check (cardinality(media_paths) between 1 and 10),
  duration      integer not null check (duration between 1 and 200),
  created_at    timestamptz not null default now()
);
create index if not exists posts_created_at on public.posts (created_at desc);
-- ターゲット学年は複数選べる（2026年11月から）。grade は前の版のアプリのために残す（代表の1つ：全学年を含むなら everyone、それ以外は最初の学年）
-- すでに posts がある場合も、この1行だけ実行すれば列が増える（何度実行しても大丈夫）
alter table public.posts add column if not exists grades text[] not null default '{}' check (cardinality(grades) <= 8);

-- ---- 通報（フィードの「…」から。アプリからは読めない。運営は Table Editor で読み、必要なら投稿を消す） ----
create table if not exists public.reports (
  id         bigint generated always as identity primary key,
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reason     text not null check (char_length(reason) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

-- ---- いいね・保存（みんなの投稿だけ。だれが押したかは本人にしか見えない。数は post_stats で全員が見られる） ----
create table if not exists public.likes (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table if not exists public.saves (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- ---- コメント（みんなの投稿だけ。ログインしている人は全員読める。消せるのは書いた本人と、投稿した人） ----
-- author は書いた時点の名前（あとで名前を変えても、コメントの名前はそのまま）
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author     text not null check (char_length(author) between 1 and 20),
  body       text not null check (char_length(btrim(body)) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists comments_post on public.comments (post_id, created_at);

-- ---- 行ごとの権限：自分の行だけ ----
alter table public.profiles   enable row level security;
alter table public.study_logs enable row level security;
alter table public.feedback   enable row level security;
alter table public.posts      enable row level security;
alter table public.reports    enable row level security;
alter table public.likes      enable row level security;
alter table public.saves      enable row level security;
alter table public.comments   enable row level security;

-- （すでにあるルールはそのまま。何度実行しても同じ結果になる）
do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles: 自分だけ読む') then
    create policy "profiles: 自分だけ読む" on public.profiles for select to authenticated using (id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles: 自分だけ作る') then
    create policy "profiles: 自分だけ作る" on public.profiles for insert to authenticated with check (id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles: 自分だけ変える') then
    create policy "profiles: 自分だけ変える" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles: 自分だけ消す') then
    create policy "profiles: 自分だけ消す" on public.profiles for delete to authenticated using (id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'study_logs' and policyname = 'study_logs: 自分だけ読む') then
    create policy "study_logs: 自分だけ読む" on public.study_logs for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'study_logs' and policyname = 'study_logs: 自分だけ作る') then
    create policy "study_logs: 自分だけ作る" on public.study_logs for insert to authenticated with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'study_logs' and policyname = 'study_logs: 自分だけ変える') then
    create policy "study_logs: 自分だけ変える" on public.study_logs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'feedback' and policyname = 'feedback: 自分の名前で送るだけ') then
    create policy "feedback: 自分の名前で送るだけ" on public.feedback for insert to authenticated with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'study_logs' and policyname = 'study_logs: 自分だけ消す') then
    create policy "study_logs: 自分だけ消す" on public.study_logs for delete to authenticated using (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'posts' and policyname = 'posts: ログインしていれば読める') then
    create policy "posts: ログインしていれば読める" on public.posts for select to authenticated using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'posts' and policyname = 'posts: 自分の名前で投稿する') then
    create policy "posts: 自分の名前で投稿する" on public.posts for insert to authenticated with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'posts' and policyname = 'posts: 自分の投稿だけ消す') then
    create policy "posts: 自分の投稿だけ消す" on public.posts for delete to authenticated using (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'reports: 自分の名前で送るだけ') then
    create policy "reports: 自分の名前で送るだけ" on public.reports for insert to authenticated with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'likes' and policyname = 'likes: 自分の分だけ') then
    create policy "likes: 自分の分だけ" on public.likes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'saves' and policyname = 'saves: 自分の分だけ') then
    create policy "saves: 自分の分だけ" on public.saves for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'comments' and policyname = 'comments: ログインしていれば読める') then
    create policy "comments: ログインしていれば読める" on public.comments for select to authenticated using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'comments' and policyname = 'comments: 自分の名前で書く') then
    create policy "comments: 自分の名前で書く" on public.comments for insert to authenticated with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'comments' and policyname = 'comments: 書いた人と投稿した人が消せる') then
    create policy "comments: 書いた人と投稿した人が消せる" on public.comments for delete to authenticated
      using (user_id = auth.uid() or exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid()));
  end if;
end $$;

-- ---- 投稿のファイル置き場（Storage の posts バケット） ----
-- 公開バケット：URLを知っていれば誰でも見られる（動画を <video> でそのまま流すため）。ファイル名はランダムなIDなので推測はできない
-- 1ファイル50MBまで（Supabase 無料プランの上限）。置ける・消せるのは自分のフォルダ（<user_id>/…）だけ。上書きはできない
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('posts', 'posts', true, 52428800, array['video/*', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

do $$ begin
  if not exists (select from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'posts: 自分のフォルダに置く') then
    create policy "posts: 自分のフォルダに置く" on storage.objects for insert to authenticated
      with check (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'posts: 自分のフォルダを見る') then
    create policy "posts: 自分のフォルダを見る" on storage.objects for select to authenticated
      using (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'posts: 自分のフォルダから消す') then
    create policy "posts: 自分のフォルダから消す" on storage.objects for delete to authenticated
      using (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;

-- ---- updated_at を自動で更新 ----
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create or replace trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---- 投稿ごとの数（いいね・保存・コメント）と、自分が押したか（一度に100件まで） ----
create or replace function public.post_stats(ids uuid[]) returns table (post_id uuid, likes bigint, saves bigint, comments bigint, liked boolean, saved boolean)
language sql stable security definer set search_path = '' as $$
  select p.id,
    (select count(*) from public.likes l where l.post_id = p.id),
    (select count(*) from public.saves s where s.post_id = p.id),
    (select count(*) from public.comments c where c.post_id = p.id),
    exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()),
    exists (select 1 from public.saves s where s.post_id = p.id and s.user_id = auth.uid())
  from public.posts p
  where auth.uid() is not null and p.id = any (ids[1:100]);
$$;
revoke all on function public.post_stats(uuid[]) from public, anon;
grant execute on function public.post_stats(uuid[]) to authenticated;

-- ---- ユーザー検索：名前の一部で探す（ログインしている人だけ） ----
-- プロフィールの表は本人しか読めないままにして、この関数だけが「アカウントIDと名前」を返す（学年などは返さない）
-- 名前に含まれる % や _ は、そのままの文字として探す。一度に返すのは20人まで
create or replace function public.search_users(q text) returns table (id uuid, name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name
  from public.profiles p
  where auth.uid() is not null
    and char_length(btrim(q)) between 1 and 20
    and p.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by (p.name = btrim(q)) desc, char_length(p.name), p.name
  limit 20;
$$;
revoke all on function public.search_users(text) from public, anon;
grant execute on function public.search_users(text) to authenticated;

-- ---- 退会：自分のアカウントを消す（プロフィール・記録・投稿も一緒に消える） ----
-- アプリの「すべてのデータを削除」から呼ぶ。消せるのは呼んだ本人のアカウントだけ
-- （投稿のファイル本体は Storage にあるので、アプリがこれを呼ぶ前に自分のフォルダを消しておく）
create or replace function public.delete_my_account() returns void
language sql security definer set search_path = '' as $$
  delete from auth.users where id = auth.uid();
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---- 使い方の記録（運営が「どう使われているか」を知るため。アプリを開いてから閉じるまでを1行） ----
-- アプリからは送るだけで、読めない（自分の分も）。運営は Supabase の Table Editor で読む（CSVにも書き出せる）
-- name は送った時点の名前（あとで名前を変えても、そのまま）。退会するとその人の記録も消える
create table if not exists public.usage_logs (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name           text not null default '' check (char_length(name) <= 20),
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  narrative      text not null check (char_length(narrative) <= 8000),
  videos_watched integer not null default 0 check (videos_watched between 0 and 100000),
  study_seconds  integer not null default 0 check (study_seconds between 0 and 86400),
  app_version    text not null default '' check (char_length(app_version) <= 20),
  platform       text not null default '' check (char_length(platform) <= 20),
  created_at     timestamptz not null default now()
);
create index if not exists usage_logs_started on public.usage_logs (started_at desc);
alter table public.usage_logs enable row level security;

-- ---- フォロー（だれがだれをフォローしているか。通知を送るために使う） ----
-- 自分のフォローだけ読み書きできる（だれにフォローされているかは、通知でだけ分かる）
create table if not exists public.follows (
  follower_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
alter table public.follows enable row level security;

-- ---- 通知（ほかの人からのいいね・コメント・フォロー。DBが自動で作る） ----
-- アプリから作ることはできない（下のトリガーだけが作る）。読めるのは受け取った本人だけ
-- いいね・フォローは、同じ人から同じものに何度押されても1回だけ通知する
create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  actor_id   uuid references auth.users(id) on delete cascade,
  actor_name text not null default '',
  type       text not null check (type in ('like', 'comment', 'follow')),
  post_id    uuid references public.posts(id) on delete cascade,
  post_title text not null default '',
  body       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists notifications_user on public.notifications (user_id, created_at desc);
create unique index if not exists notifications_like_once on public.notifications (user_id, actor_id, post_id) where type = 'like';
create unique index if not exists notifications_follow_once on public.notifications (user_id, actor_id) where type = 'follow';
alter table public.notifications enable row level security;

do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'usage_logs' and policyname = 'usage_logs: 自分の名前で送るだけ') then
    create policy "usage_logs: 自分の名前で送るだけ" on public.usage_logs for insert to authenticated with check (user_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'follows' and policyname = 'follows: 自分の分だけ') then
    create policy "follows: 自分の分だけ" on public.follows for all to authenticated using (follower_id = auth.uid()) with check (follower_id = auth.uid());
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications: 自分あてだけ読む') then
    create policy "notifications: 自分あてだけ読む" on public.notifications for select to authenticated using (user_id = auth.uid());
  end if;
end $$;

-- 通知を作るトリガー（自分で自分の投稿にいいね・コメントしたときは作らない）
create or replace function public.notify_like() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner uuid; title text;
begin
  select p.user_id, p.title into owner, title from public.posts p where p.id = new.post_id;
  if owner is not null and owner <> new.user_id then
    insert into public.notifications (user_id, actor_id, actor_name, type, post_id, post_title)
    values (owner, new.user_id, coalesce((select pr.name from public.profiles pr where pr.id = new.user_id), ''), 'like', new.post_id, title)
    on conflict do nothing;
  end if;
  return new;
end $$;
create or replace trigger likes_notify after insert on public.likes
  for each row execute function public.notify_like();

create or replace function public.notify_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner uuid; title text;
begin
  select p.user_id, p.title into owner, title from public.posts p where p.id = new.post_id;
  if owner is not null and owner <> new.user_id then
    insert into public.notifications (user_id, actor_id, actor_name, type, post_id, post_title, body)
    values (owner, new.user_id, new.author, 'comment', new.post_id, title, left(new.body, 60));
  end if;
  return new;
end $$;
create or replace trigger comments_notify after insert on public.comments
  for each row execute function public.notify_comment();

create or replace function public.notify_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, actor_id, actor_name, type)
  values (new.followee_id, new.follower_id, coalesce((select pr.name from public.profiles pr where pr.id = new.follower_id), ''), 'follow')
  on conflict do nothing;
  return new;
end $$;
create or replace trigger follows_notify after insert on public.follows
  for each row execute function public.notify_follow();

revoke all on function public.notify_like() from public, anon, authenticated;
revoke all on function public.notify_comment() from public, anon, authenticated;
revoke all on function public.notify_follow() from public, anon, authenticated;

-- ---- タグの直し（2026年11月）：名前の空白で分かれてしまったタグ・絵文字の残りが付いたタグ ----
-- 何度実行しても同じ結果になる（直すものがなければ何もしない）
update public.posts set hashtags = array['OneCardEnglish'] where hashtags = array['One', 'Card', 'English'];
update public.posts
  set hashtags = array(
    select regexp_replace(t, '^[' || chr(65038) || chr(65039) || chr(8419) || chr(8203) || chr(8204) || chr(8205) || chr(8288) || chr(65279) || ']+', '')
    from unnest(hashtags) with ordinality as u(t, i) order by i)
  where exists (select 1 from unnest(hashtags) t where t ~ ('^[' || chr(65038) || chr(65039) || chr(8419) || chr(8203) || chr(8204) || chr(8205) || chr(8288) || chr(65279) || ']'));
