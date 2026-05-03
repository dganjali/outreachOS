-- OutreachOS — Agent layer additions
-- Run this AFTER schema.sql in the Supabase SQL editor.

-- 1. Missions: add mode + offer details
alter table public.missions
  add column if not exists mode text not null default 'sales'
    check (mode in ('sponsorship','bd','internship','recruiting','sales')),
  add column if not exists offer_details text;

-- 2. Targets: add scoring + signals + status + dedup safety
alter table public.targets
  add column if not exists domain text,
  add column if not exists score int,
  add column if not exists why_now text,
  add column if not exists fit_reason text,
  add column if not exists signal_type text,
  add column if not exists status text not null default 'suggested'
    check (status in ('suggested','approved','rejected','contacted'));

create index if not exists targets_mission_status_idx
  on public.targets(mission_id, status);

-- 3. Contacts: add LinkedIn, confidence, reasoning, status
-- Make email nullable since the agent often won't have a verified email.
alter table public.contacts
  alter column email drop not null,
  add column if not exists linkedin_url text,
  add column if not exists likely_email_pattern text,
  add column if not exists confidence numeric(3,2),
  add column if not exists reasoning text,
  add column if not exists status text not null default 'suggested'
    check (status in ('suggested','approved','rejected','contacted','replied'));

create index if not exists contacts_target_status_idx
  on public.contacts(target_id, status);

-- 4. Evidence packs: per-target sourced bullets
create table if not exists public.evidence_packs (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.targets(id) on delete cascade,
  bullets jsonb not null default '[]'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists evidence_packs_target_idx
  on public.evidence_packs(target_id, created_at desc);

-- 5. Email sequences: replace single-email model
-- Keep public.emails for backwards compatibility; new code writes to email_sequences.
create table if not exists public.email_sequences (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  target_id uuid not null references public.targets(id) on delete cascade,
  mission_id uuid not null references public.missions(id) on delete cascade,
  evidence_pack_id uuid references public.evidence_packs(id) on delete set null,
  primary_angle text,
  anchored_bullets jsonb not null default '[]'::jsonb,
  subject text not null,
  body text not null,
  followups jsonb not null default '[]'::jsonb,
  status text not null default 'draft'
    check (status in ('draft','approved','sent','bounced','replied','archived')),
  scheduled_send_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists email_sequences_mission_idx
  on public.email_sequences(mission_id, status);
create index if not exists email_sequences_contact_idx
  on public.email_sequences(contact_id, created_at desc);

-- 6. Agent runs: telemetry + status
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mission_id uuid references public.missions(id) on delete cascade,
  target_id uuid references public.targets(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  agent_type text not null
    check (agent_type in ('targeting','contacts','evidence','sequence')),
  status text not null default 'running'
    check (status in ('running','completed','failed')),
  input jsonb,
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists agent_runs_user_idx
  on public.agent_runs(user_id, started_at desc);
create index if not exists agent_runs_mission_idx
  on public.agent_runs(mission_id, started_at desc);

-- 7. RLS for new tables
alter table public.evidence_packs enable row level security;
alter table public.email_sequences enable row level security;
alter table public.agent_runs enable row level security;

-- evidence_packs: via target -> mission ownership
drop policy if exists "ep_select" on public.evidence_packs;
create policy "ep_select" on public.evidence_packs for select using (
  exists (
    select 1 from public.targets t
    join public.missions m on m.id = t.mission_id
    where t.id = evidence_packs.target_id and m.user_id = auth.uid()
  )
);
drop policy if exists "ep_insert" on public.evidence_packs;
create policy "ep_insert" on public.evidence_packs for insert with check (
  exists (
    select 1 from public.targets t
    join public.missions m on m.id = t.mission_id
    where t.id = evidence_packs.target_id and m.user_id = auth.uid()
  )
);
drop policy if exists "ep_delete" on public.evidence_packs;
create policy "ep_delete" on public.evidence_packs for delete using (
  exists (
    select 1 from public.targets t
    join public.missions m on m.id = t.mission_id
    where t.id = evidence_packs.target_id and m.user_id = auth.uid()
  )
);

-- email_sequences
drop policy if exists "es_select" on public.email_sequences;
create policy "es_select" on public.email_sequences for select using (
  exists (select 1 from public.missions m where m.id = email_sequences.mission_id and m.user_id = auth.uid())
);
drop policy if exists "es_insert" on public.email_sequences;
create policy "es_insert" on public.email_sequences for insert with check (
  exists (select 1 from public.missions m where m.id = email_sequences.mission_id and m.user_id = auth.uid())
);
drop policy if exists "es_update" on public.email_sequences;
create policy "es_update" on public.email_sequences for update using (
  exists (select 1 from public.missions m where m.id = email_sequences.mission_id and m.user_id = auth.uid())
);
drop policy if exists "es_delete" on public.email_sequences;
create policy "es_delete" on public.email_sequences for delete using (
  exists (select 1 from public.missions m where m.id = email_sequences.mission_id and m.user_id = auth.uid())
);

-- agent_runs
drop policy if exists "ar_select" on public.agent_runs;
create policy "ar_select" on public.agent_runs for select using (auth.uid() = user_id);
drop policy if exists "ar_insert" on public.agent_runs;
create policy "ar_insert" on public.agent_runs for insert with check (auth.uid() = user_id);
drop policy if exists "ar_update" on public.agent_runs;
create policy "ar_update" on public.agent_runs for update using (auth.uid() = user_id);
