-- Mirrors local SQLite migration v10 in lib/db.ts.
--
-- 1. finishes.source: 'funnel' rows are the race's results (the complete list
--    typed at the end of the funnel, or later matched to the Timers' taps).
--    'line' rows are a backup recorder's partial list typed at the finish line;
--    the app uses them to cross-check the Timers and fill gaps, they are not
--    results in their own right.
--
-- 2. What the public (`anon`) role can read from finishes is now only the
--    published results: not removed entries (voided), not folded-in duplicates
--    (duplicate_of), and not finish-line evidence. The live results page reads
--    with the anon key, so it picks this up with no change on the website, and
--    can never show a duplicate runner because a backup recorder also typed
--    them. The app itself reads as an `authenticated` (anonymous sign-in)
--    session, which keeps full access, because merging needs every raw row.

alter table finishes add column if not exists source text not null default 'funnel';

alter table finishes drop constraint if exists finishes_source_check;
alter table finishes add constraint finishes_source_check check (source in ('funnel', 'line'));

drop policy if exists "anon read only - finishes" on finishes;
create policy "anon read only - finishes"
  on finishes for select to anon
  using (voided = false and duplicate_of is null and source = 'funnel');
