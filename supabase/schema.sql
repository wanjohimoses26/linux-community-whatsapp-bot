create extension if not exists pgcrypto;

create table if not exists members (
  id_hash text primary key,
  display_name text,
  joined_at timestamptz,
  interests text[] not null default '{}',
  lang text,
  xp bigint not null default 0 check (xp >= 0),
  streak integer not null default 0 check (streak >= 0),
  opted_out boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists groups (
  group_id text primary key,
  label text not null,
  paused boolean not null default false,
  daily_cap integer not null default 2 check (daily_cap between 0 and 20),
  created_at timestamptz not null default now()
);

create table if not exists message_receipts (
  message_id text primary key,
  group_id text,
  sender_hash text,
  received_at timestamptz not null default now()
);
create index if not exists message_receipts_received_idx on message_receipts(received_at);

create table if not exists xp_log (
  id uuid primary key default gen_random_uuid(),
  member_hash text not null references members(id_hash),
  group_id text,
  amount integer not null check (amount > 0),
  reason text not null,
  occurred_at timestamptz not null default now()
);
create index if not exists xp_log_member_idx on xp_log(member_hash, occurred_at desc);

create table if not exists warnings (
  id uuid primary key default gen_random_uuid(),
  member_hash text not null references members(id_hash),
  group_id text,
  reason text not null,
  severity text not null default 'normal' check (severity in ('normal','severe')),
  active boolean not null default true,
  occurred_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists roles (
  member_hash text not null references members(id_hash),
  role text not null check (role in ('owner','admin','mod','helper','member')),
  granted_by text,
  granted_at timestamptz not null default now(),
  primary key (member_hash, role)
);

create table if not exists onboarding_state (
  member_hash text primary key references members(id_hash),
  asked_at timestamptz,
  step integer not null default 0 check (step between 0 and 5),
  answered_at timestamptz,
  uses_linux text check (uses_linux in ('yes','no','dual_boot')),
  distro text,
  wants_install text check (wants_install in ('yes','no','later')),
  opted_out boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  group_id text not null,
  question_type text not null check (question_type in ('starter','quiz','poll','ctf')),
  text text not null,
  answer text,
  posted_at timestamptz not null default now(),
  closes_at timestamptz not null,
  status text not null default 'active' check (status in ('active','closed','cancelled'))
);
create unique index if not exists questions_one_active_per_group_idx
  on questions(group_id) where status = 'active';

create table if not exists ctf_challenges (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  points integer not null check (points between 1 and 10000),
  category text not null,
  flag_hash text not null,
  hints jsonb not null default '[]',
  released_at timestamptz,
  closed_at timestamptz
);
create table if not exists ctf_solves (
  challenge_id uuid not null references ctf_challenges(id),
  member_hash text not null references members(id_hash),
  solved_at timestamptz not null default now(),
  first_blood boolean not null default false,
  primary key (challenge_id, member_hash)
);

create table if not exists help_tickets (
  id uuid primary key default gen_random_uuid(),
  member_hash text not null references members(id_hash),
  group_id text not null,
  summary text not null,
  status text not null default 'open' check (status in ('open','claimed','solved','closed')),
  helper_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_hash text not null,
  action text not null,
  target_hash text,
  note text,
  occurred_at timestamptz not null default now()
);

create table if not exists settings (
  scope text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (scope, key)
);

create table if not exists ai_usage (
  provider text not null,
  model text not null,
  usage_day date not null default current_date,
  request_count integer not null default 0,
  error_count integer not null default 0,
  primary key (provider, model, usage_day)
);

-- Keep operational data bounded. Schedule this with pg_cron or the application scheduler.
-- Never delete active moderation records or CTF solve history automatically.
