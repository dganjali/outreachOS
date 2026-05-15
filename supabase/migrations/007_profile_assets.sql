-- OutreachOS — Me section Phase 4: uploaded profile assets (resume, portfolio).
-- Run AFTER 006_coach_agent.sql.

-- 1. profile_assets table
create table if not exists public.profile_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null
    check (kind in ('resume', 'portfolio_pdf', 'case_study', 'screenshot')),
  storage_path text not null,            -- path inside the `profile-assets` bucket
  file_name text not null,               -- original filename, surfaced in UI
  file_size integer not null,            -- bytes; client-side max 2MB enforced
  mime_type text,
  parsed_text text,                      -- raw extracted text (for resume)
  parsed_fields jsonb,                   -- LLM-structured output the user can accept/decline
  parsed_at timestamptz,
  parse_error text,
  source_url text,                       -- optional canonical URL (e.g. published version)
  created_at timestamptz not null default now()
);

create index if not exists profile_assets_user_kind_idx
  on public.profile_assets(user_id, kind, created_at desc);

alter table public.profile_assets enable row level security;

drop policy if exists "profile_assets_select_own" on public.profile_assets;
create policy "profile_assets_select_own" on public.profile_assets
  for select using (auth.uid() = user_id);

drop policy if exists "profile_assets_insert_own" on public.profile_assets;
create policy "profile_assets_insert_own" on public.profile_assets
  for insert with check (auth.uid() = user_id);

drop policy if exists "profile_assets_update_own" on public.profile_assets;
create policy "profile_assets_update_own" on public.profile_assets
  for update using (auth.uid() = user_id);

drop policy if exists "profile_assets_delete_own" on public.profile_assets;
create policy "profile_assets_delete_own" on public.profile_assets
  for delete using (auth.uid() = user_id);

-- 2. Storage bucket + policies
-- Idempotent: skip if the bucket already exists.
insert into storage.buckets (id, name, public)
values ('profile-assets', 'profile-assets', false)
on conflict (id) do nothing;

-- Object naming convention: `{user_id}/{kind}/{uuid}.{ext}`.
-- The first path segment must equal auth.uid() so users can only read/write their own folder.

drop policy if exists "profile_assets_bucket_select" on storage.objects;
create policy "profile_assets_bucket_select" on storage.objects
  for select using (
    bucket_id = 'profile-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "profile_assets_bucket_insert" on storage.objects;
create policy "profile_assets_bucket_insert" on storage.objects
  for insert with check (
    bucket_id = 'profile-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "profile_assets_bucket_update" on storage.objects;
create policy "profile_assets_bucket_update" on storage.objects
  for update using (
    bucket_id = 'profile-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "profile_assets_bucket_delete" on storage.objects;
create policy "profile_assets_bucket_delete" on storage.objects
  for delete using (
    bucket_id = 'profile-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 3. Allow 'parse_resume' agent type for rate-limit accounting.
alter table public.agent_runs
  drop constraint if exists agent_runs_agent_type_check;
alter table public.agent_runs
  add constraint agent_runs_agent_type_check
  check (agent_type in (
    'targeting',
    'contacts',
    'evidence',
    'sequence',
    'reply',
    'enrich_profile',
    'coach',
    'parse_resume'
  ));
