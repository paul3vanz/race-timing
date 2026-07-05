// Cross-device finish reconciliation.
//
// Runs in two phases:
//   1. Per-role clustering — dedupe redundant captures from backup devices
//      (e.g. two Timer phones both tapping the same finisher) into one
//      canonical event per role, with a corroboration count.
//   2. Cross-role alignment — a sequence-alignment DP matches the canonical
//      Timer-tap stream against the canonical Bib-entry stream, tolerating
//      missed taps and double-clicks without cascading misalignment through
//      the rest of the race.
//
// Everything here is a pure proposal over plain data — nothing writes to a
// database. The caller (the Review screen) decides what to commit and how.

// ── Inputs ────────────────────────────────────────────────────────────────────

export interface RawTap {
  id: string;
  deviceId: string;
  time: number; // ms — only relative order/gaps matter, any shared clock basis works
}

export interface RawBibEntry {
  id: string;
  deviceId: string;
  bibNumber: string;
  time: number; // ms, same clock basis as RawTap.time
}

// ── Phase 1 output ───────────────────────────────────────────────────────────

export interface CanonicalTap {
  time: number; // median of the corroborating raw taps
  sourceIds: string[]; // raw tap ids folded into this event
  corroboration: number; // number of distinct devices that captured it
}

export interface BibDisagreement {
  bibNumber: string;
  sourceIds: string[];
}

export interface CanonicalBibEntry {
  bibNumber: string; // the majority-agreed number (ties broken by earliest report)
  time: number;
  sourceIds: string[];
  corroboration: number;
  disagreement: BibDisagreement[] | null; // other bib numbers reported for what looks like the same event
}

// Two devices watching the same crossing react in comparable time — this
// window is deliberately tight. Distinct finishers, even in a bunched sprint
// finish, are expected to be seconds apart; it's fine (expected, even) for a
// pair of very-close real finishers to land in separate clusters here — that
// ambiguity gets resolved in phase 2 by cross-referencing the Bib stream,
// not guessed at in isolation.
const TAP_CLUSTER_WINDOW_MS = 1500;

// Bib entries are typed, not tapped, so allow more jitter between devices —
// two operators glancing at the same runner and keying in a number won't be
// as tightly synced as two thumbs reacting to the same visual crossing.
const BIB_CLUSTER_WINDOW_MS = 4000;

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Greedy single-linkage-by-time clustering, but a cluster may never contain
// two raw items from the *same* device — that constraint is what stops a
// bunched sprint finish (several genuinely distinct events from one device,
// each within the window of the next) from chaining into one giant cluster.
// A real corroborating cluster has at most one tap per device by definition.
function clusterByDeviceUniqueTime<T extends { deviceId: string; time: number }>(
  items: T[],
  windowMs: number,
): T[][] {
  const sorted = [...items].sort((a, b) => a.time - b.time);
  const clusters: T[][] = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    const withinWindow = last !== undefined && item.time - last[last.length - 1].time <= windowMs;
    const sameDeviceAlreadyInCluster = last?.some((m) => m.deviceId === item.deviceId) ?? false;
    if (withinWindow && !sameDeviceAlreadyInCluster) {
      last.push(item);
    } else {
      clusters.push([item]);
    }
  }
  return clusters;
}

export function clusterTimerTaps(rawTaps: RawTap[]): CanonicalTap[] {
  return clusterByDeviceUniqueTime(rawTaps, TAP_CLUSTER_WINDOW_MS).map((cluster) => ({
    time: median(cluster.map((t) => t.time)),
    sourceIds: cluster.map((t) => t.id),
    corroboration: cluster.length,
  }));
}

export function clusterBibEntries(rawEntries: RawBibEntry[]): CanonicalBibEntry[] {
  return clusterByDeviceUniqueTime(rawEntries, BIB_CLUSTER_WINDOW_MS).map((group) => {
    const byBib = new Map<string, RawBibEntry[]>();
    for (const entry of group) {
      const list = byBib.get(entry.bibNumber) ?? [];
      list.push(entry);
      byBib.set(entry.bibNumber, list);
    }
    // Canonical = whichever bib number the most devices agree on; ties break
    // to whichever was reported first, so the result is deterministic.
    const ranked = [...byBib.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[1][0].time - b[1][0].time,
    );
    const [canonicalBib, canonicalEntries] = ranked[0];
    const alternates = ranked.slice(1);

    return {
      bibNumber: canonicalBib,
      time: median(canonicalEntries.map((e) => e.time)),
      sourceIds: canonicalEntries.map((e) => e.id),
      corroboration: canonicalEntries.length,
      disagreement:
        alternates.length > 0
          ? alternates.map(([bibNumber, entries]) => ({ bibNumber, sourceIds: entries.map((e) => e.id) }))
          : null,
    };
  });
}

// ── Phase 2 — cross-role alignment ──────────────────────────────────────────

export interface ReconciledPair {
  tap: CanonicalTap;
  bib: CanonicalBibEntry;
  flagged: boolean; // low-confidence match — the time gap was outside the locally-expected delay
}

export interface AlignmentResult {
  pairs: ReconciledPair[];
  unmatchedTaps: CanonicalTap[];
  unmatchedBibs: CanonicalBibEntry[];
}

// Affine gap costs: one run of several consecutive misses/doubles should
// cost less than being chopped into a zig-zag of spurious matches, which is
// what a flat per-item penalty does. gapExtend is deliberately small
// relative to gapOpen.
const GAP_OPEN = 6000;
const GAP_EXTEND = 500;

// A bib is typed well after the tap, and that lag drifts over the course of
// a race as the queue backs up — so "expected delay" is estimated locally
// from nearby confirmed pairs rather than assumed to be a constant.
const DEFAULT_DELAY_MS = 3000;
const DELAY_WINDOW = 15;

// Above this, a matched pair is still the best available match but is
// surfaced to the operator rather than auto-confirmed.
const FLAG_THRESHOLD_MS = 8000;

interface Anchor {
  time: number;
  delay: number;
}

function estimateLocalDelay(anchors: Anchor[], atTime: number): number {
  if (anchors.length === 0) return DEFAULT_DELAY_MS;
  const nearest = [...anchors]
    .sort((a, b) => Math.abs(a.time - atTime) - Math.abs(b.time - atTime))
    .slice(0, DELAY_WINDOW);
  return median(nearest.map((a) => a.delay));
}

// Gotoh affine-gap sequence alignment, minimizing total cost. Three DP
// layers: M (ends in a match), Dx (ends skipping a tap), Dy (ends skipping a
// bib entry) — this is what makes a run of gaps cheaper than the same number
// of isolated ones (Dx/Dy only pay GAP_OPEN on the *first* skip in a run).
const NONE = 0,
  M = 1,
  DX = 2,
  DY = 3;

function align(
  taps: CanonicalTap[],
  bibs: CanonicalBibEntry[],
  cost: (tap: CanonicalTap, bib: CanonicalBibEntry) => number,
): AlignmentResult {
  const n = taps.length;
  const m = bibs.length;
  const INF = Infinity;

  const m$: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const dx: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const dy: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  // Backtrace: which layer + which previous layer we came from.
  const from: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(NONE));

  m$[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    dx[i][0] = GAP_OPEN + (i - 1) * GAP_EXTEND;
    from[i][0] = DX;
  }
  for (let j = 1; j <= m; j++) {
    dy[0][j] = GAP_OPEN + (j - 1) * GAP_EXTEND;
    from[0][j] = DY;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const matchCost = cost(taps[i - 1], bibs[j - 1]);
      const prevBest = Math.min(m$[i - 1][j - 1], dx[i - 1][j - 1], dy[i - 1][j - 1]);
      m$[i][j] = matchCost + prevBest;

      dx[i][j] = Math.min(m$[i - 1][j] + GAP_OPEN, dx[i - 1][j] + GAP_EXTEND);
      dy[i][j] = Math.min(m$[i][j - 1] + GAP_OPEN, dy[i][j - 1] + GAP_EXTEND);

      const best = Math.min(m$[i][j], dx[i][j], dy[i][j]);
      from[i][j] = best === m$[i][j] ? M : best === dx[i][j] ? DX : DY;
    }
  }

  // Backtrack from whichever layer is cheapest at (n, m).
  const pairs: { tapIdx: number; bibIdx: number }[] = [];
  const unmatchedTapIdx: number[] = [];
  const unmatchedBibIdx: number[] = [];

  let i = n;
  let j = m;
  let layer = from[n][m];
  while (i > 0 || j > 0) {
    if (layer === M && i > 0 && j > 0) {
      pairs.push({ tapIdx: i - 1, bibIdx: j - 1 });
      const prevLayer =
        m$[i - 1][j - 1] <= dx[i - 1][j - 1] && m$[i - 1][j - 1] <= dy[i - 1][j - 1]
          ? M
          : dx[i - 1][j - 1] <= dy[i - 1][j - 1]
            ? DX
            : DY;
      i -= 1;
      j -= 1;
      layer = i > 0 || j > 0 ? prevLayer : NONE;
    } else if (layer === DX && i > 0) {
      unmatchedTapIdx.push(i - 1);
      const cameFromMatch = dx[i][j] === m$[i - 1][j] + GAP_OPEN;
      i -= 1;
      layer = cameFromMatch ? M : DX;
    } else if (layer === DY && j > 0) {
      unmatchedBibIdx.push(j - 1);
      const cameFromMatch = dy[i][j] === m$[i][j - 1] + GAP_OPEN;
      j -= 1;
      layer = cameFromMatch ? M : DY;
    } else if (i > 0) {
      unmatchedTapIdx.push(i - 1);
      i -= 1;
    } else {
      unmatchedBibIdx.push(j - 1);
      j -= 1;
    }
  }

  pairs.reverse();
  return {
    pairs: pairs.map(({ tapIdx, bibIdx }) => ({
      tap: taps[tapIdx],
      bib: bibs[bibIdx],
      flagged: false, // caller re-derives this once it knows the real per-pair cost, see alignFinishers
    })),
    unmatchedTaps: unmatchedTapIdx.reverse().map((idx) => taps[idx]),
    unmatchedBibs: unmatchedBibIdx.reverse().map((idx) => bibs[idx]),
  };
}

export function alignFinishers(taps: CanonicalTap[], bibs: CanonicalBibEntry[]): AlignmentResult {
  if (taps.length === 0 || bibs.length === 0) {
    return { pairs: [], unmatchedTaps: taps, unmatchedBibs: bibs };
  }

  // Pass 1 — rough, order-only alignment (no assumption about delay
  // magnitude yet) purely to get provisional anchors for pass 2's delay
  // curve. A bib typed *before* its tap is implausible, so penalize that
  // direction hard; otherwise just prefer the smallest positive gap.
  const roughCost = (tap: CanonicalTap, bib: CanonicalBibEntry): number => {
    const diff = bib.time - tap.time;
    return diff >= 0 ? diff : Math.abs(diff) + GAP_OPEN;
  };
  const rough = align(taps, bibs, roughCost);
  const anchors: Anchor[] = rough.pairs.map((p) => ({ time: p.tap.time, delay: p.bib.time - p.tap.time }));

  // Pass 2 — refine against a locally-adaptive expected delay instead of a
  // global constant, so a queue backing up late in the race doesn't bias
  // matching exactly when it matters most.
  const refinedCost = (tap: CanonicalTap, bib: CanonicalBibEntry): number => {
    const expected = estimateLocalDelay(anchors, tap.time);
    return Math.abs(bib.time - tap.time - expected);
  };
  const refined = align(taps, bibs, refinedCost);

  return {
    ...refined,
    pairs: refined.pairs.map((p) => ({ ...p, flagged: refinedCost(p.tap, p.bib) > FLAG_THRESHOLD_MS })),
  };
}
