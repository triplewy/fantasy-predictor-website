import { fetchAsUser, functionUrl } from "../supabase";
import {
  parseDistributionFunction,
  parseNumberArray,
  type DistributionFunction,
} from "./rankings";

/** Projected D/ST stats for one team's game this week. */
export type TeamStats = {
  /** Expected D/ST touchdowns; null when no bookmaker offers D/ST props. */
  touchdowns: number | null;
  /** The opponent's implied score from the game's spreads and totals; null without both. */
  pointsAllowed: number | null;
  /** The opponent's expected passing + rushing yards (from player props); null without any. */
  yardsAllowed: number | null;
  /** The opponent's expected interceptions thrown (from player props); null without any. */
  interceptions: number | null;
  /** The team's own defenders' expected sacks (from sack props); null without any. */
  sacks: number | null;
};

export type TeamProjection = {
  /** Team ID (abbreviation), e.g. "KC". */
  team: string;
  matchup: string;
  opponent: string;
  /** Projected game total and team-perspective spread from project-games. */
  gameTotal: number | null;
  spread: number | null;
  stats: TeamStats;
  /** Fitted game curves ("totals", "spreads") with fair Over probabilities per line. */
  markets: TeamMarket[];
};

/** One fitted game market's stat lines and distribution function. */
export type TeamMarket = {
  market: string;
  bookmaker: string;
  line_values: number[];
  /** Fair (vig-removed) probability the game stat lands Over each line value, same order. */
  fair_over_probabilities: number[];
  distribution_function: DistributionFunction;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** null/undefined → null; numbers (or numeric strings) → number; anything else is invalid. */
function parseNullableStat(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** "GB @ NE" → "@ NE" for GB, "vs GB" for NE. */
function parseOpponent(matchup: string, team: string): string {
  const [away, home] = matchup.split("@").map((part) => part.trim());
  if (!away || !home) return matchup;
  if (team === away) return `@ ${home}`;
  if (team === home) return `vs ${away}`;
  return matchup;
}

function parseTeam(value: unknown): TeamProjection | undefined {
  if (!isRecord(value) || typeof value.team !== "string" || typeof value.matchup !== "string") return undefined;
  if (!isRecord(value.stats)) return undefined;
  const gameTotal = parseNullableStat(value.stats.total ?? value.stats.game_total ?? value.game_total ?? value.total);
  const spread = parseNullableStat(value.stats.spread ?? value.spread);
  if (gameTotal === undefined || spread === undefined) return undefined;

  const [away, home] = value.matchup.split("@").map((part) => part.trim());
  const isHomeTeam = value.team === home && value.team !== away;

  const pointsAllowed =
    value.stats.points_allowed !== undefined
      ? parseNullableStat(value.stats.points_allowed)
      : gameTotal !== null && spread !== null
        ? (gameTotal + spread) / 2
        : null;
  if (pointsAllowed === undefined) return undefined;

  const touchdowns = parseNullableStat(value.stats.player_tds);
  const yardsAllowed = parseNullableStat(value.stats.yards_allowed);
  const interceptions = parseNullableStat(value.stats.interceptions);
  const sacks = parseNullableStat(value.stats.sacks);

  return {
    team: value.team,
    matchup: value.matchup,
    opponent: parseOpponent(value.matchup, value.team),
    gameTotal,
    spread,
    stats: {
      touchdowns: touchdowns ?? null,
      pointsAllowed,
      yardsAllowed: yardsAllowed ?? null,
      interceptions: interceptions ?? null,
      sacks: sacks ?? null,
    },
    markets: parseTeamMarkets(value.markets, isHomeTeam),
  };
}

/**
 * The backend's "spreads" curve is the home-margin distribution, shared by both teams.
 * For the home team (whose spread is the negated margin), mirror the curve so line values
 * and Over probabilities are expressed from that team's own spread perspective.
 */
function parseTeamMarkets(raw: unknown, isHomeTeam: boolean): TeamMarket[] {
  return parseTeamMarketsRaw(raw).map((market) => {
    if (!isHomeTeam || market.market !== "spreads") return market;
    const line_values = [...market.line_values].map((value) => -value).reverse();
    const fair_over_probabilities = [...market.fair_over_probabilities]
      .map((probability) => 1 - probability)
      .reverse();
    return { ...market, line_values, fair_over_probabilities };
  });
}

function parseTeamMarketsRaw(raw: unknown): TeamMarket[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (typeof entry.market !== "string" || typeof entry.bookmaker !== "string") return [];
    const lineValues = parseNumberArray(entry.line_values);
    const probabilities = parseNumberArray(entry.fair_over_probabilities);
    if (!lineValues || !probabilities || lineValues.length === 0 || probabilities.length !== lineValues.length) return [];
    const distributionFunction = parseDistributionFunction(entry.distribution_function);
    if (!distributionFunction) return [];
    return [
      {
        market: entry.market,
        bookmaker: entry.bookmaker,
        line_values: lineValues,
        fair_over_probabilities: probabilities,
        distribution_function: distributionFunction,
      },
    ];
  });
}


/** D/ST projections for the NFL week [from, to); the API takes both as ISO 8601 timestamps. */
export async function getTeamProjections(
  week: { from: Date; to: Date },
  signal?: AbortSignal,
): Promise<TeamProjection[]> {
  const url = functionUrl("project-teams");
  url.searchParams.set("from", week.from.toISOString());
  url.searchParams.set("to", week.to.toISOString());
  const response = await fetchAsUser(url, signal);
  if (!response.ok) {
    throw new Error(`Could not load D/ST projections (server returned ${response.status}).`);
  }
  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.teams)) {
    throw new Error("Could not load D/ST projections: the server returned an invalid response.");
  }
  const teams: TeamProjection[] = [];
  let invalidCount = 0;
  for (const entry of data.teams) {
    const team = parseTeam(entry);
    if (team) teams.push(team);
    else invalidCount += 1;
  }
  if (invalidCount > 0) console.warn(`Skipped ${invalidCount} D/ST projection(s) with invalid data.`);
  if (teams.length === 0 && invalidCount > 0) {
    throw new Error("Could not load D/ST projections: the server returned an invalid response.");
  }
  return teams;
}
