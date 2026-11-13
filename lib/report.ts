// Prize-giving report: top finishers by gender plus the first home in each
// age/gender category. Pure — takes the merged finisher list (lib/merge.ts
// computeFinishers) and the roster, returns plain data the screen renders.

import { formatGunTime } from './format';
import type { Participant } from './db';

// Local copy of db.participantDisplayName: importing the real one would drag
// expo-sqlite into this otherwise pure module (and into its unit tests).
function displayName(p: Pick<Participant, 'first_name' | 'last_name' | 'team_name'>): string {
  return p.team_name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown');
}

export type Gender = 'Male' | 'Female';

export function normalizeGender(raw: string | null | undefined): Gender | null {
  const g = (raw ?? '').trim().toLowerCase();
  if (!g) return null;
  if (['m', 'male', 'man', 'men', 'mens', "men's", 'boy', 'boys'].includes(g)) return 'Male';
  if (['f', 'female', 'woman', 'women', 'womens', "women's", 'w', 'girl', 'girls', 'lady', 'ladies'].includes(g)) {
    return 'Female';
  }
  return null;
}

// Category columns come in two flavours: "Senior Male"/"M40"/"Female U20"
// (gender already in the label) or a bare age band like "V40"/"U18". Prize
// categories are age *and* gender, so only prefix the gender when the label
// doesn't already say it — "Male M40" would just be noise.
const GENDER_IN_LABEL = /(^|[^a-z])(male|female|men|women|man|woman|mens|womens|boys?|girls?|ladies|lady)([^a-z]|$)|^(m|f|w)v?\s?\d/i;

export function categoryLabel(category: string | null | undefined, gender: Gender | null): string | null {
  const c = (category ?? '').trim();
  if (!c) return null;
  if (!gender || GENDER_IN_LABEL.test(c)) return c;
  return `${gender} ${c}`;
}

export interface RankedFinisher {
  overallPosition: number;
  bib: string;
  time: number; // ms
  timeLabel: string;
  name: string;
  club: string | null;
  gender: Gender | null;
  category: string | null; // as imported
  categoryLabel: string | null; // gender-qualified, used for grouping
}

export interface CategoryWinner {
  label: string;
  winner: RankedFinisher;
}

export interface PrizeReport {
  male: RankedFinisher[];
  female: RankedFinisher[];
  categories: CategoryWinner[];
  totalFinishers: number;
  duplicateBibs: string[]; // bibs entered more than once — only the earliest counts here
  notOnStartList: string[]; // bibs with no roster entry, so no gender/category to rank them by
  noGender: number; // finishers that can't be placed in a gender podium
}

export interface PrizeOptions {
  podium?: number; // how many to list per gender, default 3
  excludeOverallFromCategories?: boolean; // "no double prizes" — podium finishers skip category prizes
}

export function buildPrizeReport(
  finishers: { bib: string; time: number }[],
  participants: Participant[],
  options: PrizeOptions = {},
): PrizeReport {
  const podium = options.podium ?? 3;
  const byBib = new Map(participants.map((p) => [p.bib_number, p]));

  // Earliest result per bib wins; the rest are listed as duplicates so the
  // organiser knows to fix them before handing out a trophy.
  const seen = new Set<string>();
  const duplicateBibs = new Set<string>();
  const unique: { bib: string; time: number }[] = [];
  for (const f of [...finishers].sort((a, b) => a.time - b.time)) {
    if (seen.has(f.bib)) {
      duplicateBibs.add(f.bib);
      continue;
    }
    seen.add(f.bib);
    unique.push(f);
  }

  const notOnStartList: string[] = [];
  const ranked: RankedFinisher[] = unique.map((f, i) => {
    const p = byBib.get(f.bib);
    if (!p && participants.length > 0) notOnStartList.push(f.bib);
    const gender = normalizeGender(p?.gender);
    return {
      overallPosition: i + 1,
      bib: f.bib,
      time: f.time,
      timeLabel: formatGunTime(f.time),
      name: p ? displayName(p) : `Bib ${f.bib}`,
      club: p?.club ?? null,
      gender,
      category: p?.category ?? null,
      categoryLabel: categoryLabel(p?.category, gender),
    };
  });

  const male = ranked.filter((r) => r.gender === 'Male').slice(0, podium);
  const female = ranked.filter((r) => r.gender === 'Female').slice(0, podium);
  const podiumBibs = new Set([...male, ...female].map((r) => r.bib));

  const winners = new Map<string, RankedFinisher>();
  for (const r of ranked) {
    if (!r.categoryLabel || winners.has(r.categoryLabel)) continue;
    if (options.excludeOverallFromCategories && podiumBibs.has(r.bib)) continue;
    winners.set(r.categoryLabel, r);
  }
  const categories = [...winners.entries()]
    .map(([label, winner]) => ({ label, winner }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  return {
    male,
    female,
    categories,
    totalFinishers: ranked.length,
    duplicateBibs: [...duplicateBibs],
    notOnStartList,
    noGender: ranked.filter((r) => r.gender === null).length,
  };
}

// Plain-text version for the Share sheet (WhatsApp, email, notes).
export function reportToText(raceName: string, report: PrizeReport): string {
  const line = (r: RankedFinisher, place?: number) =>
    `${place ? `${place}. ` : ''}${r.name}${r.club ? ` (${r.club})` : ''} - #${r.bib} - ${r.timeLabel}`;
  const out: string[] = [`${raceName} - prize giving`, ''];
  const section = (title: string, rows: RankedFinisher[]) => {
    out.push(title);
    if (rows.length === 0) out.push('  (none)');
    rows.forEach((r, i) => out.push(`  ${line(r, i + 1)}`));
    out.push('');
  };
  section('Overall male', report.male);
  section('Overall female', report.female);
  out.push('Category winners');
  if (report.categories.length === 0) out.push('  (no categories on the start list)');
  for (const c of report.categories) out.push(`  ${c.label}: ${line(c.winner)}`);
  return out.join('\n');
}
