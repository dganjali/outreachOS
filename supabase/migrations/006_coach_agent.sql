-- OutreachOS — Me section Phase 3: Coach agent.
-- Run AFTER 005_profile_versions.sql.

-- Extend agent_runs.agent_type to include 'coach' so Coach calls count against
-- the daily 50/min/5-per-minute rate limit alongside the other agents.
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
    'coach'
  ));
