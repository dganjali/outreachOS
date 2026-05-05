-- OutreachOS — cleanup pass after M1
-- Run AFTER 003_gmail_integration.sql.

-- 1. Drop the dead `public.emails` table.
-- Replaced by `email_sequences` (002) and `sent_messages` (003). No code reads or writes it.
drop policy if exists "Users can read emails for own missions" on public.emails;
drop policy if exists "Users can insert emails for own missions" on public.emails;
drop policy if exists "Users can update emails for own missions" on public.emails;
drop policy if exists "Users can delete emails for own missions" on public.emails;
drop table if exists public.emails;

-- 2. Tighten replies RLS.
-- The original contact-only policies (from schema.sql) and the user_id-scoped policies
-- coexisted. Drop the contact-only ones — replies now always have a user_id (set by the
-- cron poller, which is the only writer).
drop policy if exists "Users can read replies for own missions" on public.replies;
drop policy if exists "Users can insert replies for own missions" on public.replies;
drop policy if exists "Users can update replies for own missions" on public.replies;
drop policy if exists "Users can delete replies for own missions" on public.replies;

drop policy if exists "replies_select_own" on public.replies;
create policy "replies_select_own" on public.replies
  for select using (auth.uid() = user_id);

drop policy if exists "replies_update_own" on public.replies;
create policy "replies_update_own" on public.replies
  for update using (auth.uid() = user_id);
-- inserts happen via service role from cron poller; no user insert/delete policy.

-- 3. Soft-delete missions: archived_at column.
-- `delete cascade` from missions wipes targets/contacts/sequences/sent/replies — too dangerous
-- for a fat-finger click. UI now sets archived_at instead.
alter table public.missions
  add column if not exists archived_at timestamptz;

create index if not exists missions_user_active_idx
  on public.missions(user_id, created_at desc)
  where archived_at is null;
