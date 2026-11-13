import type { Participant } from './db';
import { buildPrizeReport, categoryLabel, normalizeGender, reportToText } from './report';

function p(bib: string, gender: string | null, category: string | null, extra: Partial<Participant> = {}): Participant {
  return {
    id: `p-${bib}`,
    race_id: 'r',
    bib_number: bib,
    first_name: `F${bib}`,
    last_name: `L${bib}`,
    gender,
    dob: null,
    club: null,
    category,
    team_name: null,
    sub_category: null,
    synced: 1,
    ...extra,
  };
}

describe('normalizeGender', () => {
  test.each([
    ['M', 'Male'],
    ['male', 'Male'],
    [' Men ', 'Male'],
    ['F', 'Female'],
    ['Female', 'Female'],
    ['W', 'Female'],
    ['', null],
    [null, null],
    ['X', null],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeGender(raw as string | null)).toBe(expected);
  });
});

describe('categoryLabel', () => {
  test('prefixes the gender onto a bare age band', () => {
    expect(categoryLabel('V40', 'Male')).toBe('Male V40');
    expect(categoryLabel('U18', 'Female')).toBe('Female U18');
  });
  test('leaves labels that already carry the gender alone', () => {
    expect(categoryLabel('Senior Male', 'Male')).toBe('Senior Male');
    expect(categoryLabel('M40', 'Male')).toBe('M40');
    expect(categoryLabel('MV40', 'Male')).toBe('MV40');
    expect(categoryLabel('Female U20', 'Female')).toBe('Female U20');
  });
  test('a category that merely starts with M or F is not mistaken for a gender', () => {
    expect(categoryLabel('Masters 40', 'Female')).toBe('Female Masters 40');
  });
  test('no category means no category prize; no gender keeps the label as is', () => {
    expect(categoryLabel('', 'Male')).toBeNull();
    expect(categoryLabel(null, 'Male')).toBeNull();
    expect(categoryLabel('V40', null)).toBe('V40');
  });
});

describe('buildPrizeReport', () => {
  const roster = [
    p('1', 'M', 'V40'),
    p('2', 'F', 'V40'),
    p('3', 'M', 'Senior'),
    p('4', 'M', 'V40'),
    p('5', 'F', 'Senior'),
    p('6', 'M', 'V40'),
    p('7', 'F', 'V40'),
    p('8', 'M', 'Senior'),
    p('9', 'F', 'V40'),
  ];
  // finishing order 1..9 by bib, 60s apart
  const finishers = roster.map((r, i) => ({ bib: r.bib_number, time: (i + 1) * 60_000 }));

  test('top three of each gender, in finishing order', () => {
    const r = buildPrizeReport(finishers, roster);
    expect(r.male.map((x) => x.bib)).toEqual(['1', '3', '4']);
    expect(r.female.map((x) => x.bib)).toEqual(['2', '5', '7']);
    expect(r.male[0].overallPosition).toBe(1);
    expect(r.female[1].overallPosition).toBe(5);
    expect(r.male[0].timeLabel).toBe('01:00');
  });

  test('first in each gender-qualified category', () => {
    const r = buildPrizeReport(finishers, roster);
    const winners = Object.fromEntries(r.categories.map((c) => [c.label, c.winner.bib]));
    expect(winners).toEqual({
      'Female Senior': '5',
      'Female V40': '2',
      'Male Senior': '3',
      'Male V40': '1',
    });
  });

  test('"no double prizes" gives the category to the next finisher', () => {
    const r = buildPrizeReport(finishers, roster, { excludeOverallFromCategories: true });
    const winners = Object.fromEntries(r.categories.map((c) => [c.label, c.winner.bib]));
    // 1,3,4 are the male podium and 2,5,7 the female one, so category wins pass down.
    expect(winners['Male V40']).toBe('6');
    expect(winners['Male Senior']).toBe('8');
    expect(winners['Female V40']).toBe('9');
    expect(winners['Female Senior']).toBeUndefined();
  });

  test('a bib entered twice only counts once and is reported', () => {
    const r = buildPrizeReport([...finishers, { bib: '1', time: 999_000 }], roster);
    expect(r.duplicateBibs).toEqual(['1']);
    expect(r.totalFinishers).toBe(9);
  });

  test('bibs missing from the roster are reported and kept out of the podiums', () => {
    const r = buildPrizeReport([{ bib: '999', time: 1_000 }, ...finishers], roster);
    expect(r.notOnStartList).toEqual(['999']);
    expect(r.male[0].bib).toBe('1');
    expect(r.noGender).toBe(1);
  });

  test('team entries without a gender never take a gender podium place', () => {
    const team = p('50', null, 'Team', { first_name: null, last_name: null, team_name: 'The Wild Ones' });
    const r = buildPrizeReport([{ bib: '50', time: 1_000 }, ...finishers], [...roster, team]);
    expect(r.male[0].bib).toBe('1');
    expect(r.categories.find((c) => c.label === 'Team')?.winner.name).toBe('The Wild Ones');
  });

  test('text export lists podiums and category winners', () => {
    const text = reportToText('Test 10k', buildPrizeReport(finishers, roster));
    expect(text).toContain('Test 10k - prize giving');
    expect(text).toContain('1. F1 L1 - #1 - 01:00');
    expect(text).toContain('Male V40: F1 L1');
    expect(text).not.toContain('—');
  });
});
