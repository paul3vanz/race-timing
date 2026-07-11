# Race Timing App — Claude Code Guide

## Project Overview

A React Native (Expo) mobile app for timing running races. Built as a technical project to replace paid solutions like Webscorer long-term. The primary use case is events with **200–500 finishers** using a **two-device workflow** at the finish line.

## Current Status

- Expo app scaffolded at `C:\code\race-timing`
- Architecture and data model agreed, no feature code written yet
- Next step: implement core data layer, then Timer and Bib screens

---

## Requirements

### Core Workflow

Two devices operate simultaneously at the finish line:

- **Timer device** — operator watches the finish line and taps a large button once per finisher. Records precise timestamps in sequence. Must be operable single-handed without looking at the screen.
- **Bib device** — shows a queue of unassigned timestamps in order. Operator types bib numbers to assign them sequentially. Should also support typing bib-as-they-finish for smaller/slower finishes.

These two streams are merged to produce final results (bib number + finish time).

### Key Features

- **Offline-first** — fully functional with no connectivity. All data written to local SQLite first.
- **Live sync** — when connectivity is available, push results to Supabase for a live results URL spectators can follow.
- **Multi-device pairing** — Timer and Bib devices join the same race via a short event code.
- **CSV export** — export results from the device for import into other systems.
- **Screen always-on** — both devices must never sleep mid-race.

### Events We're Timing

- Running races (road and trail)
- 200–500 finishers typical
- Remote/low-signal locations common (offline is not optional)
- Not currently on RunSignup or any other platform

---

## Agreed Tech Stack

| Layer            | Choice                   | Notes                                                   |
| ---------------- | ------------------------ | ------------------------------------------------------- |
| Framework        | React Native + Expo      | Do not eject unless absolutely necessary                |
| Local storage    | SQLite via `expo-sqlite` | Primary data store, offline source of truth             |
| State management | Zustand                  | Lightweight, colocate with SQLite sync logic            |
| Backend          | Supabase                 | Free tier sufficient; Postgres + Realtime subscriptions |
| Auth             | Supabase Auth            | Simple event/device auth                                |
| Screen wake lock | `expo-keep-awake`        | Must be active on Timer and Bib screens                 |

---

## Data Model

Implement this schema in SQLite locally. Mirror to Supabase when online.

```sql
events (
  id          TEXT PRIMARY KEY,  -- uuid
  name        TEXT NOT NULL,
  date        TEXT NOT NULL,      -- ISO8601
  location    TEXT,
  status      TEXT DEFAULT 'pending'  -- pending | active | finished
)

races (
  id          TEXT PRIMARY KEY,
  event_id    TEXT REFERENCES events(id),
  name        TEXT NOT NULL,
  start_time  INTEGER,            -- Unix ms, set when race goes live
  wave        INTEGER DEFAULT 1
)

participants (
  id          TEXT PRIMARY KEY,
  race_id     TEXT REFERENCES races(id),
  bib_number  TEXT NOT NULL,
  first_name  TEXT,             -- individual entries
  last_name   TEXT,
  gender      TEXT,
  dob         TEXT,
  club        TEXT,
  category    TEXT,             -- age-group/class (e.g. Senior Male, V40)
  team_name   TEXT,             -- team entries: one row per team, shares a bib
  sub_category TEXT             -- entry format grouping, e.g. solo/pair/team
  -- exactly one identity is required: (first_name or last_name) or team_name
  -- sub_category drives per-group bib allocation and results ranking —
  -- independent of category (age-group), used e.g. by The Wild One
)

timestamps (
  id           TEXT PRIMARY KEY,
  race_id      TEXT REFERENCES races(id),
  recorded_at  INTEGER NOT NULL,  -- Unix ms, Date.now() at moment of tap
  device_id    TEXT NOT NULL,
  sequence_num INTEGER NOT NULL,  -- order within this race on this device
  synced       INTEGER DEFAULT 0  -- 0 = local only, 1 = pushed to Supabase
)

finishes (
  id           TEXT PRIMARY KEY,
  race_id      TEXT REFERENCES races(id),
  bib_number   TEXT NOT NULL,
  timestamp_id TEXT REFERENCES timestamps(id),
  gun_time     INTEGER,           -- ms since race start_time
  chip_time    INTEGER,           -- if chip timing added later
  synced       INTEGER DEFAULT 0
)
```

**Key design decision:** `timestamps` and `finishes` are separate tables. The Timer device writes timestamps; the Bib device creates finish records by pairing bibs to timestamps. This mirrors the physical two-person workflow and simplifies conflict handling.

---

## Screen Structure

```
App
├── Home / Event List
│   └── Create or select an event
├── Race Setup
│   ├── Load participants from CSV
│   └── Configure waves / categories
├── Race Screen
│   ├── Timer Mode     ← full-screen tap button + running clock + timestamp count
│   ├── Bib Mode       ← timestamp queue + large numpad for bib entry
│   └── Review Mode    ← matched results, flag unmatched timestamps
├── Results
│   ├── Sorted finisher list
│   ├── CSV export
│   └── Live results URL (Supabase)
└── Settings
    ├── Device role (Timer / Bib / Solo)
    ├── Event pairing code
    └── Sync status indicator
```

---

## Build Order

Build in this sequence — each phase is usable at a real event:

### Phase 1 — Local MVP (build first)

- SQLite schema and `db.ts` helper (migrations, typed query helpers)
- Zustand store for active race state
- Timer screen — tap to record timestamp, running clock, count display
- Bib entry screen — queue of timestamps, numpad, auto-advance on entry
- Review screen — matched list, highlight gaps
- CSV export
- `expo-keep-awake` on both active screens

### Phase 2 — Live Sync

- Supabase project setup (schema mirrors SQLite)
- Background sync worker — push unsynced rows when online
- Connectivity detection (NetInfo)
- Live results web URL

### Phase 3 — Multi-device

- Event pairing via short code
- Real-time timestamp sync between Timer and Bib devices via Supabase Realtime
- Device role selector in Settings

### Phase 4 — Polish

- Wave start support
- Age group / category scoring
- Participant CSV import
- Results web page styling

---

## UX & Implementation Notes

### Timer Screen

- The tap target must be **enormous** — full screen or close to it
- Show: running clock (HH:MM:SS.ms), finisher count, last recorded time
- Timestamps are **immutable** once written — no editing, only flagging
- Use `Date.now()` for all timestamps (Unix ms integers). Never derive time from a display clock.
- Sequence number is assigned at write time and never changes

### Bib Entry Screen

- Show the oldest unassigned timestamp at the top with its sequence number
- Large numpad (custom component, not system keyboard — faster and more reliable outdoors)
- **Auto-submit** after N digits (configurable, default 3). Operator should not need a confirm tap.
- After submit, immediately advance to next unassigned timestamp
- If a timestamp has no bib after 5 minutes, highlight it in amber as a warning
- Support manual reordering in case a bib was entered out of sequence

### Sync

- SQLite is always written first — Supabase is a mirror, never the primary store
- `synced = 0` rows are pushed in background; never block UI on network
- On reconnect, push all unsynced rows in sequence-number order
- Conflicts: timestamps are immutable so no conflicts possible. Bib assignments use last-write-wins with a local audit log.

### General

- Use `expo-keep-awake` — call `activateKeepAwakeAsync()` when entering Timer or Bib screens, deactivate on leave
- Test offline from the start — do not assume connectivity in any Phase 1 code
- Bib numbers are stored as TEXT not INTEGER (leading zeros, alphanumeric bibs exist)

---

## What We're NOT Building (yet)

- Chip / RFID timing (manual only for now)
- Barcode / QR scanning (possible Phase 4 addition)
- Participant registration or race sign-up
- Payment handling
- iOS-specific features (Android is primary target, iOS nice-to-have)

---

## References from Research

Existing apps evaluated before deciding to build:

- **RunSignup RaceDay** — free but requires RunSignup-hosted events. Ruled out.
- **Webscorer** — $50–100/yr, good feature set, will use as fallback during development
- **RaceGorilla** — evaluated, not selected

The two-device (timestamp + bib) workflow is the same approach used by RunSignup's RaceDay app and is proven at events of this size.
