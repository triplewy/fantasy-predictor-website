import type { PlayerLine } from "./api/playerLines";
import type { PlayerStats } from "./api/rankings";
import { statBaseMarkets } from "./markets";

/**
 * Projections from raw bookmaker lines, ported from the backend's projection engine
 * (project-players) so the frontend reproduces its numbers exactly:
 *
 *   lines → per bookmaker, per stat: alternate lines + main O/U line, margin removed
 *         → expected stat (calcExpectedStatFromAlternate)
 *         → each stat averaged over the bookmakers that cover it.
 *
 * Ordering matters: when two lines map to the same threshold the later one wins, so lines
 * are kept in API order and merged in the same order as the backend.
 */

/** One line of one bookmaker's curve (backend MarketLine). */
type MarketLine = { line: number; overPrice: number | null; underPrice: number | null };
/** market → (line key → line), in insertion order (backend Markets). */
type Markets = Map<string, Map<string, MarketLine>>;
type StatKey = keyof PlayerStats;

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
    probabilitiesByThreshold.set(Math.floor(line) + 1, 1 / overPrice);
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
export function removeVig(lines: MarketLine[]): MarketLine[] {
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

/** Expected stat from one bookmaker's curve, after removing its margin. */
function estimate(lines: MarketLine[]): number | null {
  return calcExpectedStatFromAlternate(removeVig(lines));
}

/** Lines of `marketKeys` merged in order; later markets win on the same line. */
function mergeLines(markets: Markets, marketKeys: string[]): Map<string, MarketLine> {
  const merged = new Map<string, MarketLine>();
  for (const key of marketKeys) {
    for (const [lineId, line] of markets.get(key) ?? []) merged.set(lineId, line);
  }
  return merged;
}

/** One bookmaker's expected value for one stat (null when it lacks enough lines). */
function expectedStatForBookmaker(markets: Markets, stat: StatKey): number | null {
  if (stat !== "touchdowns") {
    const base = statBaseMarkets[stat];
    // Alternate lines plus the main O/U line; the main line's price wins on the same line.
    return estimate([...mergeLines(markets, [`${base}_alternate`, base]).values()]);
  }
  // Total touchdowns: player_tds_over plus player_anytime_td as the 0.5 line (anytime wins).
  const tdLines = new Map(markets.get("player_tds_over") ?? []);
  const anytime = markets.get("player_anytime_td")?.get("0.5");
  if (anytime) tdLines.set("0.5", anytime);
  // The 0.5 line (P(TDs ≥ 1)) is required; without it the estimator assumes a TD is certain.
  return tdLines.get("0.5")?.overPrice == null ? null : estimate([...tdLines.values()]);
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
 * is the projection (mean over bookmakers that produced one).
 */
export function bookmakerMeans(
  lines: PlayerLine[],
  stat: StatKey,
  statOfMarket: (market: string) => StatKey | undefined,
): { means: BookmakerMean[]; excluded: string[]; average: number | null } {
  const means: BookmakerMean[] = [];
  const excluded: string[] = [];
  for (const [bookmaker, bookLines] of groupByBookmaker(lines)) {
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
 * bookmaker, then averageExpectedStats). Stats no bookmaker can estimate are 0.
 */
export function projectStatsFromLines(lines: PlayerLine[]): PlayerStats {
  const perBookmaker = [...groupByBookmaker(lines).values()].map((bookLines) => {
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
