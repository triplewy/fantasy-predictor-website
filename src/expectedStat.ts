import type { PlayerLine } from "./api/playerLines";

/**
 * Estimate a stat by summing raw implied probabilities from alternate Over odds.
 *
 * Mirrors the backend's `calcExpectedStatFromAlternate` exactly, so each bookmaker's
 * mean here averages to the projection the API returns. Each Over price is treated as
 * the probability of exceeding its line, mapping a line to the next integer outcome
 * threshold (half-point lines round up). Missing integer thresholds are interpolated,
 * probability is 1 below the first threshold, and the tail is extrapolated exponentially
 * from the last two observed points. Returns null if fewer than two usable lines exist.
 *
 * Lines must be in API order: when two lines map to the same threshold, the later wins,
 * as on the backend.
 */
export function calcExpectedStatFromAlternate(
  alternateLines: { lineValue: number; overDecimalOdds: number }[],
): number | null {
  const probabilitiesByThreshold = new Map<number, number>();
  for (const { lineValue, overDecimalOdds } of alternateLines) {
    probabilitiesByThreshold.set(Math.floor(lineValue) + 1, 1 / overDecimalOdds);
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

export type BookmakerMean = { bookmaker: string; mean: number };

/**
 * Each bookmaker's expected value for one stat, from all its lines for that stat
 * (e.g. anytime TD + total TDs combined), as the backend does. Books with fewer than
 * two usable lines are left out, so `average` matches the API's projection.
 */
export function bookmakerMeans(lines: PlayerLine[]): {
  means: BookmakerMean[];
  excluded: string[];
  average: number | null;
} {
  const byBook = new Map<string, PlayerLine[]>();
  for (const line of lines) {
    byBook.set(line.bookmaker, [...(byBook.get(line.bookmaker) ?? []), line]);
  }
  const means: BookmakerMean[] = [];
  const excluded: string[] = [];
  for (const [bookmaker, bookLines] of byBook) {
    const mean = calcExpectedStatFromAlternate(bookLines);
    if (mean === null) excluded.push(bookmaker);
    else means.push({ bookmaker, mean });
  }
  const average = means.length > 0 ? means.reduce((total, item) => total + item.mean, 0) / means.length : null;
  return { means, excluded, average };
}
