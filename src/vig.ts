import type { PlayerLine } from "./api/playerLines";

/**
 * Bookmaker margin (vig), for displaying fair prices in the lines panel. Projections come
 * from the backend; this only mirrors its vig removal so the charts show the same curves.
 */

/** Overround of a two-sided line: 1/over + 1/under − 1 (0.05 = 5% margin). */
function lineMargin(overPrice: number, underPrice: number): number {
  return 1 / overPrice + 1 / underPrice - 1;
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * One bookmaker's curve for one stat (already merged: alternates + main line, anytime TD as
 * the 0.5 line) with its margin removed, as the backend does. Each line's fair Over price is
 * over × (1 + margin): two-sided lines use their own margin; Over-only lines use the median
 * margin of the curve's two-sided lines (never below 0). A curve with no Under prices stays
 * raw. The original price is kept as rawOverDecimalOdds.
 */
export function removeVigFromCurve<T extends PlayerLine>(curve: T[]): (T & { rawOverDecimalOdds: number })[] {
  const margins = curve
    .filter((line) => line.underDecimalOdds !== null)
    .map((line) => lineMargin(line.overDecimalOdds, line.underDecimalOdds!))
    .sort((a, b) => a - b);
  const fill = margins.length ? Math.max(0, median(margins)) : null;
  return curve.map((line) => {
    const margin =
      fill === null ? 0 : line.underDecimalOdds !== null ? lineMargin(line.overDecimalOdds, line.underDecimalOdds) : fill;
    return { ...line, overDecimalOdds: line.overDecimalOdds * (1 + margin), rawOverDecimalOdds: line.overDecimalOdds };
  });
}

/** Margin summary for one bookmaker across all its two-sided (over + under) lines. */
export type BookmakerVig = { bookmaker: string; median: number | null; average: number | null; twoSidedLines: number };

export function bookmakerVig(lines: PlayerLine[]): BookmakerVig[] {
  const byBook = new Map<string, number[]>();
  for (const line of lines) {
    const margins = byBook.get(line.bookmaker) ?? [];
    if (line.underDecimalOdds !== null) margins.push(lineMargin(line.overDecimalOdds, line.underDecimalOdds));
    byBook.set(line.bookmaker, margins);
  }
  return [...byBook].map(([bookmaker, margins]) => {
    if (margins.length === 0) return { bookmaker, median: null, average: null, twoSidedLines: 0 };
    margins.sort((a, b) => a - b);
    const average = margins.reduce((total, margin) => total + margin, 0) / margins.length;
    return { bookmaker, median: median(margins), average, twoSidedLines: margins.length };
  });
}
