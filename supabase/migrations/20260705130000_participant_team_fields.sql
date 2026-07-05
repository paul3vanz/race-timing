-- Some participants are a team sharing a single bib (one row per team,
-- timed as a single entry) rather than an individual, so every personal
-- field has to become optional. Splits the old combined `name` into
-- first_name/last_name and adds club + team_name, mirroring the local
-- SQLite migration (see lib/db.ts MIGRATIONS v4).
--
-- "At least a name or a team" is enforced in application code
-- (lib/db.ts upsertParticipant), not a DB constraint, so this stays a plain
-- additive/rename migration.

alter table participants add column first_name text;
alter table participants add column last_name text;
alter table participants add column club text;
alter table participants add column team_name text;

update participants set last_name = name where name is not null and last_name is null;

alter table participants drop column name;
