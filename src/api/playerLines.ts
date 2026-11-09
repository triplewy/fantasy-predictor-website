import { fetchAsUser, functionUrl } from "../supabase";
import { parseStats, serverStatKeys, type PlayerStats } from "./rankings";

export type PlayerLine = {
  bookmaker: string;
  /** e.g. "player_rush_yds_alternate", "player_rush_yds" (main O/U line) or "player_anytime_td". */
  market: string;
  lineValue: number;
  /** Decimal odds for the over at this line. */
  overDecimalOdds: number;
  /** Decimal odds for the under, when the book prices both sides (main O/U lines). */
  underDecimalOdds: number | null;
  /** Set by the lines panel when a main O/U line is plotted on its stat's alternate curve. */
  isMainLine?: boolean;
  /** Set by the lines panel when overDecimalOdds has been replaced by the vig-removed price. */
  rawOverDecimalOdds?: number;
  lastUpdatedAt: Date;
};

/** One bookmaker's projection from its own lines; stats it can't project are missing. */
export type BookmakerStats = { bookmaker: string; stats: Partial<PlayerStats> };

export type PlayerLines = {
  commenceTime: Date | null;
  lines: PlayerLine[];
  /** The backend's projection (same as project-players; TDs calibrated); null if not sent. */
  stats: PlayerStats | null;
  /** Each bookmaker's projection; for each stat, `stats` is the average over the books with a value. */
  bookmakerStats: BookmakerStats[];
};


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Numeric columns may arrive as numbers or numeric strings; anything else is null. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseLine(value: unknown): PlayerLine | undefined {
  if (!isRecord(value)) return undefined;
  const { bookmaker, market, last_updated_at } = value;
  const lineValue = toNumber(value.line_value);
  const overDecimalOdds = toNumber(value.over_decimal_odds);
  const underDecimalOdds = toNumber(value.under_decimal_odds);
  const lastUpdatedAt = parseDate(last_updated_at);
  // Lines without an Over price contribute nothing to projections or charts.
  if (
    typeof bookmaker !== "string" ||
    typeof market !== "string" ||
    lineValue === null ||
    overDecimalOdds === null ||
    !(overDecimalOdds > 1) ||
    !lastUpdatedAt
  ) {
    return undefined;
  }
  return {
    bookmaker,
    market,
    lineValue,
    overDecimalOdds,
    underDecimalOdds: underDecimalOdds !== null && underDecimalOdds > 1 ? underDecimalOdds : null,
    lastUpdatedAt,
  };
}

function parseBookmakerStats(value: unknown): BookmakerStats | undefined {
  if (!isRecord(value) || typeof value.bookmaker !== "string" || !isRecord(value.stats)) return undefined;
  const stats: Partial<PlayerStats> = {};
  for (const [key, serverKey] of Object.entries(serverStatKeys) as [keyof PlayerStats, string][]) {
    const stat = toNumber(value.stats[serverKey]);
    if (stat !== null) stats[key] = stat;
  }
  return { bookmaker: value.bookmaker, stats };
}

export async function getPlayerLines(
  playerId: string,
  gameId: string,
  signal?: AbortSignal,
): Promise<PlayerLines> {
  const url = functionUrl("player-lines");
  url.searchParams.set("player_id", playerId);
  url.searchParams.set("game_id", gameId);

  const response = await fetchAsUser(url, signal);
  if (!response.ok) {
    throw new Error(`Could not load bookmaker lines (server returned ${response.status}).`);
  }

  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.lines)) {
    throw new Error("Could not load bookmaker lines: the server returned an invalid response.");
  }

  const lines: PlayerLine[] = [];
  let invalidCount = 0;
  for (const entry of data.lines) {
    const line = parseLine(entry);
    if (line) lines.push(line);
    else invalidCount += 1;
  }
  if (invalidCount > 0) {
    console.warn(`Skipped ${invalidCount} bookmaker line(s) with invalid data.`);
  }

  const commenceTime = isRecord(data.game) ? parseDate(data.game.commence_time) : null;
  const stats = parseStats(data.stats) ?? null;
  if (!stats) console.warn("player-lines returned no valid projection.");
  const bookmakerStats = (Array.isArray(data.bookmaker_stats) ? data.bookmaker_stats : [])
    .map(parseBookmakerStats)
    .filter((entry): entry is BookmakerStats => entry !== undefined);
  return { commenceTime, lines, stats, bookmakerStats };
}

// One cache for the page's lifetime, shared by the Rankings panel and the Lineup optimizer,
// so a player's lines are fetched once no matter where they're shown.
const linesRequests = new Map<string, Promise<PlayerLines>>();
const loadedLines = new Map<string, PlayerLines>();
const cacheKey = (playerId: string, gameId: string) => `${playerId}|${gameId}`;

/** Lines already loaded for this player and game, if any (for rendering without a flash). */
export function cachedPlayerLines(playerId: string, gameId: string): PlayerLines | undefined {
  return loadedLines.get(cacheKey(playerId, gameId));
}

/**
 * A player's lines for a game, fetched at most once. `fetch` lets callers wrap the request
 * (e.g. in a concurrency limiter). Failed requests are evicted so a retry refetches.
 */
export function loadPlayerLines(
  playerId: string,
  gameId: string,
  fetch: () => Promise<PlayerLines> = () => getPlayerLines(playerId, gameId),
): Promise<PlayerLines> {
  const key = cacheKey(playerId, gameId);
  let request = linesRequests.get(key);
  if (!request) {
    request = fetch().then(
      (result) => {
        loadedLines.set(key, result);
        return result;
      },
      (error: unknown) => {
        linesRequests.delete(key);
        throw error;
      },
    );
    linesRequests.set(key, request);
  }
  return request;
}

/** Forget all cached lines so the next load fetches the latest ones from the backend. */
export function clearPlayerLinesCache() {
  linesRequests.clear();
  loadedLines.clear();
}
