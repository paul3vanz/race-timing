-- Mirrors local SQLite migration v9 in lib/db.ts. APPLY THIS BEFORE (or at the
-- same time as) installing the build that includes it: that build pushes a
-- `voided` column on finishes, and a remote without it rejects every finish
-- upsert until this has been run (`supabase db push`).
--
-- 1. A bib may now appear on more than one finish. The partial unique index
--    from 20260705150000 made a mistyped or double-entered bib fail the sync
--    upsert (and, locally, freeze the Bib numpad). Duplicates are now surfaced
--    and corrected on the Results screen instead.
--
-- 2. finishes.voided lets the Results screen remove a bib entry in a way that
--    syncs to the other devices (a hard delete would not).

drop index if exists finishes_race_bib_idx;
create index if not exists finishes_race_bib_idx on finishes(race_id, bib_number);

alter table finishes add column if not exists voided boolean not null default false;
