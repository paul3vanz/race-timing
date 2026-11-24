import Papa from 'papaparse';

import { buildRawCsv, formatElapsedForSheet } from './raw-export';

const START = new Date(2026, 10, 22, 10, 0, 0, 0).getTime(); // 10:00:00 local

const rows = (csv: string) => Papa.parse<Record<string, string>>(csv, { header: true }).data;

describe('raw data export', () => {
  test('formats finish times with hours so a spreadsheet reads them as times', () => {
    expect(formatElapsedForSheet(0)).toBe('00:00:00.0');
    expect(formatElapsedForSheet(23 * 60_000 + 45_678)).toBe('00:23:45.6');
    expect(formatElapsedForSheet(3_723_400)).toBe('01:02:03.4');
  });

  test('a Timer-only phone exports its taps with finish times and no bibs needed', () => {
    const csv = buildRawCsv({
      race: { name: 'Croome', start_time: START },
      taps: [
        { id: 't2', recorded_at: START + 20_000, device_id: 'timer-aaaaaaaa', sequence_num: 2, operator_name: 'Jo Bloggs' },
        { id: 't1', recorded_at: START + 10_500, device_id: 'timer-aaaaaaaa', sequence_num: 1, operator_name: 'Jo Bloggs' },
      ],
      finishes: [],
    });
    const out = rows(csv);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      Entry: '1',
      Type: 'Tap',
      'Finish time': '00:00:10.5',
      'Time of day': '10:00:10.500',
      'Race start': '10:00:00.000',
      Operator: 'Jo Bloggs',
      'Tap no.': '1',
    });
    expect(out[1]['Finish time']).toBe('00:00:20.0');
  });

  test('taps and bibs interleave in the order they were entered, removed rows are kept and marked', () => {
    const csv = buildRawCsv({
      race: { name: 'R', start_time: START },
      taps: [{ id: 't1', recorded_at: START + 10_000, sequence_num: 1, voided: 1 }],
      finishes: [
        { id: 'f1', bib_number: '042', timestamp_id: 't1', gun_time: 10_000, entered_at: START + 15_000 },
        // Older row with no entered_at falls back to its race time.
        { id: 'f0', bib_number: '7', gun_time: 5_000 },
      ],
      participants: [{ bib_number: '042', first_name: 'Ann', last_name: 'Lee', status: 'dnf' }],
    });
    const out = rows(csv);
    expect(out.map((r) => `${r.Type}:${r.Bib}`)).toEqual(['Bib:7', 'Tap:', 'Bib:042']);
    expect(out[1].Status).toBe('Removed');
    expect(out[2]).toMatchObject({ Name: 'Ann Lee', 'Tap no.': '1', Status: 'Marked DNF', Mode: 'Funnel' });
  });

  test('exports with no race start time rather than failing', () => {
    const csv = buildRawCsv({
      race: null,
      taps: [{ id: 't1', recorded_at: START }],
      finishes: [{ id: 'f1', bib_number: '1' }],
    });
    const out = rows(csv);
    expect(out).toHaveLength(2);
    expect(out[0]['Finish time']).toBe('');
  });
});
