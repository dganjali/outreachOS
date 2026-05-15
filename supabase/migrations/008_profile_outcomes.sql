-- OutreachOS — Me section Phase 5: outcome attribution.
-- Run AFTER 007_profile_assets.sql.
--
-- Wires profile content to outreach outcomes:
--   1. When a sequence is drafted, record (a) the profile_version active at draft time
--      and (b) which profile fields the LLM cited in each touch.
--   2. When a touch is sent, those refs copy onto the sent_messages row so reply joins
--      can attribute outcomes back to specific profile content.

-- 1. email_sequences: which profile version + which fields cited per touch
alter table public.email_sequences
  add column if not exists profile_version_id uuid references public.profile_versions(id) on delete set null,
  add column if not exists profile_refs jsonb not null default '{}'::jsonb;

create index if not exists email_sequences_profile_version_idx
  on public.email_sequences(profile_version_id)
  where profile_version_id is not null;

-- 2. sent_messages: same fields, scoped to the actual touch that shipped
alter table public.sent_messages
  add column if not exists profile_version_id uuid references public.profile_versions(id) on delete set null,
  add column if not exists profile_refs jsonb not null default '[]'::jsonb;

create index if not exists sent_messages_profile_version_idx
  on public.sent_messages(profile_version_id)
  where profile_version_id is not null;

-- 3. Per-version outcome rollup view
-- One row per profile_version_id with sent / replied counts and reply rate.
-- Used by the Me > History tab. RLS is enforced by the underlying tables.
create or replace view public.profile_version_outcomes as
  select
    pv.id                                                       as profile_version_id,
    pv.user_id                                                  as user_id,
    count(distinct sm.id)                                       as sent_count,
    count(distinct r.id) filter (where r.id is not null)        as reply_count,
    case
      when count(distinct sm.id) = 0 then 0
      else round(
        (count(distinct r.id) filter (where r.id is not null))::numeric
        / count(distinct sm.id)::numeric * 100,
        1
      )
    end                                                         as reply_rate
  from public.profile_versions pv
  left join public.sent_messages sm
    on sm.profile_version_id = pv.id
    and sm.status in ('sent', 'queued')
  left join public.replies r
    on r.sent_message_id = sm.id
  group by pv.id, pv.user_id;

-- The view inherits RLS from the underlying tables (profile_versions, sent_messages, replies).
