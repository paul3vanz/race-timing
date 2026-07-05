# Supabase schema

Mirrors the SQLite schema in [`lib/db.ts`](../lib/db.ts). SQLite is always the
source of truth on-device — this is the push target for Phase 2 live sync.

## Apply the schema

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>   # from the Supabase dashboard URL
supabase db push
```

This runs `migrations/20260705120000_init_schema.sql` against your linked
project. Re-running `supabase db push` later only applies new migration
files.

## Notes

- Table/column names and types match the local schema so sync code can map
  rows across 1:1, aside from the local-only `synced` flag (a remote-only
  push target has no need to track sync state about itself).
- RLS is enabled on every table but currently permissive (`using (true)`) —
  there's no device/event auth yet. Tighten these policies when Phase 3
  (multi-device pairing) adds per-event access control.
- `id` columns are `uuid` with no default; the app always generates ids via
  `expo-crypto`'s `randomUUID()` before insert.
- The sync worker (`lib/sync.ts`) upserts `events`/`races` on `id`, but
  `participants` on `(race_id, bib_number)` — a CSV re-import assigns fresh
  local ids, so matching on the natural key avoids duplicating remote rows.
- `participants` has no single `name` column — it's `first_name`/`last_name`
  for individuals, or `team_name` for a team sharing one bib (one row per
  team, timed as a single entry). At least one of the three is required,
  enforced in `lib/db.ts` (`upsertParticipant`), not a DB constraint.
- `sub_category` is a free-text grouping independent of `category` (which is
  the age-group/class) — e.g. solo/pair/team for a multi-lap event where
  bibs are allocated and results are ranked separately per group.
- See the root [README](../README.md#live-sync-supabase) for how to point
  the app at this project (env vars, emulator/device connectivity notes).
