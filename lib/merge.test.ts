import type { Finish, Participant, Timestamp } from './db';
import {
  buildQueue,
  buildResultsView,
  planRelinkInOrder,
  buildModel,
} from './merge';

const START = 1_000_000;

let seq = 0;
function tap(device: string, offsetMs: number, extra: Partial<Timestamp> = {}): Timestamp {
  seq += 1;
  return {
    id: `${device}-${seq}`,
    race_id: 'r',
    recorded_at: START + offsetMs,
    device_id: device,
    sequence_num: seq,
    voided: 0,
    is_manual: 0,
    duplicate_of: null,
    synced: 0,
    ...extra,
  };
}

function finish(bib: string, timestampId: string | null, gunTime: number, extra: Partial<Finish> = {}): Finish {
  seq += 1;
  return {
    id: `f-${seq}`,
    race_id: 'r',
    bib_number: bib,
    timestamp_id: timestampId,
    gun_time: gunTime,
    chip_time: null,
    device_id: 'bib',
    flagged: 0,
    duplicate_of: null,
    voided: 0,
    synced: 0,
    ...extra,
  };
}

function runner(bib: string, extra: Partial<Participant> = {}): Participant {
  return {
    id: `p-${bib}`,
    race_id: 'r',
    bib_number: bib,
    first_name: `Runner${bib}`,
    last_name: null,
    gender: null,
    dob: null,
    club: null,
    category: null,
    team_name: null,
    sub_category: null,
    synced: 1,
    ...extra,
  };
}

// N finishers 10s apart; two Timers, B always ~300ms behind A.
function twoTimerRace(n: number): { a: Timestamp[]; b: Timestamp[] } {
  const a = Array.from({ length: n }, (_, i) => tap('timer-a', (i + 1) * 10_000));
  const b = Array.from({ length: n }, (_, i) => tap('timer-b', (i + 1) * 10_000 + 300));
  return { a, b };
}

const view = (taps: Timestamp[], finishes: Finish[], participants: Participant[] = []) =>
  buildResultsView({ taps, finishes, participants, startTime: START, thisDeviceId: 'bib' });

describe('Bib queue across two Timers', () => {
  test('two Timers tapping the same finishers produce one queue entry each, not two', () => {
    const { a, b } = twoTimerRace(5);
    const queue = buildQueue([...a, ...b], []);
    expect(queue).toHaveLength(5);
    expect(queue.map((q) => q.position)).toEqual([1, 2, 3, 4, 5]);
    expect(queue.every((q) => q.deviceIds.length === 2)).toBe(true);
  });

  test('typing a bib removes that finisher from the queue even if the other Timer taps arrive later', () => {
    const { a, b } = twoTimerRace(3);
    const first = finish('101', a[0].id, 10_000);
    // Timer B's taps only reach this device after the bib was already typed.
    const early = buildQueue(a, [first]);
    expect(early.map((q) => q.position)).toEqual([2, 3]);
    const late = buildQueue([...a, ...b], [first]);
    expect(late.map((q) => q.position)).toEqual([2, 3]);
  });

  test('a bib linked via either Timer’s tap counts as assigned', () => {
    const { a, b } = twoTimerRace(3);
    const linkedViaB = finish('101', b[0].id, 10_300);
    expect(buildQueue([...a, ...b], [linkedViaB]).map((q) => q.position)).toEqual([2, 3]);
  });

  test('removing a bib entry puts its finisher back in the queue', () => {
    const { a, b } = twoTimerRace(3);
    const f = finish('101', a[0].id, 10_000, { voided: 1 });
    expect(buildQueue([...a, ...b], [f]).map((q) => q.position)).toEqual([1, 2, 3]);
  });

  test('a discarded tap leaves the queue', () => {
    const a = [tap('timer-a', 10_000), tap('timer-a', 10_200, { voided: 1 }), tap('timer-a', 20_000)];
    expect(buildQueue(a, [])).toHaveLength(2);
  });
});

describe('Results across devices', () => {
  test('two Timers + one Bib device give one row per finisher with the averaged time', () => {
    const { a, b } = twoTimerRace(3);
    const finishes = [
      finish('11', a[0].id, 10_150),
      finish('12', a[1].id, 20_150),
      finish('13', a[2].id, 30_150),
    ];
    const v = view([...a, ...b], finishes);
    const rows = v.rows.filter((r) => r.kind === 'finisher');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
    // Median of 10_000 and 10_300.
    expect(rows[0].kind === 'finisher' && rows[0].time).toBe(10_150);
    expect(v.finishers.map((f) => f.bib)).toEqual(['11', '12', '13']);
    expect(v.needsReview).toBe(0);
  });

  test('a click one Timer missed is flagged against that Timer', () => {
    const { a, b } = twoTimerRace(5);
    const bMissing = b.filter((_, i) => i !== 2); // Timer B missed finisher #3
    const finishes = a.map((t, i) => finish(String(100 + i), t.id, (i + 1) * 10_000));
    const v = view([...a, ...bMissing], finishes);

    const flagged = v.rows.filter((r) => r.kind === 'finisher' && r.flags.missingTimers.length > 0);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].kind === 'finisher' && flagged[0].position).toBe(3);
    expect(flagged[0].kind === 'finisher' && flagged[0].flags.missingTimers).toEqual(['T2']);

    const timerB = v.devices.find((d) => d.label.short === 'T2');
    expect(timerB?.missed).toBe(1);
    expect(v.needsReview).toBe(1);
  });

  test('a backup Timer that starts late does not make the earlier finishers look missed', () => {
    const { a, b } = twoTimerRace(40);
    const lateB = b.slice(30); // joins at finisher #31 (5 minutes in)
    const finishes = a.map((t, i) => finish(String(100 + i), t.id, (i + 1) * 10_000));
    const v = view([...a, ...lateB], finishes);
    expect(v.rows.filter((r) => r.kind === 'finisher' && r.flags.missingTimers.length > 0)).toHaveLength(0);
  });

  test('an extra tap from one Timer shows as a tap with no bib, and flags the Timer that did not tap', () => {
    const { a, b } = twoTimerRace(4);
    const phantom = tap('timer-a', 25_000); // stray press between finishers 2 and 3
    const finishes = [0, 1, 2, 3].map((i) => finish(String(100 + i), a[i].id, (i + 1) * 10_000));
    const v = view([...a, phantom, ...b], finishes);
    const gap = v.rows.find((r) => r.kind === 'gap-tap');
    expect(gap).toBeDefined();
    expect(gap?.kind === 'gap-tap' && gap.missingTimers).toEqual(['T2']);
  });

  test('the same bib typed twice is flagged on both rows, and editing one clears it', () => {
    const { a, b } = twoTimerRace(3);
    const finishes = [finish('123', a[0].id, 10_000), finish('456', a[1].id, 20_000), finish('123', a[2].id, 30_000)];
    const before = view([...a, ...b], finishes);
    const dups = before.rows.filter((r) => r.kind === 'finisher' && r.flags.dupBib);
    expect(dups).toHaveLength(2);
    expect(before.duplicateBibs).toEqual(['123']);

    // Operator fixes the transposed one on the Results screen.
    const fixed = finishes.map((f, i) => (i === 2 ? { ...f, bib_number: '132' } : f));
    const after = view([...a, ...b], fixed);
    expect(after.duplicateBibs).toEqual([]);
    expect(after.rows.filter((r) => r.kind === 'finisher' && r.flags.dupBib)).toHaveLength(0);
  });

  test('a bib that is not on the start list is flagged (usually a typo)', () => {
    const { a, b } = twoTimerRace(2);
    const finishes = [finish('101', a[0].id, 10_000), finish('199', a[1].id, 20_000)];
    const v = view([...a, ...b], finishes, [runner('101'), runner('102')]);
    const rows = v.rows.filter((r) => r.kind === 'finisher');
    expect(rows[0].kind === 'finisher' && rows[0].flags.unknownBib).toBe(false);
    expect(rows[1].kind === 'finisher' && rows[1].flags.unknownBib).toBe(true);
    expect(rows[0].kind === 'finisher' && rows[0].name).toBe('Runner101');
  });

  test('a bib-only race (no Timer taps) lists its entries as ordinary results', () => {
    const finishes = [finish('7', null, 61_000, { device_id: 'solo' }), finish('9', null, 65_000, { device_id: 'solo' })];
    const v = view([], finishes);
    expect(v.rows.map((r) => r.kind)).toEqual(['finisher', 'finisher']);
    expect(v.finishers.map((f) => f.time)).toEqual([61_000, 65_000]);
  });

  test('a bib typed on an offline Bib device is proposed against the unlinked tap', () => {
    const { a, b } = twoTimerRace(3);
    // Offline Bib device: typed ~3s after each tap, no timestamp link.
    const finishes = a.map((t, i) => finish(String(100 + i), null, (i + 1) * 10_000 + 3_000));
    const v = view([...a, ...b], finishes);
    expect(v.rows.filter((r) => r.kind === 'proposed')).toHaveLength(3);
    expect(v.proposal.pairs[0].tap.corroboration).toBe(2);
  });

  test('a finish whose tap was discarded is no longer linked', () => {
    const t = tap('timer-a', 10_000, { voided: 1 });
    const f = finish('5', t.id, 10_000);
    const model = buildModel([t], [f]);
    expect(model.orphanFinishes).toHaveLength(1);
  });
});

describe('planRelinkInOrder', () => {
  test('refuses while bib and tap counts disagree', () => {
    const { a } = twoTimerRace(4);
    const phantom = tap('timer-a', 25_000);
    const finishes = a.map((t, i) => finish(String(100 + i), t.id, (i + 1) * 10_000));
    const plan = planRelinkInOrder(buildModel([...a, phantom], finishes), START);
    expect(plan).toEqual({ ok: false, bibs: 4, taps: 5 });
  });

  test('after the phantom tap is discarded everything lines up and nothing needs moving', () => {
    const { a } = twoTimerRace(4);
    const phantom = tap('timer-a', 25_000, { voided: 1 });
    const finishes = a.map((t, i) => finish(String(100 + i), t.id, (i + 1) * 10_000));
    const plan = planRelinkInOrder(buildModel([...a, phantom], finishes), START);
    expect(plan).toEqual({ ok: true, links: [] });
  });

  test('re-links bibs that a stray tap shifted by one', () => {
    // Real finishers at 10s, 20s, 30s, but a stray tap at 15s was in the queue,
    // so the Bib operator's three entries ended up on 10s, 15s, 20s.
    const real = [tap('timer-a', 10_000), tap('timer-a', 20_000), tap('timer-a', 30_000)];
    const stray = tap('timer-a', 15_000);
    const finishes = [
      finish('1', real[0].id, 10_000),
      finish('2', stray.id, 15_000),
      finish('3', real[1].id, 20_000),
    ];
    // Operator discards the stray tap: finish '2' is orphaned, 3 bibs vs 3 taps.
    const voidedStray = { ...stray, voided: 1 as const };
    const plan = planRelinkInOrder(buildModel([...real, voidedStray], finishes), START);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      const byFinish = new Map(plan.links.map((l) => [l.finishId, l]));
      // Bib 2 -> the 20s tap, bib 3 -> the 30s tap; bib 1 untouched.
      expect(byFinish.get(finishes[1].id)?.timestampId).toBe(real[1].id);
      expect(byFinish.get(finishes[2].id)?.timestampId).toBe(real[2].id);
      expect(byFinish.has(finishes[0].id)).toBe(false);
      expect(byFinish.get(finishes[2].id)?.gunTime).toBe(30_000);
    }
  });
});
