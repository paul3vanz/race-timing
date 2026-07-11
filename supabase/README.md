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
- RLS splits access by role (see
  `migrations/20260711130000_anon_read_only_split.sql`): `anon` is
  SELECT-only everywhere, writes require an `authenticated` session. The app
  gets one automatically via Supabase's anonymous sign-in
  (`lib/supabase.ts` `ensureAnonymousSession`) before any remote write — no
  login UI, no separate credential. This is what makes it safe for the
  black-pear-joggers CMS's public live-results page to use the same anon
  key: it can only ever read. Per-device/per-event write scoping (rather
  than "any authenticated session can write to any race") is the real
  Phase 3 work, still not done.
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
