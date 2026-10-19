-- ゾーンNOW のデータベース（Supabase / PostgreSQL）
-- 使い方：Supabase の「SQL Editor」にこのファイルの中身を貼り付けて「Run」。何度実行しても大丈夫
--
-- 守り方：Row Level Security（行ごとの権限）で「自分のデータだけ読み書きできる」をDBが強制する。
-- アプリ側にバグがあっても、他人のデータは読めないし書き換えられない。
-- 友達機能を作るときに「友達の勉強時間は読める」ルールを足す。

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

-- ---- 行ごとの権限：自分の行だけ ----
alter table public.profiles   enable row level security;
alter table public.study_logs enable row level security;

drop policy if exists "profiles: 自分だけ読む"   on public.profiles;
drop policy if exists "profiles: 自分だけ作る"   on public.profiles;
drop policy if exists "profiles: 自分だけ変える" on public.profiles;
drop policy if exists "profiles: 自分だけ消す"   on public.profiles;
create policy "profiles: 自分だけ読む"   on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles: 自分だけ作る"   on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles: 自分だけ変える" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles: 自分だけ消す"   on public.profiles for delete to authenticated using (id = auth.uid());

drop policy if exists "study_logs: 自分だけ読む" on public.study_logs;
drop policy if exists "study_logs: 自分だけ作る" on public.study_logs;
drop policy if exists "study_logs: 自分だけ変える" on public.study_logs;
drop policy if exists "study_logs: 自分だけ消す" on public.study_logs;
create policy "study_logs: 自分だけ読む"   on public.study_logs for select to authenticated using (user_id = auth.uid());
create policy "study_logs: 自分だけ作る"   on public.study_logs for insert to authenticated with check (user_id = auth.uid());
create policy "study_logs: 自分だけ変える" on public.study_logs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "study_logs: 自分だけ消す"   on public.study_logs for delete to authenticated using (user_id = auth.uid());

-- ---- updated_at を自動で更新 ----
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---- 退会：自分のアカウントを消す（プロフィール・記録も一緒に消える） ----
-- アプリの「すべてのデータを削除」から呼ぶ。消せるのは呼んだ本人のアカウントだけ
create or replace function public.delete_my_account() returns void
language sql security definer set search_path = '' as $$
  delete from auth.users where id = auth.uid();
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
