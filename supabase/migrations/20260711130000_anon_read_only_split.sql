-- ── Undo the abandoned live_results_reader approach ─────────────────────────
-- Hand-signing a JWT with a custom `role` claim never actually worked on
-- Supabase's hosted platform — the API gateway only accepts registered keys
-- (anon/service_role), so that role was unreachable regardless of RLS.
-- Guarded on existence since that migration may never have been pushed.
do $$
begin
  if exists (select from pg_roles where rolname = 'live_results_reader') then
    revoke select on events, races, participants, finishes from live_results_reader;
    revoke usage on schema public from live_results_reader;
    revoke live_results_reader from authenticator;
    drop role live_results_reader;
  end if;
end
$$;

drop policy if exists "live_results_reader read - events"       on events;
drop policy if exists "live_results_reader read - races"        on races;
drop policy if exists "live_results_reader read - participants" on participants;
drop policy if exists "live_results_reader read - finishes"     on finishes;

-- ── Read/write split by role instead of by key ──────────────────────────────
-- `anon` (the black-pear-joggers CMS's live-results page, and the mobile app
-- before it signs in) becomes read-only. Writes now require an
-- `authenticated` session — the mobile app gets one via Supabase's built-in
-- anonymous sign-in (see lib/supabase.ts ensureAnonymousSession), which uses
-- the exact same anon key to connect, just backed by a session token
-- afterwards. No second credential needed anywhere.
--
-- Scope is deliberately coarse: any authenticated session can write to any
-- race, the same blast radius the old "allow all" anon policies had.
-- Per-device/per-event write scoping is the real Phase 3 work already
-- flagged in the init migration and README — out of scope here.
drop policy if exists "allow all - events"       on events;
drop policy if exists "allow all - races"        on races;
drop policy if exists "allow all - participants" on participants;
drop policy if exists "allow all - timestamps"   on timestamps;
drop policy if exists "allow all - finishes"     on finishes;

create policy "anon read only - events"       on events       for select to anon using (true);
create policy "anon read only - races"        on races        for select to anon using (true);
create policy "anon read only - participants" on participants for select to anon using (true);
create policy "anon read only - timestamps"   on timestamps   for select to anon using (true);
create policy "anon read only - finishes"     on finishes     for select to anon using (true);

create policy "authenticated read/write - events"
  on events for all to authenticated using (true) with check (true);
create policy "authenticated read/write - races"
  on races for all to authenticated using (true) with check (true);
create policy "authenticated read/write - participants"
  on participants for all to authenticated using (true) with check (true);
create policy "authenticated read/write - timestamps"
  on timestamps for all to authenticated using (true) with check (true);
create policy "authenticated read/write - finishes"
  on finishes for all to authenticated using (true) with check (true);
