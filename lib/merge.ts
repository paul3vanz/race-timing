// Cross-device results model.
//
// Several phones can write to the same race: typically two Timers tapping each
// finisher, one Bib device typing numbers at the end of the funnel, and a
// third device watching the Results screen. Each one only ever sees its own
// rows plus whatever has been pulled from Supabase, so everything that needs
// "the" list of finishers (the Bib queue, the Results screen, prize reports,
// CSV export) derives it from the *raw merged rows* with the functions below
// instead of trusting any single device's view.
//
// Everything here is pure — plain rows in, plain data out, nothing touches a
// database — which is what makes the multi-device behaviour unit-testable.

import type { Finish, Participant, ParticipantStatus, RaceFormat, Timestamp } from './db';
import {
  alignFinishers,
  clusterBibEntries,
  clusterTimerTaps,
  type CanonicalBibEntry,
  type CanonicalTap,
  type ReconciledPair,
} from './reconcile';

// ── Active rows ───────────────────────────────────────────────────────────────

// `duplicate_of` rows are legacy corroboration markers (older builds wrote
// them when confirming a reconciliation); they never count as a separate row.
export function isActiveTap(t: Pick<Timestamp, 'voided' | 'duplicate_of'>): boolean {
  return !t.voided && !t.duplicate_of;
}

export function isActiveFinish(f: Pick<Finish, 'voided' | 'duplicate_of'>): boolean {
  return !f.voided && !f.duplicate_of;
}

// ── Tap clusters ──────────────────────────────────────────────────────────────

// One physical finisher as seen by every Timer device. Taps from different
// devices within the clustering window count as the same finisher; a device's
// own double-click does NOT fold in (see lib/reconcile.ts), it shows up as a
// separate single-device cluster the operator can discard.
export interface TapCluster {
  id: string; // earliest tap in the cluster — the stable id bibs link to
  time: number; // median capture time, Unix ms
  tapIds: string[];
  deviceIds: string[]; // distinct devices that captured this finisher
}

export function clusterActiveTaps(taps: Timestamp[], windowMs?: number): TapCluster[] {
  const active = taps.filter(isActiveTap);
  const deviceOf = new Map(active.map((t) => [t.id, t.device_id]));
  return clusterTimerTaps(
    active.map((t) => ({ id: t.id, deviceId: t.device_id, time: t.recorded_at })),
    windowMs,
  ).map((c) => ({
    id: c.sourceIds[0],
    time: c.time,
    tapIds: c.sourceIds,
    deviceIds: [...new Set(c.sourceIds.map((id) => deviceOf.get(id) as string))],
  }));
}

export interface MergeModel {
  clusters: TapCluster[]; // time-ordered
  linked: Map<string, Finish[]>; // cluster.id -> finishes pointing at it
  orphanFinishes: Finish[]; // active funnel finishes with no live tap behind them
  // A backup recorder's finish-line entries (finishes.source = 'line'): evidence
  // used to cross-check the Timers and fill gaps, never results in their own right.
  lineEntries: Finish[];
  unlinkedClusters: TapCluster[];
}

export function buildModel(taps: Timestamp[], finishes: Finish[]): MergeModel {
  const clusters = clusterActiveTaps(taps);
  const clusterByTapId = new Map<string, TapCluster>();
  for (const c of clusters) for (const id of c.tapIds) clusterByTapId.set(id, c);
  // A tap folded into another by an older build still resolves to its cluster,
  // so a finish linked to it isn't mistaken for an orphan.
  for (const t of taps) {
    if (!t.voided && t.duplicate_of) {
      const c = clusterByTapId.get(t.duplicate_of);
      if (c) clusterByTapId.set(t.id, c);
    }
  }

  const linked = new Map<string, Finish[]>();
  const orphanFinishes: Finish[] = [];
  const lineEntries: Finish[] = [];
  for (const f of finishes.filter(isActiveFinish)) {
    if (f.source === 'line') {
      // Linking a line entry to a tap promotes it to 'funnel', so a 'line' row
      // is by definition still unlinked evidence.
      lineEntries.push(f);
      continue;
    }
    const cluster = f.timestamp_id ? clusterByTapId.get(f.timestamp_id) : undefined;
    if (cluster) {
      const list = linked.get(cluster.id) ?? [];
      list.push(f);
      linked.set(cluster.id, list);
    } else {
      orphanFinishes.push(f);
    }
  }
  for (const list of linked.values()) {
    list.sort((a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0) || a.id.localeCompare(b.id));
  }
  orphanFinishes.sort((a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0));
  lineEntries.sort((a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0));

  return {
    clusters,
    linked,
    orphanFinishes,
    lineEntries,
    unlinkedClusters: clusters.filter((c) => !linked.has(c.id)),
  };
}

// ── Bib queue (what the Bib operator works through) ──────────────────────────

export interface QueueItem {
  id: string; // cluster.id — pass to assignBibToTimestamp
  time: number;
  tapIds: string[];
  deviceIds: string[];
  position: number; // 1-based finishing order across ALL timers, not per device
}

export function buildQueue(taps: Timestamp[], finishes: Finish[]): QueueItem[] {
  const model = buildModel(taps, finishes);
  return model.clusters
    .map((c, i) => ({ id: c.id, time: c.time, tapIds: c.tapIds, deviceIds: c.deviceIds, position: i + 1 }))
    .filter((item) => !model.linked.has(item.id));
}

// ── Device labelling + coverage ──────────────────────────────────────────────

export interface DeviceLabel {
  short: string; // "T1", "B1", "M"
  long: string; // "Timer 1 (this device)"
  role: 'timer' | 'bib' | 'line' | 'manual';
}

// Manual (operator-inserted) taps are recorded under a per-device id
// ("manual-<device prefix>") so two devices inserting at once can't collide on
// the remote (race, device, sequence) uniqueness. Bare 'manual' is the older
// shared id.
export const isManualDevice = (id: string): boolean => id === 'manual' || id.startsWith('manual-');

// Stable, human-readable names: Timers numbered by who tapped first, Bib-only
// devices numbered by who typed first. UUIDs are useless on a results screen.
export function labelDevices(
  taps: Timestamp[],
  finishes: Finish[],
  thisDeviceId: string | null,
): Map<string, DeviceLabel> {
  const labels = new Map<string, DeviceLabel>();
  // The name entered on each device, so "Timer 1" reads as a person.
  const operatorOf = new Map<string, string>();
  for (const row of [...taps, ...finishes]) {
    if (row.operator_name) operatorOf.set(row.device_id, row.operator_name);
  }
  const suffix = (id: string) => {
    const name = operatorOf.get(id);
    return `${name ? ` · ${name}` : ''}${id === thisDeviceId ? ' (this device)' : ''}`;
  };

  const firstTap = new Map<string, number>();
  for (const t of taps) {
    if (isManualDevice(t.device_id)) continue;
    const prev = firstTap.get(t.device_id);
    if (prev === undefined || t.recorded_at < prev) firstTap.set(t.device_id, t.recorded_at);
  }
  [...firstTap.entries()]
    .sort((a, b) => a[1] - b[1])
    .forEach(([id], i) =>
      labels.set(id, { short: `T${i + 1}`, long: `Timer ${i + 1}${suffix(id)}`, role: 'timer' }),
    );

  const firstBib = new Map<string, number>();
  const hasFunnelEntry = new Set<string>();
  for (const f of finishes) {
    if (labels.has(f.device_id) || f.device_id === 'unknown') continue;
    if (f.source !== 'line') hasFunnelEntry.add(f.device_id);
    const prev = firstBib.get(f.device_id);
    const at = f.gun_time ?? 0;
    if (prev === undefined || at < prev) firstBib.set(f.device_id, at);
  }
  // A device whose entries are all finish-line entries is a backup recorder
  // ("Finish line 1"); anything that typed funnel entries is a Bib device.
  let bibN = 0;
  let lineN = 0;
  [...firstBib.entries()]
    .sort((a, b) => a[1] - b[1])
    .forEach(([id]) => {
      if (hasFunnelEntry.has(id)) {
        bibN += 1;
        labels.set(id, { short: `B${bibN}`, long: `Bib ${bibN}${suffix(id)}`, role: 'bib' });
      } else {
        lineN += 1;
        labels.set(id, { short: `L${lineN}`, long: `Finish line ${lineN}${suffix(id)}`, role: 'line' });
      }
    });

  for (const t of taps) {
    if (isManualDevice(t.device_id) && !labels.has(t.device_id)) {
      labels.set(t.device_id, { short: 'M', long: 'Manual', role: 'manual' });
    }
  }
  return labels;
}

// How far outside a Timer's first/last tap a finisher is still expected to
// have been caught by it — a backup Timer that joins late shouldn't make every
// earlier finisher look like it "missed" them.
const COVERAGE_MARGIN_MS = 5_000;

function timerCoverage(taps: Timestamp[]): Map<string, { first: number; last: number }> {
  const coverage = new Map<string, { first: number; last: number }>();
  for (const t of taps) {
    if (!isActiveTap(t) || isManualDevice(t.device_id)) continue;
    const c = coverage.get(t.device_id);
    if (!c) coverage.set(t.device_id, { first: t.recorded_at, last: t.recorded_at });
    else {
      c.first = Math.min(c.first, t.recorded_at);
      c.last = Math.max(c.last, t.recorded_at);
    }
  }
  return coverage;
}

// Timers that were running at this finisher's time but have no tap for them —
// either that Timer missed the click, or the one that did tap clicked twice.
// Only meaningful with two or more Timers; with one there's nobody to compare.
function missingTimers(
  cluster: TapCluster,
  coverage: Map<string, { first: number; last: number }>,
): string[] {
  if (coverage.size < 2 || cluster.deviceIds.some(isManualDevice)) return [];
  const missing: string[] = [];
  for (const [deviceId, c] of coverage) {
    if (cluster.deviceIds.includes(deviceId)) continue;
    if (cluster.time >= c.first - COVERAGE_MARGIN_MS && cluster.time <= c.last + COVERAGE_MARGIN_MS) {
      missing.push(deviceId);
    }
  }
  return missing;
}

// ── Finishers (the single source of truth for times) ─────────────────────────

export interface Finisher {
  finish: Finish;
  bib: string;
  time: number; // race-relative ms
  cluster: TapCluster | null; // null for a bib typed with no Timer tap behind it
}

// Every active bib entry with its best-known time: the merged tap cluster's
// median for a linked entry (so two Timers average out their reaction jitter),
// or the typed-at time for a bib with no tap. Used by the Results screen's
// summary, CSV export and prize reports, so they can never disagree.
export function computeFinishers(model: MergeModel, startTime: number): Finisher[] {
  const out: Finisher[] = [];
  for (const cluster of model.clusters) {
    for (const finish of model.linked.get(cluster.id) ?? []) {
      out.push({ finish, bib: finish.bib_number, time: cluster.time - startTime, cluster });
    }
  }
  // With no Timer taps at all, finish-line entries are all there is.
  const orphans = model.clusters.length === 0 ? [...model.orphanFinishes, ...model.lineEntries] : model.orphanFinishes;
  for (const finish of orphans) {
    out.push({ finish, bib: finish.bib_number, time: finish.gun_time ?? 0, cluster: null });
  }
  return out.sort((a, b) => a.time - b.time);
}

// ── Reconciliation proposal (bibs typed with no tap behind them) ─────────────

export interface Proposal {
  pairs: ReconciledPair[];
  unmatchedTaps: CanonicalTap[];
  unmatchedBibs: CanonicalBibEntry[]; // no disagreement — genuinely just missing a tap
  disagreements: CanonicalBibEntry[]; // devices reported different bib numbers
  lineBibIds: Set<string>; // finish ids of proposed entries that came from a finish-line recorder
}

export const EMPTY_PROPOSAL: Proposal = {
  pairs: [],
  unmatchedTaps: [],
  unmatchedBibs: [],
  disagreements: [],
  lineBibIds: new Set(),
};

const toBibEntries = (finishes: Finish[], startTime: number) =>
  clusterBibEntries(
    finishes.map((f) => ({
      id: f.id,
      deviceId: f.device_id,
      bibNumber: f.bib_number,
      // Bring gun_time (race-relative) onto the same absolute clock basis as
      // tap times so the alignment cost function compares like with like.
      time: startTime + (f.gun_time ?? 0),
    })),
  );

// Proposes pairings between still-unlinked tap clusters and bibs that have no
// tap behind them, by time alignment, in two passes:
//  1. funnel entries typed with no tap queue to hand (a Bib device that was
//     offline). These are the complete list, typed some seconds after the
//     crossing, so they get first claim on the taps.
//  2. finish-line entries whose bib is not in the funnel list at all: a runner
//     the funnel recorder missed. The taps left over from pass 1 are the only
//     candidates, so a missed bib can be recovered even though the line
//     recorder's list is partial.
// A finish-line entry for a bib the funnel list already has is never proposed
// again; it is used as a cross-check on that runner's time instead.
export function buildProposal(model: MergeModel, startTime: number): Proposal {
  const taps: CanonicalTap[] = model.unlinkedClusters.map((c) => ({
    time: c.time,
    sourceIds: c.tapIds,
    corroboration: c.deviceIds.length,
  }));

  const funnelBibs = toBibEntries(model.orphanFinishes, startTime);
  const pass1 = alignFinishers(taps, funnelBibs);

  const mainBibs = new Set<string>();
  for (const list of model.linked.values()) for (const f of list) mainBibs.add(f.bib_number);
  for (const f of model.orphanFinishes) mainBibs.add(f.bib_number);
  const lineCandidates = model.lineEntries.filter((f) => !mainBibs.has(f.bib_number));
  const lineBibs = toBibEntries(lineCandidates, startTime);
  const pass2 = alignFinishers(pass1.unmatchedTaps, lineBibs);

  const lineBibIds = new Set(lineBibs.flatMap((b) => b.sourceIds));
  return {
    pairs: [...pass1.pairs, ...pass2.pairs],
    unmatchedTaps: pass2.unmatchedTaps,
    unmatchedBibs: [...pass1.unmatchedBibs, ...pass2.unmatchedBibs].filter((b) => b.disagreement === null),
    disagreements: [...funnelBibs, ...lineBibs].filter((b) => b.disagreement !== null),
    lineBibIds,
  };
}

// ── Finish-line cross-check ──────────────────────────────────────────────────

// A finish-line recorder types a bib a moment after the runner crosses. If the
// time they recorded for a bib points at a different tap than the one that bib
// is linked to, the bib was probably matched to the wrong tap (a stray tap or a
// missed one upstream shifted the order). Judged against the neighbouring taps
// rather than a fixed number of seconds, because finishers can be a couple of
// seconds apart in a bunch and ten seconds apart on a quiet stretch.
export const LINE_AGREE_MS = 15_000; // beyond this it's wrong whatever the neighbours look like
const LINE_DEFAULT_DELAY_MS = 2_000; // typical lag between crossing and the bib being typed
const LINE_MIN_DISAGREE_MS = 4_000; // typing jitter below this is never worth flagging

export interface LineCheck {
  status: 'agrees' | 'disagrees';
  deltaMs: number; // finish-line time minus timer time; positive = line recorded it later
}

function medianOf(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function lineDeltaFor(bib: string, clusterTime: number, lineEntries: Finish[], startTime: number): number | null {
  let best: number | null = null;
  for (const f of lineEntries) {
    if (f.bib_number !== bib) continue;
    const delta = startTime + (f.gun_time ?? 0) - clusterTime;
    if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
  }
  return best;
}

// How late, typically, this race's finish-line recorder types a bib, measured
// from the bibs both lists agree on. Falls back to a default until there are
// enough to measure.
export function estimateLineDelay(model: MergeModel, startTime: number): number {
  const deltas: number[] = [];
  for (const cluster of model.clusters) {
    for (const f of model.linked.get(cluster.id) ?? []) {
      const d = lineDeltaFor(f.bib_number, cluster.time, model.lineEntries, startTime);
      if (d !== null && Math.abs(d) <= LINE_AGREE_MS) deltas.push(d);
    }
  }
  return deltas.length >= 3 ? medianOf(deltas) : LINE_DEFAULT_DELAY_MS;
}

export function checkAgainstLine(
  bib: string,
  cluster: TapCluster,
  model: MergeModel,
  startTime: number,
  lineDelayMs: number,
): LineCheck | null {
  const delta = lineDeltaFor(bib, cluster.time, model.lineEntries, startTime);
  if (delta === null) return null;

  const off = Math.abs(delta - lineDelayMs);
  const crossedAt = cluster.time + delta - lineDelayMs; // when the line recorder says the runner crossed
  let closest = cluster;
  for (const c of model.clusters) {
    if (Math.abs(c.time - crossedAt) < Math.abs(closest.time - crossedAt)) closest = c;
  }
  const disagrees = off > LINE_AGREE_MS || (closest.id !== cluster.id && off > LINE_MIN_DISAGREE_MS);
  return { status: disagrees ? 'disagrees' : 'agrees', deltaMs: delta };
}

// ── Results rows ─────────────────────────────────────────────────────────────
//
// One continuous, time-ordered list: a confirmed finisher, a pending proposal,
// a disagreement and a gap on either side are all rows in the same sequence,
// so a blank cell or a dashed row is visible right where it happened.

export interface RowFlags {
  dupBib: boolean; // the same bib appears on more than one result
  unknownBib: boolean; // not on the start list — very often a typo
  missingTimers: string[]; // short labels of Timers that have no tap for this finisher
  lowConfidence: boolean;
  withdrawn: ParticipantStatus | null; // entrant marked DNS/DNF yet has a result
}

export type ResultRow =
  | {
      kind: 'finisher';
      key: string;
      position: number;
      time: number;
      finish: Finish;
      cluster: TapCluster | null;
      extraEntries: number; // further bib entries pointing at the same tap
      name: string | null;
      deviceLabels: string[]; // short labels of the Timers that captured it
      line: LineCheck | null; // what a finish-line recorder saw for this bib, if anything
      flags: RowFlags;
    }
  | {
      kind: 'proposed';
      key: string;
      position: number;
      time: number;
      tapTime: number;
      bibTime: number;
      pair: ReconciledPair;
      name: string | null;
      fromLine: boolean; // the bib came from a finish-line recorder rather than the funnel list
      flags: RowFlags;
    }
  | {
      kind: 'disagreement';
      key: string;
      position: number;
      time: number;
      tapTime: number | null;
      entry: CanonicalBibEntry;
      pair: ReconciledPair | null;
    }
  | { kind: 'gap-tap'; key: string; position: null; time: number; tap: CanonicalTap; missingTimers: string[] }
  | {
      kind: 'gap-bib';
      key: string;
      position: number;
      time: number;
      bibTime: number;
      bib: CanonicalBibEntry;
      fromLine: boolean;
    };

export interface DeviceSummary {
  deviceId: string;
  label: DeviceLabel;
  taps: number; // active taps (timers) or active entries (bib devices)
  discarded: number; // voided taps / removed entries
  missed: number; // finishers other Timers caught that this one didn't (timers only)
}

export interface ResultsView {
  rows: ResultRow[];
  finishers: Finisher[];
  proposal: Proposal;
  model: MergeModel;
  devices: DeviceSummary[];
  labels: Map<string, DeviceLabel>;
  needsReview: number;
  duplicateBibs: string[];
  timerDevices: number;
  // Start-list reconciliation: entrants expected to finish (not DNS/DNF) with
  // no result yet, and how many are marked DNS/DNF.
  stillOut: number;
  dns: number;
  dnf: number;
}

function nameOf(p: Participant | undefined): string | null {
  if (!p) return null;
  return p.team_name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null);
}

export function buildResultsView(input: {
  taps: Timestamp[];
  finishes: Finish[];
  participants: Participant[];
  startTime: number | null;
  thisDeviceId: string | null;
  format?: RaceFormat; // defaults to 'single'
}): ResultsView {
  const { taps, finishes, participants, thisDeviceId } = input;
  // In a lapped race a bib appearing again is the next lap, not a problem.
  const lapped = input.format === 'laps';
  const startTime = input.startTime ?? 0;

  const model = buildModel(taps, finishes);
  const labels = labelDevices(taps, finishes, thisDeviceId);
  const coverage = timerCoverage(taps);
  const shortOf = (id: string) => labels.get(id)?.short ?? '?';
  const participantByBib = new Map(participants.map((p) => [p.bib_number, p]));
  const hasRoster = participants.length > 0;

  // With no Timer taps at all this is a bib-only race (bibs typed live as
  // runners finish): its entries are the results, not unmatched leftovers.
  const bibOnly = model.clusters.length === 0;
  const bibOnlyEntries = bibOnly
    ? [...model.orphanFinishes, ...model.lineEntries].sort((a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0))
    : [];
  const proposal = bibOnly ? EMPTY_PROPOSAL : buildProposal(model, startTime);
  const lineDelay = estimateLineDelay(model, startTime);
  const disagreementKeys = new Set(proposal.disagreements.map((d) => d.sourceIds[0]));

  interface Draft {
    key: string;
    time: number;
    hasBib: boolean;
    bib: string | null;
    build: (position: number | null, dupBibs: Set<string>) => ResultRow;
  }
  const drafts: Draft[] = [];

  const flagsFor = (bib: string, dupBibs: Set<string>, missing: string[], low: boolean): RowFlags => ({
    dupBib: !lapped && dupBibs.has(bib),
    unknownBib: hasRoster && !participantByBib.has(bib),
    missingTimers: missing.map(shortOf),
    lowConfidence: low,
    withdrawn: participantByBib.get(bib)?.status ?? null,
  });

  for (const cluster of model.clusters) {
    const entries = model.linked.get(cluster.id);
    if (!entries) continue;
    const [finish, ...extra] = entries;
    const missing = missingTimers(cluster, coverage);
    drafts.push({
      key: `finish-${finish.id}`,
      time: cluster.time - startTime,
      hasBib: true,
      bib: finish.bib_number,
      build: (position, dupBibs) => ({
        kind: 'finisher',
        key: `finish-${finish.id}`,
        position: position as number,
        time: cluster.time - startTime,
        finish,
        cluster,
        extraEntries: extra.length,
        name: nameOf(participantByBib.get(finish.bib_number)),
        deviceLabels: cluster.deviceIds.map(shortOf),
        line: checkAgainstLine(finish.bib_number, cluster, model, startTime, lineDelay),
        flags: flagsFor(finish.bib_number, dupBibs, missing, finish.flagged === 1),
      }),
    });
  }

  if (bibOnly) {
    for (const finish of bibOnlyEntries) {
      drafts.push({
        key: `finish-${finish.id}`,
        time: finish.gun_time ?? 0,
        hasBib: true,
        bib: finish.bib_number,
        build: (position, dupBibs) => ({
          kind: 'finisher',
          key: `finish-${finish.id}`,
          position: position as number,
          time: finish.gun_time ?? 0,
          finish,
          cluster: null,
          extraEntries: 0,
          name: nameOf(participantByBib.get(finish.bib_number)),
          deviceLabels: [],
          line: null,
          flags: flagsFor(finish.bib_number, dupBibs, [], false),
        }),
      });
    }
  } else {
    for (const pair of proposal.pairs) {
      if (disagreementKeys.has(pair.bib.sourceIds[0])) continue; // shown via its disagreement row
      const tapTime = pair.tap.time - startTime;
      const bibTime = pair.bib.time - startTime;
      drafts.push({
        key: `pair-${pair.bib.sourceIds[0]}`,
        time: tapTime,
        hasBib: true,
        bib: pair.bib.bibNumber,
        build: (position, dupBibs) => ({
          kind: 'proposed',
          key: `pair-${pair.bib.sourceIds[0]}`,
          position: position as number,
          time: tapTime,
          tapTime,
          bibTime,
          pair,
          name: nameOf(participantByBib.get(pair.bib.bibNumber)),
          fromLine: proposal.lineBibIds.has(pair.bib.sourceIds[0]),
          flags: flagsFor(pair.bib.bibNumber, dupBibs, [], pair.flagged),
        }),
      });
    }

    for (const entry of proposal.disagreements) {
      const pair = proposal.pairs.find((p) => p.bib.sourceIds[0] === entry.sourceIds[0]) ?? null;
      const tapTime = pair ? pair.tap.time - startTime : null;
      const time = tapTime ?? entry.time - startTime;
      drafts.push({
        key: `disagreement-${entry.sourceIds[0]}`,
        time,
        hasBib: true,
        bib: entry.bibNumber,
        build: (position) => ({
          kind: 'disagreement',
          key: `disagreement-${entry.sourceIds[0]}`,
          position: position as number,
          time,
          tapTime,
          entry,
          pair,
        }),
      });
    }

    for (const tap of proposal.unmatchedTaps) {
      const cluster = model.unlinkedClusters.find((c) => c.id === tap.sourceIds[0]);
      const missing = cluster ? missingTimers(cluster, coverage).map(shortOf) : [];
      drafts.push({
        key: `tap-${tap.sourceIds[0]}`,
        time: tap.time - startTime,
        hasBib: false,
        bib: null,
        build: () => ({
          kind: 'gap-tap',
          key: `tap-${tap.sourceIds[0]}`,
          position: null,
          time: tap.time - startTime,
          tap,
          missingTimers: missing,
        }),
      });
    }

    for (const bib of proposal.unmatchedBibs) {
      const bibTime = bib.time - startTime;
      drafts.push({
        key: `bib-${bib.sourceIds[0]}`,
        time: bibTime,
        hasBib: true,
        bib: bib.bibNumber,
        build: (position) => ({
          kind: 'gap-bib',
          key: `bib-${bib.sourceIds[0]}`,
          position: position as number,
          time: bibTime,
          bibTime,
          bib,
          fromLine: proposal.lineBibIds.has(bib.sourceIds[0]),
        }),
      });
    }
  }

  drafts.sort((a, b) => a.time - b.time);

  const bibCounts = new Map<string, number>();
  for (const d of drafts) if (d.bib) bibCounts.set(d.bib, (bibCounts.get(d.bib) ?? 0) + 1);
  const duplicateBibs = lapped ? [] : [...bibCounts.entries()].filter(([, n]) => n > 1).map(([bib]) => bib);
  const dupSet = new Set(duplicateBibs);

  let pos = 0;
  const rows = drafts.map((d) => {
    if (!d.hasBib) return d.build(null, dupSet);
    pos += 1;
    return d.build(pos, dupSet);
  });

  const needsReview = rows.filter((r) => {
    if (r.kind !== 'finisher') return true;
    return (
      r.extraEntries > 0 ||
      r.flags.dupBib ||
      r.flags.unknownBib ||
      r.flags.lowConfidence ||
      r.flags.withdrawn !== null ||
      r.flags.missingTimers.length > 0 ||
      r.line?.status === 'disagrees'
    );
  }).length;

  // Per-device diagnostics
  const missedByDevice = new Map<string, number>();
  for (const cluster of model.clusters) {
    for (const id of missingTimers(cluster, coverage)) {
      missedByDevice.set(id, (missedByDevice.get(id) ?? 0) + 1);
    }
  }
  const devices: DeviceSummary[] = [];
  for (const [deviceId, label] of labels) {
    const deviceTaps = taps.filter((t) => t.device_id === deviceId);
    const deviceFinishes = finishes.filter((f) => f.device_id === deviceId);
    const tapsActive = deviceTaps.filter(isActiveTap).length;
    const finishesActive = deviceFinishes.filter(isActiveFinish).length;
    const isTimer = label.role === 'timer' || label.role === 'manual';
    devices.push({
      deviceId,
      label,
      taps: isTimer ? tapsActive : finishesActive,
      discarded: isTimer
        ? deviceTaps.filter((t) => t.voided).length
        : deviceFinishes.filter((f) => f.voided).length,
      missed: missedByDevice.get(deviceId) ?? 0,
    });
  }
  devices.sort((a, b) => a.label.short.localeCompare(b.label.short));

  // Every bib with any entry (results, proposals, unmatched) counts as in.
  const bibsIn = new Set(bibCounts.keys());
  let stillOut = 0;
  let dns = 0;
  let dnf = 0;
  for (const p of participants) {
    if (p.status === 'dns') dns += 1;
    else if (p.status === 'dnf') dnf += 1;
    else if (!bibsIn.has(p.bib_number)) stillOut += 1;
  }

  return {
    rows,
    finishers: computeFinishers(model, startTime),
    proposal,
    model,
    devices,
    labels,
    needsReview,
    duplicateBibs,
    timerDevices: coverage.size,
    stillOut,
    dns,
    dnf,
  };
}

// ── "Re-match in order" repair ───────────────────────────────────────────────
//
// The Bib list is the authoritative finishing order (an operator types bibs
// in the order runners come through the funnel) and so is the tap list. After
// discarding phantom taps / inserting missed ones until the two counts agree,
// the Nth bib belongs to the Nth tap — which re-links everything that got
// shifted by the stray tap, without anyone retyping a bib.

export type RelinkPlan =
  | { ok: true; links: { finishId: string; timestampId: string; gunTime: number }[] }
  | { ok: false; bibs: number; taps: number };

export function planRelinkInOrder(model: MergeModel, startTime: number): RelinkPlan {
  const entries: { finish: Finish; time: number }[] = [];
  for (const cluster of model.clusters) {
    for (const finish of model.linked.get(cluster.id) ?? []) entries.push({ finish, time: cluster.time });
  }
  for (const finish of model.orphanFinishes) {
    entries.push({ finish, time: startTime + (finish.gun_time ?? 0) });
  }
  entries.sort((a, b) => a.time - b.time);

  if (entries.length !== model.clusters.length) {
    return { ok: false, bibs: entries.length, taps: model.clusters.length };
  }

  const links: { finishId: string; timestampId: string; gunTime: number }[] = [];
  entries.forEach(({ finish }, i) => {
    const cluster = model.clusters[i];
    if (finish.timestamp_id && cluster.tapIds.includes(finish.timestamp_id)) return; // already right
    links.push({ finishId: finish.id, timestampId: cluster.id, gunTime: cluster.time - startTime });
  });
  return { ok: true, links };
}
