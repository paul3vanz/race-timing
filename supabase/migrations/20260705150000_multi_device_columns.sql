-- Multi-device sync & reconciliation support. Mirrors the local SQLite
-- migrations in lib/db.ts (v6-v8) — see the comments there for the "why"
-- behind each column.

alter table events add column join_code text;
create unique index events_join_code_idx on events(join_code) where join_code is not null;

alter table timestamps add column voided boolean not null default false;
alter table timestamps add column is_manual boolean not null default false;
alter table timestamps add column duplicate_of uuid references timestamps(id);

alter table finishes add column flagged boolean not null default false;
alter table finishes add column device_id text not null default 'unknown';
alter table finishes add column duplicate_of uuid references finishes(id);
alter table finishes add column updated_at timestamptz not null default now();

-- finishes.timestamp_id now changes after insert during reconciliation
-- (linking an orphan bib entry to the Timer tap it was aligned with) —
-- bump updated_at automatically, since created_at never changes and a
-- future incremental-pull strategy needs a reliable "changed since" watermark.
create or replace function set_finishes_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger finishes_set_updated_at
before update on finishes
for each row
execute function set_finishes_updated_at();

-- Replace the plain unique constraint with a partial one scoped to
-- *confirmed* finishes (timestamp_id is not null). Two devices legitimately
-- produce two orphan finishes for the same bib pre-reconciliation (one via
-- assignBibToTimestamp, one via recordDirectFinish on the other device) —
-- the client-side clustering pass needs to see both to corroborate them, so
-- a blanket constraint would break the exact multi-device case this exists
-- for. Only once reconciliation links one of them (setting timestamp_id)
-- does uniqueness need to hold, and duplicate_of is set on the redundant one
-- at that point too, so this doubly excludes it.
alter table finishes drop constraint if exists finishes_race_id_bib_number_key;
create unique index finishes_race_bib_idx
  on finishes(race_id, bib_number) where duplicate_of is null and timestamp_id is not null;
