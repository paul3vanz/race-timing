-- Sub-category (e.g. solo/pair/team for a multi-lap event). Bibs are
-- allocated per sub-category block and results are grouped by it, so it
-- needs to travel with the participant rather than being inferred from
-- team_name (a solo entrant still has a name, not a team). Mirrors the
-- local SQLite migration (see lib/db.ts MIGRATIONS v5).

alter table participants add column sub_category text;
