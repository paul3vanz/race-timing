-- Mirrors local SQLite migration v11 in lib/db.ts. APPLY THIS BEFORE (or at the
-- same time as) installing the build that includes it: the app pushes whole
-- rows, so a remote without these columns rejects every upsert of that table.
--
-- 1. operator_name on timestamps/finishes: the name the person using the
--    device entered, so every row can be traced back to someone.
-- 2. finishes.entered_at: Unix ms the bib was actually typed. gun_time is the
--    matched tap's time, so this is what keeps the raw export in typed order.
-- 3. participants.status: 'dns' (did not start) / 'dnf' (did not finish), set
--    on the day so those entrants aren't expected in the results.
-- 4. races.format: 'single' (each runner crosses once, so a repeated bib is a
--    mistake to correct) or 'laps' (a repeated bib is another lap). The live
--    results page reads this to decide how to treat a repeated bib.

alter table timestamps add column if not exists operator_name text;
alter table finishes add column if not exists operator_name text;
alter table finishes add column if not exists entered_at bigint;

alter table participants add column if not exists status text;
alter table participants drop constraint if exists participants_status_check;
alter table participants add constraint participants_status_check check (status is null or status in ('dns', 'dnf'));

alter table races add column if not exists format text not null default 'single';
alter table races drop constraint if exists races_format_check;
alter table races add constraint races_format_check check (format in ('single', 'laps'));

-- Races before the first single-lap event (Croome, 21/22 Nov 2026) were all
-- lapped events: keep their live results page reading them as laps.
update races set format = 'laps' where created_at < '2026-11-20';
