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

export type Player = {
  id: string;
  gameId: string;
  name: string;
  position: Position;
  team: string;
  opponent: string;
  stats: PlayerStats;
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


const serverStatKeys: Record<keyof PlayerStats, string> = {
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

function parseStats(value: unknown): PlayerStats | undefined {
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
  if (!isRecord(value) || typeof value.start !== "string" || typeof value.end !== "string") {
    return null;
  }
  const start = new Date(value.start);
  const end = new Date(value.end);
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

  return { week: parseWeek(data.week, data.games), updatedAt: parseUpdatedAt(data), players };
}
