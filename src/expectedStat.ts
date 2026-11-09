import type { PlayerLine } from "./api/playerLines";
import type { PlayerStats } from "./api/rankings";
import { statBaseMarkets } from "./markets";

/**
 * Projections from raw bookmaker lines, ported from the backend's projection engine
 * (_shared/projection.ts, poisson.ts, odds.ts) so the frontend reproduces its numbers:
 *
 *   lines → only the bookmakers each stat is projected from (kicking: DraftKings)
 *         → per bookmaker, per stat: alternate lines + main O/U line (TDs: anytime line)
 *         → yardage: margin removed → the curve's median (where the Over crosses 50%)
 *         → other stats: capped tail cut, margin removed, curve must reach the median
 *           → the curve's mean (calcExpectedStatFromAlternate, or a Poisson fit of one line)
 *         → each stat averaged over the bookmakers that cover it.
 *
 * TDs are then scaled to the team's game lines (applyTdFactor) with the factor from
 * project-teams, as project-players does.
 *
 * Ordering matters: when two lines map to the same threshold the later one wins, so lines
 * are kept in API order and merged in the same order as the backend.
 */

/** One line of one bookmaker's curve (backend MarketLine). */
type MarketLine = { line: number; overPrice: number | null; underPrice: number | null };
/** A curve line tagged with the market it came from (backend SourcedLine). */
type SourcedLine = MarketLine & { market: string };
/** market → (line key → line), in insertion order (backend Markets). */
type Markets = Map<string, Map<string, MarketLine>>;
type StatKey = keyof PlayerStats;

/** Decimal odds to implied probability; 0.5 when unusable (backend decimalToImpliedProb). */
function decimalToImpliedProb(decimalOdds: number): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds < 1) return 0.5;
  return 1 / decimalOdds;
}

/**
 * Estimate a stat by summing implied probabilities from alternate Over odds (backend
 * calcExpectedStatFromAlternate). Each Over price is the probability of exceeding its
 * line, mapped to the next integer outcome threshold (half-point lines round up). Missing
 * thresholds are interpolated, probability is 1 below the first threshold, and the tail
 * is extrapolated exponentially from the last two points. Null with fewer than two lines.
 */
export function calcExpectedStatFromAlternate(lines: MarketLine[]): number | null {
  const probabilitiesByThreshold = new Map<number, number>();
  for (const { line, overPrice } of lines) {
    if (overPrice === null) continue;
    probabilitiesByThreshold.set(Math.floor(line) + 1, decimalToImpliedProb(overPrice));
  }
  if (probabilitiesByThreshold.size < 2) return null;

  const thresholds = [...probabilitiesByThreshold.keys()].sort((a, b) => a - b);
  const survival: number[] = [];
  let previousProbability = 1.0;
  for (const threshold of thresholds) {
    const probability = Math.min(previousProbability, probabilitiesByThreshold.get(threshold)!);
    survival.push(probability);
    previousProbability = probability;
  }

  let expectedStat = thresholds[0] - 1;
  for (let index = 0; index < thresholds.length - 1; index++) {
    const thresholdCount = thresholds[index + 1] - thresholds[index];
    const lower = survival[index];
    const upper = survival[index + 1];
    for (let offset = 0; offset < thresholdCount; offset++) {
      expectedStat += lower + ((upper - lower) * offset) / thresholdCount;
    }
  }
  const lastProbability = survival[survival.length - 1];
  expectedStat += lastProbability;

  let lastSlope = 0.0;
  for (let index = thresholds.length - 2; index >= 0; index--) {
    if (survival[index] > 0 && survival[index + 1] < survival[index]) {
      lastSlope = (survival[index + 1] / survival[index]) ** (1 / (thresholds[index + 1] - thresholds[index]));
      break;
    }
  }
  if (lastSlope > 0 && lastSlope < 1) {
    expectedStat += (lastProbability * lastSlope) / (1 - lastSlope);
  }
  return expectedStat;
}

/** P(X <= k) for X ~ Poisson(lambda) (backend poissonCdf). */
function poissonCdf(k: number, lambda: number): number {
  let term = Math.exp(-lambda);
  let total = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    total += term;
  }
  return total;
}

/**
 * The Poisson mean implied by one line (backend poissonMeanFromLine): P(X > line) = fair
 * Over probability. Vig is removed when the Under price is known; otherwise the raw Over
 * is used. A 0.5 line gives λ = -ln(P(under)); higher lines are solved by bisection.
 */
function poissonMeanFromLine(line: number, overPrice: number | null, underPrice: number | null): number | null {
  if (!overPrice || overPrice <= 1 || !Number.isFinite(line) || line < 0) return null;
  const over = 1 / overPrice;
  const pOver = underPrice && underPrice > 1 ? over / (over + 1 / underPrice) : over;
  if (pOver <= 0 || pOver >= 1) return null;
  const pUnder = 1 - pOver;
  const k = Math.floor(line);
  if (k === 0) return -Math.log(pUnder);
  let low = 0;
  let high = k + 1;
  while (poissonCdf(k, high) > pUnder) high *= 2;
  for (let iteration = 0; iteration < 100; iteration++) {
    const mid = (low + high) / 2;
    if (poissonCdf(k, mid) > pUnder) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Canonical line keys: 0.5 → "0.5", 1 → "1.0" (never array-index-like, so insertion order holds). */
function lineKey(line: number): string {
  return Number.isInteger(line) ? line.toFixed(1) : String(line);
}

/** One bookmaker's lines grouped by market and line; later rows win (backend statLinesToMarkets). */
function linesToMarkets(lines: PlayerLine[]): Markets {
  const markets: Markets = new Map();
  for (const line of lines) {
    let market = markets.get(line.market);
    if (!market) markets.set(line.market, (market = new Map()));
    const key = lineKey(line.lineValue);
    const existing = market.get(key);
    const next = { line: line.lineValue, overPrice: line.overDecimalOdds, underPrice: line.underDecimalOdds };
    // Same semantics as mutating the existing object: key keeps its original position.
    if (existing) Object.assign(existing, next);
    else market.set(key, next);
  }
  return markets;
}

/** Overround of a two-sided line: 1/over + 1/under − 1 (0.05 = 5% margin). */
export function lineMargin(overPrice: number, underPrice: number): number {
  return 1 / overPrice + 1 / underPrice - 1;
}

/**
 * One bookmaker's curve for one stat with its margin removed. Each line's fair Over
 * price is over × (1 + margin). Two-sided lines use their own margin; Over-only lines use
 * the median margin of the curve's two-sided lines (never below 0). A curve with no Under
 * prices is returned unchanged, so it stays all raw rather than mixing raw and fair points.
 */
export function removeVig<T extends MarketLine>(lines: T[]): T[] {
  const margins = lines
    .filter((line) => line.overPrice && line.underPrice)
    .map((line) => lineMargin(line.overPrice!, line.underPrice!))
    .sort((a, b) => a - b);
  if (!margins.length) return lines;
  const middle = Math.floor(margins.length / 2);
  const median = margins.length % 2 ? margins[middle] : (margins[middle - 1] + margins[middle]) / 2;
  const fill = Math.max(0, median);
  return lines.map((line) => {
    if (!line.overPrice) return line;
    const margin = line.underPrice ? lineMargin(line.overPrice, line.underPrice) : fill;
    return { ...line, overPrice: line.overPrice * (1 + margin) };
  });
}

/** Smallest relative drop in Over probability a curve's top line needs over the line below it. */
const minTailProbabilityDrop = 0.1;
/** Only lines with an Over probability below this can be trimmed as a capped tail. */
const maxCappedLineProbability = 0.2;

/**
 * Drops a capped tail (backend cutCappedTail): from the top, removes each long-shot line
 * whose Over probability is less than 10% below the line under it — the book has hit its
 * price cap. Returns the priced lines sorted by line.
 */
function cutCappedTail<T extends MarketLine>(lines: T[]): T[] {
  const sorted = lines.filter((line) => line.overPrice).sort((a, b) => a.line - b.line);
  let end = sorted.length;
  while (end > 1) {
    const [below, top] = [sorted[end - 2].overPrice!, sorted[end - 1].overPrice!];
    const longShot = 1 / top < maxCappedLineProbability;
    if (!longShot || below / top <= 1 - minTailProbabilityDrop) break;
    end--;
  }
  return sorted.slice(0, end);
}

/** Lowest-line Over probability a curve needs to count (see coversMedian). */
const minLowestLineProbability = 0.35;

/**
 * Whether a vig-free curve reaches the middle of the distribution (backend coversMedian):
 * its lowest line must be under 1 or have a fair Over probability of at least 35%, since
 * the estimator treats everything below the lowest line as certain.
 */
function coversMedian(fairLines: MarketLine[]): boolean {
  const lowest = fairLines.reduce<MarketLine | undefined>(
    (min, line) => (line.overPrice && (!min || line.line < min.line) ? line : min),
    undefined,
  );
  if (!lowest) return false;
  return lowest.line < 1 || 1 / lowest.overPrice! >= minLowestLineProbability;
}

/**
 * Yardage stats, projected by each bookmaker's median rather than its mean (backend
 * MEDIAN_STATS): yardage has a long right tail where prices are least reliable, and the
 * median depends only on the lines near 50%, so these curves skip the mean's guards.
 */
const medianStats = new Set<StatKey>(["passingYards", "rushingYards", "receivingYards"]);

/**
 * Median of a vig-free curve (backend curveMedian): where the Over probability crosses
 * 50%, by a straight line between the two lines either side of it. Null unless the curve
 * has lines on both sides of 50%.
 */
function curveMedian(fairLines: MarketLine[]): number | null {
  const points = fairLines
    .filter((line) => line.overPrice && line.overPrice > 1)
    .map((line) => ({ line: line.line, p: 1 / line.overPrice! }))
    .sort((a, b) => a.line - b.line);
  // Over probabilities can't rise with the line; smooth out book noise.
  for (let index = 1; index < points.length; index++) points[index].p = Math.min(points[index].p, points[index - 1].p);
  for (let index = 1; index < points.length; index++) {
    const [below, above] = [points[index - 1], points[index]];
    if (below.p >= 0.5 && above.p <= 0.5) {
      if (below.p === above.p) return below.line;
      return below.line + ((below.p - 0.5) / (below.p - above.p)) * (above.line - below.line);
    }
  }
  return null;
}

/** Count stats whose single line may be fit to a Poisson; total TDs always use one (backend POISSON_STATS). */
const poissonStats = new Set<StatKey>(["passingTouchdowns", "interceptions", "receptions"]);

/**
 * Stats projected only from these bookmakers (backend config stat_bookmakers): only
 * DraftKings posts full kicking ladders.
 */
const statBookmakers: Partial<Record<StatKey, string[]>> = { kickingPoints: ["DraftKings"] };

const marketBookmakers = new Map(
  (Object.entries(statBookmakers) as [Exclude<StatKey, "touchdowns">, string[]][]).flatMap(([stat, bookmakers]) => {
    const market = statBaseMarkets[stat];
    return [
      [market, bookmakers],
      [`${market}_alternate`, bookmakers],
    ] as const;
  }),
);

/** Drops lines from bookmakers a stat isn't projected from (backend filterProjectionLines). */
export function filterProjectionLines<T extends { bookmaker: string; market: string }>(rows: T[]): T[] {
  return rows.filter((row) => marketBookmakers.get(row.market)?.includes(row.bookmaker) ?? true);
}

/** Lines of `marketKeys` merged in order; later markets win on the same line. */
function mergeLines(markets: Markets, marketKeys: string[]): SourcedLine[] {
  const merged = new Map<string, SourcedLine>();
  for (const market of marketKeys) {
    for (const [key, line] of markets.get(market) ?? []) merged.set(key, { ...line, market });
  }
  return [...merged.values()];
}

/** One bookmaker's curve for one stat, before guards and vig removal (backend statCurves). */
type StatCurve = { lines: SourcedLine[]; poissonFallback: boolean; median: boolean };

function statCurve(markets: Markets, stat: StatKey): StatCurve {
  if (stat === "touchdowns") {
    // Total TDs: the anytime-TD line alone (P(TDs ≥ 1)), fit to a Poisson.
    const anytime = mergeLines(markets, ["player_anytime_td"]).filter((line) => line.line === 0.5 && line.overPrice);
    return { lines: anytime, poissonFallback: true, median: false };
  }
  const base = statBaseMarkets[stat];
  // Alternate lines plus the main O/U line; the main line's price wins on the same line.
  return {
    lines: mergeLines(markets, [`${base}_alternate`, base]),
    poissonFallback: poissonStats.has(stat),
    median: medianStats.has(stat),
  };
}

/**
 * A curve's estimate from two or more lines, margin removed (backend usableCurve). With
 * `median`, the curve's median over every line. Otherwise its mean, after cutting a capped
 * tail and skipping curves that don't reach the median. Null with fewer than two lines.
 */
function usableCurve(lines: SourcedLine[], median: boolean): number | null {
  if (median) return lines.length >= 2 ? curveMedian(removeVig(lines)) : null;
  const used = cutCappedTail(lines);
  if (used.length < 2) return null;
  const fair = removeVig(used);
  return coversMedian(fair) ? calcExpectedStatFromAlternate(fair) : null;
}

/**
 * One curve's estimate (backend estimateCurve): usableCurve, or else, for a curve left
 * with a single line (after trimming a capped tail) that allows it, a Poisson fit of
 * that line. Null when the curve can't be estimated.
 */
function estimateCurve({ lines, poissonFallback, median }: StatCurve): number | null {
  const usable = usableCurve(lines, median);
  if (usable !== null || !poissonFallback) return usable;
  const trimmed = cutCappedTail(lines);
  if (trimmed.length !== 1) return null;
  const [line] = trimmed;
  return poissonMeanFromLine(line.line, line.overPrice, line.underPrice);
}

/** Whether a stat is projected by each bookmaker's median (yardage) rather than its mean. */
export function isMedianStat(stat: StatKey): boolean {
  return medianStats.has(stat);
}

/** One bookmaker's expected value for one stat (null when it can't be estimated). */
function expectedStatForBookmaker(markets: Markets, stat: StatKey): number | null {
  return estimateCurve(statCurve(markets, stat));
}

function groupByBookmaker(lines: PlayerLine[]): Map<string, PlayerLine[]> {
  const byBook = new Map<string, PlayerLine[]>();
  for (const line of lines) byBook.set(line.bookmaker, [...(byBook.get(line.bookmaker) ?? []), line]);
  return byBook;
}

export type BookmakerMean = { bookmaker: string; mean: number };

/**
 * Each bookmaker's expected value for one stat, from all of that bookmaker's lines.
 * Bookmakers with lines for the stat but no estimate are listed as excluded; `average`
 * is the projection before any TD scaling (mean over bookmakers that produced one).
 */
export function bookmakerMeans(
  lines: PlayerLine[],
  stat: StatKey,
  statOfMarket: (market: string) => StatKey | undefined,
): { means: BookmakerMean[]; excluded: string[]; average: number | null } {
  const means: BookmakerMean[] = [];
  const excluded: string[] = [];
  for (const [bookmaker, bookLines] of groupByBookmaker(filterProjectionLines(lines))) {
    if (!bookLines.some((line) => statOfMarket(line.market) === stat)) continue;
    const mean = expectedStatForBookmaker(linesToMarkets(bookLines), stat);
    if (mean === null) excluded.push(bookmaker);
    else means.push({ bookmaker, mean });
  }
  const average = means.length > 0 ? means.reduce((total, item) => total + item.mean, 0) / means.length : null;
  return { means, excluded, average };
}

const statKeys: StatKey[] = [
  "passingYards",
  "passingTouchdowns",
  "interceptions",
  "rushingYards",
  "receptions",
  "receivingYards",
  "touchdowns",
  "kickingPoints",
];

/**
 * Projected stat line from a player's raw lines (backend computeExpectedStats per
 * bookmaker, then averageExpectedStats), before TD scaling. Stats no bookmaker can
 * estimate are 0.
 */
export function projectStatsFromLines(lines: PlayerLine[]): PlayerStats {
  const perBookmaker = [...groupByBookmaker(filterProjectionLines(lines)).values()].map((bookLines) => {
    const markets = linesToMarkets(bookLines);
    return statKeys.map((stat) => expectedStatForBookmaker(markets, stat));
  });
  const stats = {} as PlayerStats;
  statKeys.forEach((stat, index) => {
    const values = perBookmaker.map((row) => row[index]).filter((value): value is number => value !== null);
    stats[stat] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  });
  return stats;
}

/**
 * Typical ratio of a team's projected TDs (from anytime prices, which carry margin) to
 * the TDs its game lines imply; the backend's fallback when a team has no scale
 * (config td_calibration_fallback_ratio).
 */
export const tdCalibrationFallbackRatio = 1.33;

/** TDs scaled to the team's game lines (backend scaleTds): × the team's factor, or the fallback. */
export function applyTdFactor(stats: PlayerStats, factor: number | null): PlayerStats {
  return { ...stats, touchdowns: stats.touchdowns * (factor ?? 1 / tdCalibrationFallbackRatio) };
}

/**
 * One bookmaker's curve for one stat (already merged: alternates + main line, anytime TD as
 * the 0.5 line) with its margin removed, exactly as the projection does — for display.
 * Each line's overDecimalOdds becomes the fair price; the original is kept as rawOverDecimalOdds.
 */
export function removeVigFromCurve<T extends PlayerLine>(curve: T[]): (T & { rawOverDecimalOdds: number })[] {
  const fair = removeVig(
    curve.map((line) => ({ line: line.lineValue, overPrice: line.overDecimalOdds, underPrice: line.underDecimalOdds })),
  );
  return curve.map((line, index) => ({
    ...line,
    overDecimalOdds: fair[index].overPrice ?? line.overDecimalOdds,
    rawOverDecimalOdds: line.overDecimalOdds,
  }));
}

/** Margin summary for one bookmaker across all its two-sided (over + under) lines. */
export type BookmakerVig = { bookmaker: string; median: number | null; average: number | null; twoSidedLines: number };

export function bookmakerVig(lines: PlayerLine[]): BookmakerVig[] {
  return [...groupByBookmaker(lines)].map(([bookmaker, bookLines]) => {
    const margins = bookLines
      .filter((line) => line.underDecimalOdds !== null)
      .map((line) => lineMargin(line.overDecimalOdds, line.underDecimalOdds!))
      .sort((a, b) => a - b);
    if (margins.length === 0) return { bookmaker, median: null, average: null, twoSidedLines: 0 };
    const middle = Math.floor(margins.length / 2);
    const median = margins.length % 2 ? margins[middle] : (margins[middle - 1] + margins[middle]) / 2;
    const average = margins.reduce((total, margin) => total + margin, 0) / margins.length;
    return { bookmaker, median, average, twoSidedLines: margins.length };
  });
}
