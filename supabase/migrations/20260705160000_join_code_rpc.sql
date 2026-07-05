-- Narrow, purpose-built RPC for the "join a race by code" flow (see
-- lib/sync.ts's lookupEventByJoinCode). Deliberately not a raw `select *`
-- against the events table: RLS policies on this project are still the
-- permissive "allow all" placeholders from 20260705120000_init_schema.sql,
-- so an unrestricted table select gated only by a public 6-char join_code
-- would double as free read/write on every other table for that race,
-- indefinitely, to anyone who ever saw the code (or brute-forced the ~1e9
-- code space via the anon key).
--
-- This is a stopgap, not a fix — the correct long-term answer is per-device
-- RLS via Supabase anonymous auth plus a race_devices table, deliberately
-- deferred for this pass (see the multi-device plan in CLAUDE.md history).
-- All this RPC does is narrow what a bare join_code can reveal to the
-- minimum needed to join: the event/race identity, not arbitrary access.
create or replace function get_event_by_code(code text)
returns table (
  event_id uuid,
  event_name text,
  event_date text,
  event_location text,
  event_status text,
  race_id uuid,
  race_name text,
  race_start_time bigint,
  race_wave integer,
  race_max_bib integer
)
language sql
security definer
set search_path = public
as $$
  select
    e.id, e.name, e.date, e.location, e.status,
    r.id, r.name, r.start_time, r.wave, r.max_bib
  from events e
  join races r on r.event_id = e.id
  where e.join_code = code
  limit 1;
$$;

grant execute on function get_event_by_code(text) to anon;
