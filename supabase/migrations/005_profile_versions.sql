-- OutreachOS — Me section Phase 2: profile version history.
-- Run AFTER 004_cleanup.sql (order with 004_apollo_personalization.sql does not matter — disjoint columns).

create table if not exists public.profile_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot jsonb not null,
  source text not null default 'manual'
    check (source in ('manual', 'enrich', 'coach', 'import', 'restore')),
  label text,
  created_at timestamptz not null default now()
);

create index if not exists profile_versions_user_created_idx
  on public.profile_versions(user_id, created_at desc);

alter table public.profile_versions enable row level security;

drop policy if exists "profile_versions_select_own" on public.profile_versions;
create policy "profile_versions_select_own" on public.profile_versions
  for select using (auth.uid() = user_id);

drop policy if exists "profile_versions_insert_own" on public.profile_versions;
create policy "profile_versions_insert_own" on public.profile_versions
  for insert with check (auth.uid() = user_id);

drop policy if exists "profile_versions_delete_own" on public.profile_versions;
create policy "profile_versions_delete_own" on public.profile_versions
  for delete using (auth.uid() = user_id);
-- No update policy — versions are immutable snapshots.
