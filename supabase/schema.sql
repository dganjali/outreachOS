-- OutreachOS schema for Supabase
-- Run this in the Supabase SQL editor (or via migrations) after project creation.

-- Profiles: one per user, created on first onboarding step
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  role text,
  organization text,
  bio text,
  resume_url text,
  linkedin_url text,
  website text,
  portfolio_links text[] default '{}',
  proof_points text,
  achievements text,
  metrics text,
  example_emails text,
  writing_tone text,
  onboarding_step int not null default 0,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id)
);

-- Missions: one per campaign
create table if not exists public.missions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  goal text not null,
  target_description text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Targets: companies/organizations per mission
create table if not exists public.targets (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions(id) on delete cascade,
  company_name text not null,
  created_at timestamptz not null default now()
);

-- Contacts: people within targets
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.targets(id) on delete cascade,
  name text not null,
  role text not null,
  email text not null,
  created_at timestamptz not null default now()
);

-- Emails: drafts and sent emails per contact
create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  subject text not null,
  body text not null,
  status text not null default 'draft',
  created_at timestamptz not null default now()
);

-- Replies: track responses (V1 placeholder)
create table if not exists public.replies (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status text not null,
  notes text,
  created_at timestamptz not null default now()
);

-- Optional: files (e.g. resume) — can be extended later
-- create table if not exists public.files (
--   id uuid primary key default gen_random_uuid(),
--   user_id uuid not null references auth.users(id) on delete cascade,
--   name text not null,
--   url text not null,
--   created_at timestamptz not null default now()
-- );

-- RLS: enable and policies so users only see their own data
alter table public.profiles enable row level security;
alter table public.missions enable row level security;
alter table public.targets enable row level security;
alter table public.contacts enable row level security;
alter table public.emails enable row level security;
alter table public.replies enable row level security;

-- Profiles: user can read/update own
create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = user_id);
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = user_id);
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = user_id);

-- Missions: user can CRUD own
create policy "Users can read own missions"
  on public.missions for select
  using (auth.uid() = user_id);
create policy "Users can insert own missions"
  on public.missions for insert
  with check (auth.uid() = user_id);
create policy "Users can update own missions"
  on public.missions for update
  using (auth.uid() = user_id);
create policy "Users can delete own missions"
  on public.missions for delete
  using (auth.uid() = user_id);

-- Targets: via mission ownership (user must own mission)
create policy "Users can read targets for own missions"
  on public.targets for select
  using (
    exists (
      select 1 from public.missions m
      where m.id = targets.mission_id and m.user_id = auth.uid()
    )
  );
create policy "Users can insert targets for own missions"
  on public.targets for insert
  with check (
    exists (
      select 1 from public.missions m
      where m.id = targets.mission_id and m.user_id = auth.uid()
    )
  );
create policy "Users can update targets for own missions"
  on public.targets for update
  using (
    exists (
      select 1 from public.missions m
      where m.id = targets.mission_id and m.user_id = auth.uid()
    )
  );
create policy "Users can delete targets for own missions"
  on public.targets for delete
  using (
    exists (
      select 1 from public.missions m
      where m.id = targets.mission_id and m.user_id = auth.uid()
    )
  );

-- Contacts: via target -> mission ownership
create policy "Users can read contacts for own missions"
  on public.contacts for select
  using (
    exists (
      select 1 from public.targets t
      join public.missions m on m.id = t.mission_id
      where t.id = contacts.target_id and m.user_id = auth.uid()
    )
  );
create policy "Users can insert contacts for own missions"
  on public.contacts for insert
  with check (
    exists (
      select 1 from public.targets t
      join public.missions m on m.id = t.mission_id
      where t.id = contacts.target_id and m.user_id = auth.uid()
    )
  );
create policy "Users can update contacts for own missions"
  on public.contacts for update
  using (
    exists (
      select 1 from public.targets t
      join public.missions m on m.id = t.mission_id
      where t.id = contacts.target_id and m.user_id = auth.uid()
    )
  );
create policy "Users can delete contacts for own missions"
  on public.contacts for delete
  using (
    exists (
      select 1 from public.targets t
      join public.missions m on m.id = t.mission_id
      where t.id = contacts.target_id and m.user_id = auth.uid()
    )
  );

-- Emails: via contact -> target -> mission
create policy "Users can read emails for own missions"
  on public.emails for select
  using (
    exists (
      select 1 from public.contacts c
      join public.targets t on t.id = c.target_id
      join public.missions m on m.id = t.mission_id
      where c.id = emails.contact_id and m.user_id = auth.uid()
    )
  );
create policy "Users can insert emails for own missions"
  on public.emails for insert
  with check (
    exists (
      select 1 from public.contacts c
      join public.targets t on t.id = c.target_id
      join public.missions m on m.id = t.mission_id
      where c.id = emails.contact_id and m.user_id = auth.uid()
    )
  );
create policy "Users can update emails for own missions"
  on public.emails for update
  using (
    exists (
      select 1 from public.contacts c
      join public.targets t on t.id = c.target_id
      join public.missions m on m.id = t.mission_id
      where c.id = emails.contact_id and m.user_id = auth.uid()
    )
  );
create policy "Users can delete emails for own missions"
  on public.emails for delete
  using (
    exists (
      select 1 from public.contacts c
      join public.targets t on t.id = c.target_id
      join public.missions m on m.id = t.mission_id
      where c.id = emails.contact_id and m.user_id = auth.uid()
    )
  );

-- Replies: same as emails
create policy "Users can read replies for own missions"
  on public.replies for select
  using (
    exists (
      select 1 from public.contacts c
      join public.targets t on t.id = c.target_id
      join public.missions m on m.id = t.mission_id
      where c.id = replies.contact_id and m.user_id = auth.uid()
    )
  );
create policy "Users can insert replies for own missions"
  on public.replies for insert
  with check (
    exists (
      select 1 from public.contacts c
      join public.targets t on t.id = c.target_id
      join public.missions m on m.id = t.mission_id
      where c.id = replies.contact_id and m.user_id = auth.uid()
    )
  );
create policy "Users can update replies for own missions"
  on public.replies for update
  using (
    exists (
      select 1 from public.contacts c
      join public.targets t on t.id = c.target_id
      join public.missions m on m.id = t.mission_id
      where c.id = replies.contact_id and m.user_id = auth.uid()
    )
  );
create policy "Users can delete replies for own missions"
  on public.replies for delete
  using (
    exists (
      select 1 from public.contacts c
      join public.targets t on t.id = c.target_id
      join public.missions m on m.id = t.mission_id
      where c.id = replies.contact_id and m.user_id = auth.uid()
    )
  );
