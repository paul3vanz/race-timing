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

import type { Finish, Participant, Timestamp } from './db';
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
  orphanFinishes: Finish[]; // active finishes with no live tap behind them
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
  for (const f of finishes.filter(isActiveFinish)) {
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

  return {
    clusters,
    linked,
    orphanFinishes,
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
  role: 'timer' | 'bib' | 'manual';
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
  const suffix = (id: string) => (id === thisDeviceId ? ' (this device)' : '');

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
  for (const f of finishes) {
    if (labels.has(f.device_id) || f.device_id === 'unknown') continue;
    const prev = firstBib.get(f.device_id);
    const at = f.gun_time ?? 0;
    if (prev === undefined || at < prev) firstBib.set(f.device_id, at);
  }
  [...firstBib.entries()]
    .sort((a, b) => a[1] - b[1])
    .forEach(([id], i) =>
      labels.set(id, { short: `B${i + 1}`, long: `Bib ${i + 1}${suffix(id)}`, role: 'bib' }),
    );

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
  for (const finish of model.orphanFinishes) {
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
}

export const EMPTY_PROPOSAL: Proposal = { pairs: [], unmatchedTaps: [], unmatchedBibs: [], disagreements: [] };

// Proposes pairings between still-unlinked tap clusters and orphan bibs, by
// time alignment. Only used for the "Bib device was offline / typed live"
// case — a Bib device that had the tap queue links entries at entry time.
export function buildProposal(model: MergeModel, startTime: number): Proposal {
  const taps: CanonicalTap[] = model.unlinkedClusters.map((c) => ({
    time: c.time,
    sourceIds: c.tapIds,
    corroboration: c.deviceIds.length,
  }));
  const canonicalBibs = clusterBibEntries(
    model.orphanFinishes.map((f) => ({
      id: f.id,
      deviceId: f.device_id,
      bibNumber: f.bib_number,
      // Bring gun_time (race-relative) onto the same absolute clock basis as
      // tap times so the alignment cost function compares like with like.
      time: startTime + (f.gun_time ?? 0),
    })),
  );
  const { pairs, unmatchedTaps, unmatchedBibs } = alignFinishers(taps, canonicalBibs);
  return {
    pairs,
    unmatchedTaps,
    unmatchedBibs: unmatchedBibs.filter((b) => b.disagreement === null),
    disagreements: canonicalBibs.filter((b) => b.disagreement !== null),
  };
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
  | { kind: 'gap-bib'; key: string; position: number; time: number; bibTime: number; bib: CanonicalBibEntry };

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
}): ResultsView {
  const { taps, finishes, participants, thisDeviceId } = input;
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
  const proposal = bibOnly ? EMPTY_PROPOSAL : buildProposal(model, startTime);
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
    dupBib: dupBibs.has(bib),
    unknownBib: hasRoster && !participantByBib.has(bib),
    missingTimers: missing.map(shortOf),
    lowConfidence: low,
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
        flags: flagsFor(finish.bib_number, dupBibs, missing, finish.flagged === 1),
      }),
    });
  }

  if (bibOnly) {
    for (const finish of model.orphanFinishes) {
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
        }),
      });
    }
  }

  drafts.sort((a, b) => a.time - b.time);

  const bibCounts = new Map<string, number>();
  for (const d of drafts) if (d.bib) bibCounts.set(d.bib, (bibCounts.get(d.bib) ?? 0) + 1);
  const duplicateBibs = [...bibCounts.entries()].filter(([, n]) => n > 1).map(([bib]) => bib);
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
      r.flags.missingTimers.length > 0
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
    const isTimer = label.role !== 'bib';
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
