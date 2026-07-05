import {
  alignFinishers,
  clusterBibEntries,
  clusterTimerTaps,
  type RawBibEntry,
  type RawTap,
} from './reconcile';

const DELAY_MS = 3000; // typical bib-typed-after-tap lag used across fixtures

// N clean finishers, N seconds apart, one tap per device per finisher and one
// bib entry per finisher typed DELAY_MS after its tap.
function cleanTaps(n: number, deviceId = 'timer-a'): RawTap[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tap-${i}`,
    deviceId,
    time: (i + 1) * 10_000,
  }));
}

function cleanBibs(n: number, deviceId = 'bib-a'): RawBibEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `bib-${i}`,
    deviceId,
    bibNumber: String(i + 1),
    time: (i + 1) * 10_000 + DELAY_MS,
  }));
}

describe('clusterTimerTaps', () => {
  test('single device: every tap stays its own canonical event', () => {
    const clusters = clusterTimerTaps(cleanTaps(10));
    expect(clusters).toHaveLength(10);
    expect(clusters.every((c) => c.corroboration === 1)).toBe(true);
  });

  test('two-device corroboration with a backup joining partway through', () => {
    const primary = cleanTaps(10, 'timer-a');
    // Backup only starts at event 6 (index 5), tapping each remaining event
    // ~400ms after the primary — comfortably inside the clustering window.
    const backup: RawTap[] = primary.slice(5).map((t, i) => ({
      id: `backup-tap-${i}`,
      deviceId: 'timer-b',
      time: t.time + 400,
    }));

    const clusters = clusterTimerTaps([...primary, ...backup]);
    expect(clusters).toHaveLength(10);
    expect(clusters.slice(0, 5).every((c) => c.corroboration === 1)).toBe(true);
    expect(clusters.slice(5).every((c) => c.corroboration === 2)).toBe(true);
    expect(clusters[5].sourceIds).toEqual(expect.arrayContaining(['tap-5', 'backup-tap-0']));
  });

  test('a burst of same-device double-clicks stays un-clustered (phase 2 resolves it)', () => {
    const taps = cleanTaps(10);
    const idx = 5;
    // 4 extra spurious taps from the SAME device, all within a couple hundred
    // ms of the real one — clustering must not merge same-device taps, since
    // corroboration is specifically about distinct devices agreeing.
    const extras: RawTap[] = [1, 2, 3, 4].map((k) => ({
      id: `double-${k}`,
      deviceId: 'timer-a',
      time: taps[idx].time + k * 150,
    }));

    const clusters = clusterTimerTaps([...taps, ...extras]);
    // 9 untouched events + 5 separate clusters around the double-clicked one.
    expect(clusters).toHaveLength(14);
    expect(clusters.every((c) => c.corroboration === 1)).toBe(true);
  });
});

describe('clusterBibEntries', () => {
  test('single device: no disagreement', () => {
    const clusters = clusterBibEntries(cleanBibs(5));
    expect(clusters).toHaveLength(5);
    expect(clusters.every((c) => c.disagreement === null)).toBe(true);
  });

  test('two devices agreeing on the same bib corroborate one entry', () => {
    const primary = cleanBibs(5, 'bib-a');
    const backup: RawBibEntry[] = primary.map((b, i) => ({
      id: `backup-bib-${i}`,
      deviceId: 'bib-b',
      bibNumber: b.bibNumber,
      time: b.time + 600,
    }));
    const clusters = clusterBibEntries([...primary, ...backup]);
    expect(clusters).toHaveLength(5);
    expect(clusters.every((c) => c.corroboration === 2 && c.disagreement === null)).toBe(true);
  });

  test('two devices disagreeing on the digits surfaces as a disagreement, not a silent vote', () => {
    const entryA: RawBibEntry = { id: 'a1', deviceId: 'bib-a', bibNumber: '42', time: 10_000 };
    const entryB: RawBibEntry = { id: 'b1', deviceId: 'bib-b', bibNumber: '24', time: 10_500 };

    const clusters = clusterBibEntries([entryA, entryB]);
    expect(clusters).toHaveLength(1);
    const [cluster] = clusters;
    // Tie-broken to whichever was reported first.
    expect(cluster.bibNumber).toBe('42');
    expect(cluster.corroboration).toBe(1);
    expect(cluster.disagreement).toEqual([{ bibNumber: '24', sourceIds: ['b1'] }]);
  });
});

describe('alignFinishers', () => {
  test('clean 1:1 alignment matches every finisher in order, nothing flagged', () => {
    const taps = clusterTimerTaps(cleanTaps(10));
    const bibs = clusterBibEntries(cleanBibs(10));

    const { pairs, unmatchedTaps, unmatchedBibs } = alignFinishers(taps, bibs);

    expect(unmatchedTaps).toHaveLength(0);
    expect(unmatchedBibs).toHaveLength(0);
    expect(pairs).toHaveLength(10);
    pairs.forEach((pair, i) => {
      expect(pair.bib.bibNumber).toBe(String(i + 1));
      expect(pair.flagged).toBe(false);
    });
  });

  test('a single missed tap leaves one unmatched bib without disturbing its neighbours', () => {
    const rawTaps = cleanTaps(10).filter((_, i) => i !== 4); // Timer missed finisher #5
    const taps = clusterTimerTaps(rawTaps);
    const bibs = clusterBibEntries(cleanBibs(10));

    const { pairs, unmatchedTaps, unmatchedBibs } = alignFinishers(taps, bibs);

    expect(unmatchedTaps).toHaveLength(0);
    expect(unmatchedBibs).toHaveLength(1);
    expect(unmatchedBibs[0].bibNumber).toBe('5');
    expect(pairs).toHaveLength(9);
    // Neighbours on either side of the gap must still be correctly paired,
    // not shifted by the missing entry.
    const byBib = new Map(pairs.map((p) => [p.bib.bibNumber, p]));
    expect(byBib.get('4')!.tap.time).toBe(4 * 10_000);
    expect(byBib.get('6')!.tap.time).toBe(6 * 10_000);
    expect(pairs.every((p) => !p.flagged)).toBe(true);
  });

  test('a single double-click leaves one unmatched tap without disturbing its neighbours', () => {
    const taps = cleanTaps(10);
    const extra: RawTap = { id: 'double', deviceId: 'timer-a', time: taps[4].time + 200 };
    const canonicalTaps = clusterTimerTaps([...taps, extra]);
    const bibs = clusterBibEntries(cleanBibs(10));

    const { pairs, unmatchedTaps, unmatchedBibs } = alignFinishers(canonicalTaps, bibs);

    expect(unmatchedBibs).toHaveLength(0);
    expect(unmatchedTaps).toHaveLength(1);
    expect(pairs).toHaveLength(10);
    const byBib = new Map(pairs.map((p) => [p.bib.bibNumber, p]));
    expect(byBib.get('6')!.tap.time).toBe(6 * 10_000);
  });

  test('a burst of consecutive misses is one gap, not a cascade of bad matches', () => {
    const missingIdx = [4, 5, 6, 7, 8]; // finishers 5-9 (0-indexed 4-8) never tapped
    const rawTaps = cleanTaps(20).filter((_, i) => !missingIdx.includes(i));
    const taps = clusterTimerTaps(rawTaps);
    const bibs = clusterBibEntries(cleanBibs(20));

    const { pairs, unmatchedBibs } = alignFinishers(taps, bibs);

    expect(unmatchedBibs.map((b) => b.bibNumber).sort()).toEqual(['5', '6', '7', '8', '9']);
    expect(pairs).toHaveLength(15);
    const byBib = new Map(pairs.map((p) => [p.bib.bibNumber, p]));
    // Finisher #10 (first one after the gap) must still land on its own tap,
    // not get dragged backwards into the gap.
    expect(byBib.get('10')!.tap.time).toBe(10 * 10_000);
    expect(pairs.every((p) => !p.flagged)).toBe(true);
  });

  test('a burst of double-clicks on one finisher leaves the rest untouched', () => {
    const taps = cleanTaps(20);
    const idx = 9; // finisher #10
    const extras: RawTap[] = [1, 2, 3, 4].map((k) => ({
      id: `double-${k}`,
      deviceId: 'timer-a',
      time: taps[idx].time + k * 150,
    }));
    const canonicalTaps = clusterTimerTaps([...taps, ...extras]);
    const bibs = clusterBibEntries(cleanBibs(20));

    const { pairs, unmatchedTaps, unmatchedBibs } = alignFinishers(canonicalTaps, bibs);

    expect(unmatchedBibs).toHaveLength(0);
    expect(unmatchedTaps).toHaveLength(4);
    expect(pairs).toHaveLength(20);
    const byBib = new Map(pairs.map((p) => [p.bib.bibNumber, p]));
    expect(byBib.get('10')!.tap.time).toBe(taps[idx].time);
    expect(byBib.get('11')!.tap.time).toBe(taps[10].time);
  });

  test('corroborated pairs from a backup device stay confident, uncorroborated singles behave as today', () => {
    const primary = cleanTaps(10, 'timer-a');
    const backup: RawTap[] = primary.slice(5).map((t, i) => ({
      id: `backup-tap-${i}`,
      deviceId: 'timer-b',
      time: t.time + 400,
    }));
    const taps = clusterTimerTaps([...primary, ...backup]);
    const bibs = clusterBibEntries(cleanBibs(10));

    const { pairs } = alignFinishers(taps, bibs);

    expect(pairs).toHaveLength(10);
    expect(pairs.every((p) => !p.flagged)).toBe(true);
    const byBib = new Map(pairs.map((p) => [p.bib.bibNumber, p]));
    expect(byBib.get('3')!.tap.corroboration).toBe(1);
    expect(byBib.get('8')!.tap.corroboration).toBe(2);
  });
});
