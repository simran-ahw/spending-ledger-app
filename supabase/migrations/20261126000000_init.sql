-- Spending Ledger: schema, row-level security, realtime and scheduled jobs.
-- Every table is private per user: people only ever see their own rows.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Settings: one row per user. `data` holds the same JSON the tracker uses
-- (income, target, currency, cats, mandatory, cards, limits, recurring, notify, tz).
-- `ingest_token` is the secret in the phone's webhook URL.
create table public.settings (
  user_id      uuid primary key default auth.uid() references auth.users on delete cascade,
  data         jsonb not null default '{}'::jsonb,
  ingest_token text not null unique
               default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
               check (length(ingest_token) >= 32),
  updated_at   timestamptz not null default now()
);

-- Expenses. `id` is chosen by whoever creates the row and is unique per user,
-- so repeats (recurring months, a phone alert sent twice, a CSV imported twice)
-- land on the same row instead of duplicating.
create table public.expenses (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null check (length(id) between 1 and 120),
  date       date not null,
  amount     numeric(12,2) not null check (amount > 0),
  category   text not null,
  splits     jsonb,
  merchant   text not null default '',
  note       text not null default '',
  paid_with  text not null default '',
  source     text not null default 'manual',
  recur_id   text,
  alert      text,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index expenses_user_date on public.expenses (user_id, date);

-- Browser push subscriptions (one per device).
create table public.push_subscriptions (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);

-- Days on which each person opened the app: drives streaks and daily active users.
create table public.app_opens (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day     date not null,
  first_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Notifications already sent (stops the hourly job sending one twice).
create table public.notify_log (
  user_id uuid not null references auth.users on delete cascade,
  kind    text not null,
  key     text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, key)
);

-- Raw phone alerts received, kept 60 days for checking what was imported.
create table public.ingest_log (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users on delete cascade,
  received_at timestamptz not null default now(),
  raw         text not null,
  result      jsonb
);
create index ingest_log_user on public.ingest_log (user_id, received_at desc);

-- Claude calls per person per day (a cost cap).
create table public.ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  day     date not null,
  calls   int not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------------
-- Row-level security
alter table public.settings           enable row level security;
alter table public.expenses           enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_opens          enable row level security;
alter table public.notify_log         enable row level security;
alter table public.ingest_log         enable row level security;
alter table public.ai_usage           enable row level security;

create policy "own settings" on public.settings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own expenses" on public.expenses
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own push" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own opens read" on public.app_opens
  for select to authenticated using (user_id = auth.uid());
create policy "own opens add" on public.app_opens
  for insert to authenticated with check (user_id = auth.uid() and day between current_date - 1 and current_date + 1);
create policy "own ingest log" on public.ingest_log
  for select to authenticated using (user_id = auth.uid());
-- notify_log and ai_usage: server only (no policies = no access for users).

-- Atomically count a Claude call; returns the new count for today.
create or replace function public.bump_ai_usage(p_user uuid) returns int
language sql security definer set search_path = public as $$
  insert into ai_usage (user_id, day, calls) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set calls = ai_usage.calls + 1
  returning calls;
$$;
revoke all on function public.bump_ai_usage(uuid) from public, anon, authenticated;

-- Live updates in the app when the phone or the server adds an expense.
alter publication supabase_realtime add table public.expenses, public.settings;

-- ---------------------------------------------------------------------------
-- Daily and monthly active users (owner only: query from the Supabase SQL editor).
create view public.daily_active_users with (security_invoker = true) as
  select day, count(*) as active_users
  from public.app_opens group by day order by day desc;
create view public.monthly_active_users with (security_invoker = true) as
  select date_trunc('month', day)::date as month, count(distinct user_id) as active_users
  from public.app_opens group by 1 order by 1 desc;
revoke all on public.daily_active_users, public.monthly_active_users from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Housekeeping and the hourly job (daily summary, weekly check-in, recurring
-- expenses, streak reminders). The job reads two Vault secrets you add once:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<the CRON_SECRET you set for functions>', 'cron_secret');
select cron.schedule('ledger-hourly', '2 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
$$);
select cron.schedule('ledger-cleanup', '17 3 * * *', $$
  delete from public.ingest_log where received_at < now() - interval '60 days';
  delete from public.notify_log where sent_at < now() - interval '120 days';
  delete from public.ai_usage where day < current_date - 30;
$$);
