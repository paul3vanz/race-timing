// Checks a bib the funnel recorder has just typed against the start list and
// the results so far, so a likely mistake can be caught while the runner is
// still in the funnel rather than untangled afterwards. Pure, for testing.

import type { Finish, Participant, RaceFormat } from './db';
import { isActiveFinish } from './merge';

export type BibIssue =
  | { kind: 'dns'; bib: string; name: string | null }
  | { kind: 'dnf'; bib: string; name: string | null }
  | { kind: 'unknown'; bib: string }
  | { kind: 'repeat'; bib: string; name: string | null; earlier: Finish };

function nameOf(p: Participant | undefined): string | null {
  if (!p) return null;
  return p.team_name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null);
}

// `finishes` are the entries *before* this one; `excludeId` lets a caller
// check an entry that has already been saved without it matching itself.
export function checkBibEntry(input: {
  bib: string;
  participants: Participant[];
  finishes: Finish[];
  format: RaceFormat;
  excludeId?: string;
}): BibIssue[] {
  const { bib, participants, finishes, format, excludeId } = input;
  const issues: BibIssue[] = [];
  const participant = participants.find((p) => p.bib_number === bib);

  if (participant?.status === 'dns') issues.push({ kind: 'dns', bib, name: nameOf(participant) });
  else if (participant?.status === 'dnf') issues.push({ kind: 'dnf', bib, name: nameOf(participant) });
  else if (participants.length > 0 && !participant) issues.push({ kind: 'unknown', bib });

  if (format !== 'laps') {
    const earlier = finishes.find(
      (f) => f.id !== excludeId && isActiveFinish(f) && f.source !== 'line' && f.bib_number === bib,
    );
    if (earlier) issues.push({ kind: 'repeat', bib, name: nameOf(participant), earlier });
  }
  return issues;
}
