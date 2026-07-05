import Papa from 'papaparse';

// ── Parsing ───────────────────────────────────────────────────────────────────

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return { headers: result.meta.fields ?? [], rows: result.data };
}

// ── Column mapping ────────────────────────────────────────────────────────────

export type ParticipantField =
  | 'bibNumber'
  | 'firstName'
  | 'surname'
  | 'fullName'
  | 'teamName'
  | 'subCategory'
  | 'club'
  | 'category'
  | 'gender'
  | 'dob';

// Value is the source CSV header name, or null if unmapped.
export type ColumnMapping = Record<ParticipantField, string | null>;

export const EMPTY_MAPPING: ColumnMapping = {
  bibNumber: null,
  firstName: null,
  surname: null,
  fullName: null,
  teamName: null,
  subCategory: null,
  club: null,
  category: null,
  gender: null,
  dob: null,
};

export const FIELD_LABELS: Record<ParticipantField, string> = {
  bibNumber: 'Bib Number',
  firstName: 'First Name',
  surname: 'Surname',
  fullName: 'Full Name',
  teamName: 'Team Name',
  subCategory: 'Sub-Category (e.g. Solo/Pair/Team)',
  club: 'Club',
  category: 'Category',
  gender: 'Gender',
  dob: 'Date of Birth',
};

const GUESS_PATTERNS: Record<ParticipantField, RegExp[]> = {
  bibNumber: [/^bib/i, /race ?no/i, /^no\.?$/i, /number/i],
  firstName: [/^first ?name$/i, /given ?name/i, /forename/i],
  surname: [/^sur ?name$/i, /last ?name/i, /family ?name/i],
  fullName: [/^full ?name$/i, /^name$/i, /participant ?name/i, /athlete ?name/i, /runner ?name/i],
  teamName: [/^team( ?name)?$/i, /relay ?team/i, /group ?name/i],
  subCategory: [/sub.?categor/i, /entry.?type/i, /^division$/i, /^format$/i],
  club: [/^club$/i, /affiliation/i],
  category: [/categor/i, /^class$/i, /age ?group/i],
  gender: [/gender/i, /^sex$/i],
  dob: [/dob/i, /date ?of ?birth/i, /birth ?date/i],
};

// Best-effort auto-mapping from common header names, so the user usually only
// has to fix a couple of fields rather than map every column by hand.
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = { ...EMPTY_MAPPING };
  const used = new Set<string>();

  (Object.keys(GUESS_PATTERNS) as ParticipantField[]).forEach((field) => {
    const match = headers.find(
      (h) => !used.has(h) && GUESS_PATTERNS[field].some((pattern) => pattern.test(h)),
    );
    if (match) {
      mapping[field] = match;
      used.add(match);
    }
  });

  // Prefer split first/surname over a guessed full-name column if both matched.
  if (mapping.firstName && mapping.surname) mapping.fullName = null;

  return mapping;
}

// ── Building participants ─────────────────────────────────────────────────────

export interface ImportOptions {
  autoAssignBib: boolean;
  startNumber: number; // only used when autoAssignBib is true
}

export interface BuiltParticipant {
  bib_number: string;
  first_name: string | null;
  last_name: string | null;
  club: string | null;
  category: string | null;
  gender: string | null;
  dob: string | null;
  team_name: string | null;
  sub_category: string | null;
}

export interface BuildResult {
  participants: BuiltParticipant[];
  skippedNoBib: number; // rows dropped for having no usable bib number
  skippedNoIdentity: number; // rows dropped for having neither a name nor a team
}

function cell(row: Record<string, string>, column: string | null): string | null {
  if (!column) return null;
  const value = row[column];
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// Heuristic split for a single combined "Name" column: first word is the
// first name, everything else is the surname (handles multi-part surnames
// better than the reverse). Ambiguous for single-word entries, which land
// entirely in first_name.
function splitFullName(full: string): { first: string; last: string | null } {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: full, last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function personFields(
  row: Record<string, string>,
  mapping: ColumnMapping,
): { first_name: string | null; last_name: string | null } {
  const first = cell(row, mapping.firstName);
  const last = cell(row, mapping.surname);
  if (first || last) return { first_name: first, last_name: last };

  const full = cell(row, mapping.fullName);
  if (!full) return { first_name: null, last_name: null };
  const split = splitFullName(full);
  return { first_name: split.first, last_name: split.last };
}

// Sub-category first (so bibs come out in contiguous per-group blocks —
// e.g. all Solo entries, then all Pair, then all Team), then surname-first,
// then first-name within each group. Team entries (no personal name) sort
// by team name in the surname slot. Rows with no sub-category mapped all
// share the same (empty) group, so this is a no-op when it isn't used.
function sortKey(row: Record<string, string>, mapping: ColumnMapping): [string, string, string] {
  const { first_name, last_name } = personFields(row, mapping);
  const team = cell(row, mapping.teamName) ?? '';
  const primary = last_name || team;
  const subCategory = cell(row, mapping.subCategory) ?? '';
  return [subCategory.toLowerCase(), (primary ?? '').toLowerCase(), (first_name ?? '').toLowerCase()];
}

export function buildParticipants(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  options: ImportOptions,
): BuildResult {
  let ordered = rows;
  if (options.autoAssignBib) {
    ordered = [...rows].sort((a, b) => {
      const [aSub, aSurname, aFirst] = sortKey(a, mapping);
      const [bSub, bSurname, bFirst] = sortKey(b, mapping);
      return (
        aSub.localeCompare(bSub) || aSurname.localeCompare(bSurname) || aFirst.localeCompare(bFirst)
      );
    });
  }

  const participants: BuiltParticipant[] = [];
  let skippedNoBib = 0;
  let skippedNoIdentity = 0;
  let nextBib = options.startNumber;

  for (const row of ordered) {
    const bib = options.autoAssignBib ? String(nextBib) : cell(row, mapping.bibNumber);
    if (!bib) {
      skippedNoBib++;
      continue;
    }

    const { first_name, last_name } = personFields(row, mapping);
    const team_name = cell(row, mapping.teamName);
    if (!first_name && !last_name && !team_name) {
      skippedNoIdentity++;
      continue;
    }

    if (options.autoAssignBib) nextBib++;

    participants.push({
      bib_number: bib,
      first_name,
      last_name,
      club: cell(row, mapping.club),
      category: cell(row, mapping.category),
      gender: cell(row, mapping.gender),
      dob: cell(row, mapping.dob),
      team_name,
      sub_category: cell(row, mapping.subCategory),
    });
  }

  return { participants, skippedNoBib, skippedNoIdentity };
}

export function maxBibNumber(participants: BuiltParticipant[]): number {
  let max = 0;
  for (const p of participants) {
    const n = parseInt(p.bib_number, 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max;
}
