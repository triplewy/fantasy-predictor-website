import { fetchAsUser, functionUrl } from "../supabase";

export type Position = "QB" | "RB" | "WR" | "TE" | "K";

/** Projected weekly stat line. Stats the server doesn't project are 0. */
export type PlayerStats = {
  passingYards: number;
  passingTouchdowns: number;
  interceptions: number;
  rushingYards: number;
  receptions: number;
  receivingYards: number;
  /** Combined rushing + receiving touchdowns. */
  touchdowns: number;
  /** Kicker projections arrive already converted to fantasy points. */
  kickingPoints: number;
};

/** Fitted distribution behind one market's fair Over probabilities. */
export type DistributionFunction = {
  family: "normal" | "lognormal" | "gamma";
  parameters: Record<string, number>;
  support: "nonnegative" | "real";
  /** The distribution's mean — what feeds the player's projected stat. */
  mean: number;
  /** Leave-one-out MSE of the fit. */
  loo_mse: number;
};

/** One fitted stat market for a player, from the priority bookmaker for that market. */
export type PlayerMarket = {
  market: string;
  bookmaker: string;
  line_values: number[];
  /** Fair (vig-removed) probability the stat lands Over each line value, same order. */
  fair_over_probabilities: number[];
  distribution_function: DistributionFunction;
};

export type Player = {
  id: string;
  gameId: string;
  name: string;
  position: Position;
  team: string;
  opponent: string;
  stats: PlayerStats;
  markets: PlayerMarket[];
  /** Newest `last_updated_at` across the player's markets. */
  lastUpdatedAt: Date | null;
};

export type ProjectionWeek = {
  start: Date;
  end: Date;
  games: number;
};

export type PlayerProjections = {
  week: ProjectionWeek | null;
  /** When the projections were last updated (`last_updated_at`), if the API sends it. */
  updatedAt: Date | null;
  players: Player[];
};


/** Our stat keys → the API's stat keys (project-players, player-lines). */
export const serverStatKeys: Record<keyof PlayerStats, string> = {
  passingYards: "pass_yds",
  passingTouchdowns: "pass_tds",
  interceptions: "pass_int",
  rushingYards: "rush_yds",
  receptions: "receptions",
  receivingYards: "rec_yds",
  touchdowns: "player_tds",
  kickingPoints: "kicking_points",
};

// Fullbacks are scored as running backs; other positions (e.g. defensive players) are skipped.
const positionMap: Record<string, Position> = {
  QB: "QB",
  RB: "RB",
  FB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStat(value: unknown): number | undefined {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The API's stats object → PlayerStats (null stats become 0); undefined when invalid. */
export function parseStats(value: unknown): PlayerStats | undefined {
  if (!isRecord(value)) return undefined;
  const stats = {} as PlayerStats;
  for (const [key, serverKey] of Object.entries(serverStatKeys) as [keyof PlayerStats, string][]) {
    const stat = parseStat(value[serverKey]);
    if (stat === undefined) return undefined;
    stats[key] = stat;
  }
  return stats;
}

/** "GB @ NE" → "@ NE" for GB, "vs GB" for NE. */
function parseOpponent(matchup: string, team: string): string {
  const [away, home] = matchup.split("@").map((part) => part.trim());
  if (!away || !home) return matchup;
  if (team === away) return `@ ${home}`;
  if (team === home) return `vs ${away}`;
  return matchup;
}

export function parseDistributionFunction(value: unknown): DistributionFunction | undefined {
  if (!isRecord(value)) return undefined;
  const { family, parameters, support, mean, loo_mse } = value;
  if (family !== "normal" && family !== "lognormal" && family !== "gamma") return undefined;
  if (support !== "nonnegative" && support !== "real") return undefined;
  if (typeof mean !== "number" || !Number.isFinite(mean)) return undefined;
  if (typeof loo_mse !== "number" || !Number.isFinite(loo_mse)) return undefined;
  const parsedParameters: Record<string, number> = {};
  if (isRecord(parameters)) {
    for (const [key, parameter] of Object.entries(parameters)) {
      if (typeof parameter === "number" && Number.isFinite(parameter)) parsedParameters[key] = parameter;
    }
  }
  return { family, parameters: parsedParameters, support, mean, loo_mse };
}

export function parseNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.map((item) => (typeof item === "number" ? item : Number(item)));
  return numbers.every((item) => Number.isFinite(item)) ? numbers : undefined;
}

function parseMarket(value: unknown): PlayerMarket | undefined {
  if (!isRecord(value)) return undefined;
  const { market, bookmaker } = value;
  if (typeof market !== "string" || typeof bookmaker !== "string") return undefined;
  const line_values = parseNumberArray(value.line_values);
  const fair_over_probabilities = parseNumberArray(value.fair_over_probabilities);
  const distribution_function = parseDistributionFunction(value.distribution_function);
  if (!line_values || !fair_over_probabilities || !distribution_function) return undefined;
  if (line_values.length !== fair_over_probabilities.length) return undefined;
  return { market, bookmaker, line_values, fair_over_probabilities, distribution_function };
}

function parseMarkets(value: unknown): PlayerMarket[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseMarket).filter((market): market is PlayerMarket => market !== undefined);
}

function parsePlayer(value: unknown): Player | "unsupported-position" | undefined {
  if (!isRecord(value)) return undefined;
  const { player_id, game_id, player, team, position, matchup } = value;
  if (
    typeof player_id !== "string" ||
    typeof game_id !== "string" ||
    typeof player !== "string" ||
    typeof team !== "string" ||
    typeof position !== "string" ||
    typeof matchup !== "string"
  ) {
    return undefined;
  }

  const mappedPosition = positionMap[position];
  if (!mappedPosition) return "unsupported-position";

  const stats = parseStats(value.stats);
  if (!stats) return undefined;

  return {
    id: player_id,
    gameId: game_id,
    name: player,
    position: mappedPosition,
    team,
    opponent: parseOpponent(matchup, team),
    stats,
    markets: parseMarkets(value.markets),
    lastUpdatedAt: parseTimestamp(value.last_updated_at),
  };
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `last_updated_at` from the top level of the response, or else the newest one on the
 * individual players. Null if neither is present or valid.
 */
function parseUpdatedAt(data: Record<string, unknown>): Date | null {
  const topLevel = parseTimestamp(data.last_updated_at);
  if (topLevel) return topLevel;
  const playerTimes = (Array.isArray(data.players) ? data.players : [])
    .map((player) => (isRecord(player) ? parseTimestamp(player.last_updated_at) : null))
    .filter((date): date is Date => date !== null)
    .map((date) => date.getTime());
  return playerTimes.length > 0 ? new Date(Math.max(...playerTimes)) : null;
}

function parseWeek(value: unknown, games: unknown): ProjectionWeek | null {
  if (!isRecord(value)) {
    return null;
  }
  const startRaw = value.start ?? value.from;
  const endRaw = value.end ?? value.to;
  if (typeof startRaw !== "string" || typeof endRaw !== "string") {
    return null;
  }
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end, games: typeof games === "number" ? games : 0 };
}

/** Projections for the NFL week [from, to); the API takes both as ISO 8601 timestamps. */
export async function getPlayerProjections(
  week: { from: Date; to: Date },
  signal?: AbortSignal,
): Promise<PlayerProjections> {
  const url = functionUrl("project-players");
  url.searchParams.set("from", week.from.toISOString());
  url.searchParams.set("to", week.to.toISOString());
  const response = await fetchAsUser(url, signal);
  if (!response.ok) {
    throw new Error(`Could not load player projections (server returned ${response.status}).`);
  }

  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.players)) {
    throw new Error("Could not load player projections: the server returned an invalid response.");
  }

  const players: Player[] = [];
  let invalidCount = 0;
  for (const entry of data.players) {
    const player = parsePlayer(entry);
    if (player === "unsupported-position") continue;
    if (!player) {
      invalidCount += 1;
      continue;
    }
    players.push(player);
  }

  if (invalidCount > 0) {
    console.warn(`Skipped ${invalidCount} player projection(s) with invalid data.`);
  }
  if (players.length === 0 && invalidCount > 0) {
    throw new Error("Could not load player projections: the server returned an invalid response.");
  }

  return { week: parseWeek(data.window ?? data.week, data.games), updatedAt: parseUpdatedAt(data), players };
}
