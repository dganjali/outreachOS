-- OutreachOS — M1: Gmail integration + send & reply tracking
-- Run this AFTER 002_agent_layer.sql.

-- 1. user_integrations: per-user connected provider accounts (Gmail for now)
create table if not exists public.user_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail')),
  provider_account_email text,
  -- encrypted with server AES-GCM key (never readable from client; service-role only)
  refresh_token_encrypted text not null,
  access_token_encrypted text,
  access_token_expires_at timestamptz,
  scopes text,
  status text not null default 'active' check (status in ('active','revoked','error')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider)
);

create index if not exists user_integrations_user_idx
  on public.user_integrations(user_id);

-- 2. sent_messages: one row per individual sent (or draft-staged) email touch
-- Distinct from email_sequences (which is the planned 3-touch template).
create table if not exists public.sent_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sequence_id uuid not null references public.email_sequences(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  mission_id uuid not null references public.missions(id) on delete cascade,
  touch_index int not null,  -- 0 = initial, 1+ = follow-ups
  subject text not null,
  body text not null,
  to_email text not null,
  -- Gmail metadata
  gmail_draft_id text,
  gmail_message_id text,
  gmail_thread_id text,
  -- Lifecycle
  status text not null default 'draft'
    check (status in ('draft','queued','sent','failed','bounced')),
  scheduled_send_at timestamptz,
  sent_at timestamptz,
  failed_reason text,
  created_at timestamptz not null default now(),
  unique(sequence_id, touch_index)
);

create index if not exists sent_messages_user_idx
  on public.sent_messages(user_id, sent_at desc nulls last);
create index if not exists sent_messages_thread_idx
  on public.sent_messages(gmail_thread_id) where gmail_thread_id is not null;
create index if not exists sent_messages_followup_idx
  on public.sent_messages(status, scheduled_send_at) where status = 'queued';

-- 3. Extend replies table for full classification + Gmail metadata
alter table public.replies
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists sent_message_id uuid references public.sent_messages(id) on delete set null,
  add column if not exists gmail_message_id text,
  add column if not exists gmail_thread_id text,
  add column if not exists from_email text,
  add column if not exists subject text,
  add column if not exists body text,
  add column if not exists snippet text,
  add column if not exists classification text
    check (classification in ('interested','not_now','wrong_person','referral','oof','unsubscribe','question','other')),
  add column if not exists urgency text check (urgency in ('low','normal','high')),
  add column if not exists key_points jsonb,
  add column if not exists suggested_response jsonb,
  add column if not exists recommended_action text,
  add column if not exists handled boolean not null default false,
  add column if not exists received_at timestamptz;

create unique index if not exists replies_gmail_message_unique
  on public.replies(gmail_message_id) where gmail_message_id is not null;
create index if not exists replies_user_handled_idx
  on public.replies(user_id, handled, received_at desc);

-- 4. Allow 'reply' agent type in agent_runs
alter table public.agent_runs
  drop constraint if exists agent_runs_agent_type_check;
alter table public.agent_runs
  add constraint agent_runs_agent_type_check
  check (agent_type in ('targeting','contacts','evidence','sequence','reply'));

-- 5. RLS for new tables
alter table public.user_integrations enable row level security;
alter table public.sent_messages enable row level security;

-- user_integrations: user can read existence/status; refresh_token encrypted is opaque anyway,
-- but we deny direct select on token columns by only granting select on a safe view if needed.
-- For MVP, allow user to see their own row (token columns are encrypted).
drop policy if exists "ui_select" on public.user_integrations;
create policy "ui_select" on public.user_integrations
  for select using (auth.uid() = user_id);
drop policy if exists "ui_delete" on public.user_integrations;
create policy "ui_delete" on public.user_integrations
  for delete using (auth.uid() = user_id);
-- writes happen via service role only (no insert/update policy for users)

-- sent_messages: user can read their own
drop policy if exists "sm_select" on public.sent_messages;
create policy "sm_select" on public.sent_messages
  for select using (auth.uid() = user_id);
-- writes via service role
