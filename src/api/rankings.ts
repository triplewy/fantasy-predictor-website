import { fetchAsUser, functionUrl } from "../supabase";
import { getWeeksRemaining } from "../nflWeek";
import {
  getPointsBreakdown,
  getStatPoints,
  scoringPresets,
  type ScoringSettings,
} from "../scoring";

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
  family: "normal" | "lognormal" | "gamma" | "simple";
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
  /** Actual season-to-date stat, supplied for futures markets. */
  seasonToDate?: number;
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
  touchdowns: "tds",
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
  if (
    family !== "normal" &&
    family !== "lognormal" &&
    family !== "gamma" &&
    family !== "simple"
  ) {
    return undefined;
  }
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
  const seasonToDate = value.season_to_date;
  return {
    market,
    bookmaker,
    line_values,
    fair_over_probabilities,
    distribution_function,
    ...(typeof seasonToDate === "number" && Number.isFinite(seasonToDate) ? { seasonToDate } : {}),
  };
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

type SeasonStat = { key: string; label: string; value: number };

/** A season-to-date stat row, keyed by the market that produced it. */
export type SeasonStatEntry = { market: string; label: string; value: number };

export type SeasonBreakdownItem = SeasonStatEntry & { points: number };

/** Full-season futures and rest-of-season projections for a season (e.g. "season-2026"). */
export type SeasonPlayer = {
  id: string;
  name: string;
  position: Position;
  team: string;
  /** Rest-of-season stats used for ranking. */
  stats: PlayerStats;
  /** Total season projected stats (full season). */
  totalSeasonStats: PlayerStats;
  fullSeasonStats: SeasonStat[];
  seasonToDateStats: SeasonStatEntry[];
  markets: PlayerMarket[];
  lastUpdatedAt: Date | null;
};

/** Kalshi full-season contracts and their ranking stat keys. */
const seasonMarketInfo: Partial<Record<string, { stat: keyof PlayerStats; label: string }>> = {
  player_pass_yds: { stat: "passingYards", label: "pass yds" },
  player_pass_tds: { stat: "passingTouchdowns", label: "pass TD" },
  player_rush_yds: { stat: "rushingYards", label: "rush yds" },
  player_rush_tds: { stat: "touchdowns", label: "rush TD" },
  player_rec_yds: { stat: "receivingYards", label: "rec yds" },
  player_reception_yds: { stat: "receivingYards", label: "rec yds" },
  player_rec_tds: { stat: "touchdowns", label: "rec TD" },
  player_receptions: { stat: "receptions", label: "rec" },
  player_tds: { stat: "touchdowns", label: "TD" },
};

/** Map market names to stat keys for breakdown lookup */
export const marketToStatKey: Record<string, keyof PlayerStats> = {
  player_pass_yds: "passingYards",
  player_pass_tds: "passingTouchdowns",
  player_rush_yds: "rushingYards",
  player_rush_tds: "touchdowns",
  player_rec_yds: "receivingYards",
  player_reception_yds: "receivingYards",
  player_rec_tds: "touchdowns",
  player_receptions: "receptions",
  player_tds: "touchdowns",
  player_kicking_points: "kickingPoints",
};

/** Canonical stat order matching getPointsBreakdown in scoring.ts */
const statSortOrder: Record<string, number> = {
  passingYards: 1,
  player_pass_yds: 1,
  passingTouchdowns: 2,
  player_pass_tds: 2,
  interceptions: 3,
  player_pass_int: 3,
  rushingYards: 4,
  player_rush_yds: 4,
  player_rush_tds: 5,
  receptions: 6,
  player_receptions: 6,
  receivingYards: 7,
  player_rec_yds: 7,
  player_reception_yds: 7,
  player_rec_tds: 8,
  touchdowns: 9,
  player_tds: 9,
  kickingPoints: 10,
  player_kicking_points: 10,
};

/** Break down points per season-to-date stat independently. */
export function getSeasonStatsBreakdown(
  seasonPlayer: SeasonPlayer,
  settings: ScoringSettings = scoringPresets.PPR,
): SeasonBreakdownItem[] {
  return seasonPlayer.seasonToDateStats
    .map((stat) => {
      const statKey = marketToStatKey[stat.market] ?? stat.market;
      return {
        ...stat,
        points: getStatPoints(statKey, stat.value, seasonPlayer.position, settings),
      };
    })
    .sort((a, b) => {
      const orderA = statSortOrder[a.market] ?? 99;
      const orderB = statSortOrder[b.market] ?? 99;
      return orderA - orderB;
    });
}

/** Calculate total points from full-season stats (season-to-date + rest-of-season projections) */
export function calculateSeasonProjectedTotal(
  seasonPlayer: SeasonPlayer,
  settings: ScoringSettings = scoringPresets.PPR,
): number {
  if (seasonPlayer.totalSeasonStats) {
    return getPointsBreakdown(seasonPlayer.totalSeasonStats, seasonPlayer.position, settings).reduce(
      (sum, item) => sum + item.points,
      0,
    );
  }
  const seasonStatsTotal = calculateSeasonStatsTotal(seasonPlayer, settings);
  const rosTotal = getPointsBreakdown(seasonPlayer.stats, seasonPlayer.position, settings).reduce(
    (sum, item) => sum + item.points,
    0,
  );
  return seasonStatsTotal + rosTotal;
}

/** Calculate total points from season-to-date stats independently */
export function calculateSeasonStatsTotal(
  seasonPlayer: SeasonPlayer,
  settings: ScoringSettings = scoringPresets.PPR,
): number {
  return getSeasonStatsBreakdown(seasonPlayer, settings).reduce((sum, stat) => sum + stat.points, 0);
}

/** Calculate projected points per remaining week (RoS projected total / weeks remaining) */
export function calculatePerWeekProjectedTotal(
  seasonPlayer: SeasonPlayer,
  settings: ScoringSettings = scoringPresets.PPR,
  weeksRemaining: number = getWeeksRemaining(),
): number {
  if (weeksRemaining <= 0) return 0;
  const rosTotal = getPointsBreakdown(seasonPlayer.stats, seasonPlayer.position, settings).reduce(
    (sum, item) => sum + item.points,
    0,
  );
  return rosTotal / weeksRemaining;
}

export type SeasonProjections = {
  season: string;
  updatedAt: Date | null;
  players: SeasonPlayer[];
};

function emptyStats(): PlayerStats {
  return {
    passingYards: 0,
    passingTouchdowns: 0,
    interceptions: 0,
    rushingYards: 0,
    receptions: 0,
    receivingYards: 0,
    touchdowns: 0,
    kickingPoints: 0,
  };
}

function playerStatsToSeasonStats(stats: PlayerStats): SeasonStat[] {
  return Object.entries(stats).map(([key, value]) => ({
    key,
    label: seasonMarketInfo[key]?.label ?? key.replace(/^player_/, "").replaceAll("_", " "),
    value,
  }));
}

function parseSeasonPlayer(value: unknown): SeasonPlayer | "unsupported-position" | undefined {
  if (!isRecord(value)) return undefined;
  const { player_id, player, team, position } = value;
  if (
    typeof player_id !== "string" ||
    typeof player !== "string" ||
    typeof team !== "string" ||
    typeof position !== "string"
  ) {
    return undefined;
  }

  const mappedPosition = positionMap[position];
  if (!mappedPosition) return "unsupported-position";

  const markets = parseMarkets(value.markets);

  // Support season_stats if present on value (new backend)
  const rawSeasonStats = isRecord(value.season_stats) ? value.season_stats : undefined;

  // Also support season_to_date on any raw market object in value.markets (current backend)
  const rawMarkets = Array.isArray(value.markets) ? value.markets : [];
  const marketActuals: Record<string, number> = {};
  for (const rawM of rawMarkets) {
    if (isRecord(rawM) && typeof rawM.market === "string") {
      const std = rawM.season_to_date;
      if (typeof std === "number" && Number.isFinite(std)) {
        marketActuals[rawM.market] = std;
      }
    }
  }

  const stats = emptyStats();
  const totalSeasonStats = emptyStats();
  const seasonToDateStats: SeasonPlayer["seasonToDateStats"] = [];

  // Season-to-date actuals from player season_stats (Sleeper) or market fields
  const passYds =
    (typeof rawSeasonStats?.pass_yds === "number" ? rawSeasonStats.pass_yds : undefined) ??
    marketActuals.player_pass_yds ??
    0;
  const passTds =
    (typeof rawSeasonStats?.pass_tds === "number" ? rawSeasonStats.pass_tds : undefined) ??
    marketActuals.player_pass_tds ??
    0;
  const rushYds =
    (typeof rawSeasonStats?.rush_yds === "number" ? rawSeasonStats.rush_yds : undefined) ??
    marketActuals.player_rush_yds ??
    0;
  const rushTds =
    (typeof rawSeasonStats?.rush_tds === "number" ? rawSeasonStats.rush_tds : undefined) ??
    marketActuals.player_rush_tds ??
    0;
  const recYds =
    (typeof rawSeasonStats?.rec_yds === "number" ? rawSeasonStats.rec_yds : undefined) ??
    marketActuals.player_rec_yds ??
    marketActuals.player_reception_yds ??
    0;
  const recTds =
    (typeof rawSeasonStats?.rec_tds === "number" ? rawSeasonStats.rec_tds : undefined) ??
    marketActuals.player_rec_tds ??
    0;
  const receptions =
    (typeof rawSeasonStats?.receptions === "number" ? rawSeasonStats.receptions : undefined) ??
    marketActuals.player_receptions ??
    0;

  const actualsByMarket: Record<string, number> = {
    player_pass_yds: passYds,
    player_pass_tds: passTds,
    player_rush_yds: rushYds,
    player_rush_tds: rushTds,
    player_rec_yds: recYds,
    player_reception_yds: recYds,
    player_rec_tds: recTds,
    player_receptions: receptions,
  };

  for (const { market, seasonToDate, distribution_function } of markets) {
    const info = Object.hasOwn(seasonMarketInfo, market) ? seasonMarketInfo[market] : undefined;
    if (!info) continue;

    const actual = seasonToDate ?? actualsByMarket[market] ?? 0;
    // Futures means are full-season totals; rest-of-season is remaining stats beyond actuals.
    const rosValue = Math.max(0, distribution_function.mean - actual);
    stats[info.stat] += rosValue;
  }

  // Full year projections combine season-to-date actuals with rest-of-season projections
  totalSeasonStats.passingYards = passYds + stats.passingYards;
  totalSeasonStats.passingTouchdowns = passTds + stats.passingTouchdowns;
  totalSeasonStats.rushingYards = rushYds + stats.rushingYards;
  totalSeasonStats.receptions = receptions + stats.receptions;
  totalSeasonStats.receivingYards = recYds + stats.receivingYards;
  totalSeasonStats.touchdowns = (rushTds + recTds) + stats.touchdowns;

  // Build seasonToDateStats for all recorded stats with non-zero values
  if (passYds > 0) {
    seasonToDateStats.push({ market: "player_pass_yds", label: "pass yds", value: passYds });
  }
  if (passTds > 0) {
    seasonToDateStats.push({ market: "player_pass_tds", label: "pass TD", value: passTds });
  }
  if (rushYds > 0) {
    seasonToDateStats.push({ market: "player_rush_yds", label: "rush yds", value: rushYds });
  }
  if (receptions > 0) {
    seasonToDateStats.push({ market: "player_receptions", label: "rec", value: receptions });
  }
  if (recYds > 0) {
    seasonToDateStats.push({ market: "player_rec_yds", label: "rec yds", value: recYds });
  }
  if (rushTds + recTds > 0) {
    seasonToDateStats.push({ market: "player_tds", label: "TD", value: rushTds + recTds });
  }

  return {
    id: player_id,
    name: player,
    position: mappedPosition,
    team,
    stats,
    totalSeasonStats,
    fullSeasonStats: playerStatsToSeasonStats(totalSeasonStats),
    seasonToDateStats,
    markets,
    lastUpdatedAt: parseTimestamp(value.last_updated_at),
  };
}

export async function getSeasonProjections(
  season: string,
  signal?: AbortSignal,
): Promise<SeasonProjections> {
  const url = functionUrl("project-futures");
  url.searchParams.set("season", season);
  const response = await fetchAsUser(url, signal);
  if (!response.ok) {
    throw new Error(`Could not load season projections (server returned ${response.status}).`);
  }

  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.players)) {
    throw new Error("Could not load season projections: the server returned an invalid response.");
  }

  const players: SeasonPlayer[] = [];
  let invalidCount = 0;
  for (const entry of data.players) {
    const player = parseSeasonPlayer(entry);
    if (player === "unsupported-position") continue;
    if (!player) {
      invalidCount += 1;
      continue;
    }
    players.push(player);
  }

  if (invalidCount > 0) {
    console.warn(`Skipped ${invalidCount} season projection(s) with invalid data.`);
  }
  if (players.length === 0 && invalidCount > 0) {
    throw new Error("Could not load season projections: the server returned an invalid response.");
  }

  return { season, updatedAt: parseUpdatedAt(data), players };
}
