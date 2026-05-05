-- OutreachOS — Apollo target hunting + LinkedIn personalization
-- Run this AFTER 003_gmail_integration.sql.
-- All columns are optional. Apollo is enabled at runtime by APOLLO_API_KEY env var;
-- when unset, the agents fall back to pure web_search and these columns stay null.

-- 1. Targets: Apollo identifiers + firmographics surfaced for ranking + display
alter table public.targets
  add column if not exists apollo_organization_id text,
  add column if not exists industry text,
  add column if not exists employee_count int,
  add column if not exists headquarters_location text,
  add column if not exists source text not null default 'web_search'
    check (source in ('web_search','apollo','csv','manual'));

create index if not exists targets_apollo_idx
  on public.targets(mission_id, apollo_organization_id)
  where apollo_organization_id is not null;

-- 2. Contacts: Apollo identifiers + email verification state from provider
alter table public.contacts
  add column if not exists apollo_person_id text,
  add column if not exists email_status text not null default 'none'
    check (email_status in ('verified','likely','guessed','none')),
  add column if not exists seniority text,
  add column if not exists headline text,
  add column if not exists location text,
  add column if not exists source text not null default 'web_search'
    check (source in ('web_search','apollo','csv','manual'));

create index if not exists contacts_apollo_idx
  on public.contacts(target_id, apollo_person_id)
  where apollo_person_id is not null;

-- 3. Profiles: cached LinkedIn enrichment for personalization
alter table public.profiles
  add column if not exists linkedin_data jsonb,
  add column if not exists linkedin_enriched_at timestamptz,
  add column if not exists linkedin_source text
    check (linkedin_source in ('apollo','web_search'));

-- 4. Allow 'enrich_profile' agent type
alter table public.agent_runs
  drop constraint if exists agent_runs_agent_type_check;
alter table public.agent_runs
  add constraint agent_runs_agent_type_check
  check (agent_type in ('targeting','contacts','evidence','sequence','reply','enrich_profile'));
