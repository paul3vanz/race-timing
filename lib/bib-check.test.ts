import { checkBibEntry } from './bib-check';
import type { Finish, Participant } from './db';

function runner(bib: string, status: Participant['status'] = null): Participant {
  return {
    id: `p-${bib}`,
    race_id: 'r',
    bib_number: bib,
    first_name: 'Runner',
    last_name: bib,
    gender: null,
    dob: null,
    club: null,
    category: null,
    team_name: null,
    sub_category: null,
    status,
    synced: 1,
  };
}

function finish(id: string, bib: string, extra: Partial<Finish> = {}): Finish {
  return {
    id,
    race_id: 'r',
    bib_number: bib,
    timestamp_id: null,
    gun_time: 60_000,
    chip_time: null,
    device_id: 'bib',
    flagged: 0,
    duplicate_of: null,
    voided: 0,
    source: 'funnel',
    entered_at: null,
    operator_name: null,
    synced: 0,
    ...extra,
  };
}

const roster = [runner('1'), runner('2', 'dns'), runner('3', 'dnf')];

describe('checking a bib typed in the funnel', () => {
  test('an expected bib passes', () => {
    expect(checkBibEntry({ bib: '1', participants: roster, finishes: [], format: 'single' })).toEqual([]);
  });

  test('DNS, DNF and unknown bibs are raised', () => {
    const kinds = (bib: string) =>
      checkBibEntry({ bib, participants: roster, finishes: [], format: 'single' }).map((i) => i.kind);
    expect(kinds('2')).toEqual(['dns']);
    expect(kinds('3')).toEqual(['dnf']);
    expect(kinds('99')).toEqual(['unknown']);
  });

  test('with no start list loaded, no bib is unknown', () => {
    expect(checkBibEntry({ bib: '99', participants: [], finishes: [], format: 'single' })).toEqual([]);
  });

  test('a repeat in a single-lap race is raised, in a lapped race it is the next lap', () => {
    const finishes = [finish('f1', '1')];
    expect(
      checkBibEntry({ bib: '1', participants: roster, finishes, format: 'single' }).map((i) => i.kind),
    ).toEqual(['repeat']);
    expect(checkBibEntry({ bib: '1', participants: roster, finishes, format: 'laps' })).toEqual([]);
  });

  test('removed entries and finish-line evidence are not repeats', () => {
    const finishes = [finish('f1', '1', { voided: 1 }), finish('f2', '1', { source: 'line' })];
    expect(checkBibEntry({ bib: '1', participants: roster, finishes, format: 'single' })).toEqual([]);
  });
});
