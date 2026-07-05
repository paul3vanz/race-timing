-- Initial schema for the race-timing Supabase mirror.
-- Mirrors the SQLite schema in lib/db.ts. SQLite is always the source of
-- truth on-device; this schema exists so unsynced rows can be pushed here
-- once connectivity is available (see CLAUDE.md "Phase 2 - Live Sync").
--
-- Ids are generated client-side via expo-crypto's randomUUID() before
-- insert, so every id column is `uuid` with no default — the app always
-- supplies the value, matching the local primary key.

create extension if not exists pgcrypto;

-- ── events ──────────────────────────────────────────────────────────────────

create table events (
  id         uuid primary key,
  name       text not null,
  date       text not null, -- ISO8601, kept as text to match the local row shape
  location   text,
  status     text not null default 'pending'
             check (status in ('pending', 'active', 'finished')),
  created_at timestamptz not null default now()
);

-- ── races ───────────────────────────────────────────────────────────────────

create table races (
  id         uuid primary key,
  event_id   uuid not null references events(id) on delete cascade,
  name       text not null,
  start_time bigint, -- Unix ms, set when the race goes live
  wave       integer not null default 1,
  max_bib    integer not null default 999, -- drives auto-submit digit count on the bib screen
  created_at timestamptz not null default now()
);

create index races_event_id_idx on races(event_id);

-- ── participants ────────────────────────────────────────────────────────────

create table participants (
  id         uuid primary key,
  race_id    uuid not null references races(id) on delete cascade,
  bib_number text not null, -- TEXT: leading zeros and alphanumeric bibs exist
  name       text,
  category   text,
  gender     text,
  dob        text,
  created_at timestamptz not null default now(),
  unique (race_id, bib_number)
);

create index participants_race_id_idx on participants(race_id);

-- ── timestamps ──────────────────────────────────────────────────────────────
-- Written by the Timer device. Immutable once written — no updates, only inserts.

create table timestamps (
  id           uuid primary key,
  race_id      uuid not null references races(id) on delete cascade,
  recorded_at  bigint not null, -- Unix ms, Date.now() at moment of tap
  device_id    text not null,
  sequence_num integer not null, -- order within this race, per device
  created_at   timestamptz not null default now(),
  unique (race_id, device_id, sequence_num)
);

create index timestamps_race_id_seq_idx on timestamps(race_id, sequence_num);

-- ── finishes ────────────────────────────────────────────────────────────────
-- Written by the Bib device, pairing a bib number to a timestamp.

create table finishes (
  id           uuid primary key,
  race_id      uuid not null references races(id) on delete cascade,
  bib_number   text not null,
  timestamp_id uuid references timestamps(id) on delete set null,
  gun_time     bigint, -- ms since race start_time
  chip_time    bigint, -- reserved for future chip timing
  created_at   timestamptz not null default now(),
  unique (race_id, bib_number)
);

create index finishes_race_id_idx on finishes(race_id);
create index finishes_timestamp_id_idx on finishes(timestamp_id);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Phase 3 (multi-device pairing) will scope access by event/device auth.
-- Until that lands, RLS is enabled but left permissive so the sync worker
-- (anon key) can read/write freely. Tighten these policies before relying
-- on this for anything beyond personal/test events.

alter table events enable row level security;
alter table races enable row level security;
alter table participants enable row level security;
alter table timestamps enable row level security;
alter table finishes enable row level security;

create policy "allow all - events"       on events       for all using (true) with check (true);
create policy "allow all - races"        on races        for all using (true) with check (true);
create policy "allow all - participants" on participants for all using (true) with check (true);
create policy "allow all - timestamps"   on timestamps   for all using (true) with check (true);
create policy "allow all - finishes"     on finishes     for all using (true) with check (true);
