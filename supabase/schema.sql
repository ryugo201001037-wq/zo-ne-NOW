-- ゾーンNOW のデータベース（Supabase / PostgreSQL）
-- 使い方：Supabase の「SQL Editor」にこのファイルの中身を全部貼り付けて「Run」。何度実行しても大丈夫
-- （消す命令を含まないので、確認の画面は出ずにそのまま実行される）
--
-- 守り方：Row Level Security（行ごとの権限）で「自分のデータだけ読み書きできる」をDBが強制する。
-- アプリ側にバグがあっても、他人のデータは読めないし書き換えられない。
-- 友達機能を作るときに「友達の勉強時間は読める」ルールを足す。
-- 例外は投稿（posts）：みんなのフィードに流すため、ログインしている人は全員の投稿を読める。作る・消すは自分の分だけ。
-- また、ユーザー検索（search_users）では、ログインしている人が全員の「名前」で探せる（学年などは見えない）。

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

-- ---- 通報（フィードの「…」から。アプリからは読めない。運営は Table Editor で読み、必要なら投稿を消す） ----
create table if not exists public.reports (
  id         bigint generated always as identity primary key,
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reason     text not null check (char_length(reason) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

-- ---- 行ごとの権限：自分の行だけ ----
alter table public.profiles   enable row level security;
alter table public.study_logs enable row level security;
alter table public.feedback   enable row level security;
alter table public.posts      enable row level security;
alter table public.reports    enable row level security;

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
