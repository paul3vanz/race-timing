// Raw data export: every tap and every bib this device holds for a race, one
// row each, in the order they were entered. Deliberately independent of the
// results merging (lib/merge.ts), so it works for a Timer-only phone with no
// bibs, with no signal, and even when the Results screen can't be built. The
// rows can be pasted into a spreadsheet and the results compiled by hand.
//
// Pure (rows in, CSV text out) and defensive: every field is read as optional,
// so a row from an older or newer schema still exports rather than throwing.

import Papa from 'papaparse';

type Loose<T> = { [K in keyof T]?: T[K] | null };

export interface RawTap {
  id: string;
  recorded_at: number;
  device_id?: string | null;
  sequence_num?: number | null;
  voided?: number | boolean | null;
  is_manual?: number | boolean | null;
  duplicate_of?: string | null;
  operator_name?: string | null;
}

export interface RawFinish {
  id: string;
  bib_number: string;
  timestamp_id?: string | null;
  gun_time?: number | null;
  device_id?: string | null;
  voided?: number | boolean | null;
  duplicate_of?: string | null;
  source?: string | null;
  entered_at?: number | null;
  operator_name?: string | null;
}

export interface RawExportInput {
  race: Loose<{ name: string; start_time: number }> | null;
  taps: RawTap[];
  finishes: RawFinish[];
  participants?: Loose<{
    bib_number: string;
    first_name: string;
    last_name: string;
    team_name: string;
    status: string;
  }>[];
}

const p2 = (n: number) => n.toString().padStart(2, '0');
const p3 = (n: number) => n.toString().padStart(3, '0');

// Always H:MM:SS.t (hours included) so Excel reads it as a time straight away.
export function formatElapsedForSheet(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(Math.round(ms));
  const tenths = Math.floor(abs / 100) % 10;
  const totalSec = Math.floor(abs / 1000);
  const hrs = Math.floor(totalSec / 3600);
  return `${sign}${p2(hrs)}:${p2(Math.floor(totalSec / 60) % 60)}:${p2(totalSec % 60)}.${tenths}`;
}

// Local wall-clock time with milliseconds.
export function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

function statusOf(row: { voided?: number | boolean | null; duplicate_of?: string | null }): string {
  if (row.voided) return 'Removed';
  if (row.duplicate_of) return 'Duplicate';
  return '';
}

export const RAW_FIELDS = [
  'Entry',
  'Type',
  'Bib',
  'Name',
  'Finish time',
  'Time of day',
  'Recorded at (Unix ms)',
  'Race start',
  'Device',
  'Operator',
  'Mode',
  'Tap no.',
  'Status',
];

export function buildRawCsv({ race, taps, finishes, participants = [] }: RawExportInput): string {
  const start = typeof race?.start_time === 'number' ? race.start_time : null;
  const nameByBib = new Map<string, string>();
  const statusByBib = new Map<string, string>();
  for (const p of participants) {
    if (!p.bib_number) continue;
    const name = p.team_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (name) nameByBib.set(p.bib_number, name);
    if (p.status) statusByBib.set(p.bib_number, p.status.toUpperCase());
  }
  const tapSeq = new Map(taps.map((t) => [t.id, t.sequence_num ?? null]));

  interface Line {
    at: number;
    order: number;
    cells: (string | number)[];
  }
  const lines: Line[] = [];

  taps.forEach((t, i) => {
    const at = t.recorded_at;
    lines.push({
      at,
      order: i,
      cells: [
        'Tap',
        '',
        '',
        start !== null ? formatElapsedForSheet(at - start) : '',
        formatTimeOfDay(at),
        at,
        start !== null ? formatTimeOfDay(start) : '',
        (t.device_id ?? '').slice(0, 8),
        t.operator_name ?? '',
        t.is_manual ? 'Added on Results' : 'Timer',
        t.sequence_num ?? '',
        statusOf(t),
      ],
    });
  });

  finishes.forEach((f, i) => {
    // When the bib was typed. Older rows have no entered_at, so fall back to
    // their race time (the tap it was matched to, or when it was typed).
    const at = f.entered_at ?? (start !== null && f.gun_time != null ? start + f.gun_time : null);
    const status = [statusOf(f), statusByBib.get(f.bib_number) ? `Marked ${statusByBib.get(f.bib_number)}` : '']
      .filter(Boolean)
      .join(', ');
    lines.push({
      at: at ?? Number.MAX_SAFE_INTEGER,
      order: taps.length + i,
      cells: [
        'Bib',
        f.bib_number,
        nameByBib.get(f.bib_number) ?? '',
        f.gun_time != null ? formatElapsedForSheet(f.gun_time) : '',
        at !== null ? formatTimeOfDay(at) : '',
        at ?? '',
        start !== null ? formatTimeOfDay(start) : '',
        (f.device_id ?? '').slice(0, 8),
        f.operator_name ?? '',
        f.source === 'line' ? 'Finish line' : 'Funnel',
        f.timestamp_id ? (tapSeq.get(f.timestamp_id) ?? '') : '',
        status,
      ],
    });
  });

  lines.sort((a, b) => a.at - b.at || a.order - b.order);

  return Papa.unparse({
    fields: RAW_FIELDS,
    data: lines.map((l, i) => [i + 1, ...l.cells]),
  });
}

export function csvFileSlug(raceName: string | null | undefined): string {
  return (raceName ?? 'race').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'race';
}
