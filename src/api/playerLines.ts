export type PlayerLine = {
  bookmaker: string;
  /** e.g. "player_rush_yds_alternate" or "player_anytime_td". */
  market: string;
  lineValue: number;
  /** Decimal odds for the over at this line. */
  overDecimalOdds: number;
  lastUpdatedAt: Date;
};

export type PlayerLines = {
  commenceTime: Date | null;
  lines: PlayerLine[];
};

const playerLinesUrl = "https://fkhwdotwrfedwaddaalv.supabase.co/functions/v1/player-lines";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLine(value: unknown): PlayerLine | undefined {
  if (!isRecord(value)) return undefined;
  const { bookmaker, market, line_value, over_decimal_odds, last_updated_at } = value;
  const lastUpdatedAt = parseDate(last_updated_at);
  if (
    typeof bookmaker !== "string" ||
    typeof market !== "string" ||
    typeof line_value !== "number" ||
    !Number.isFinite(line_value) ||
    typeof over_decimal_odds !== "number" ||
    !(over_decimal_odds > 1) ||
    !lastUpdatedAt
  ) {
    return undefined;
  }
  return {
    bookmaker,
    market,
    lineValue: line_value,
    overDecimalOdds: over_decimal_odds,
    lastUpdatedAt,
  };
}

export async function getPlayerLines(
  playerId: string,
  gameId: string,
  signal?: AbortSignal,
): Promise<PlayerLines> {
  const url = new URL(playerLinesUrl);
  url.searchParams.set("player_id", playerId);
  url.searchParams.set("game_id", gameId);

  const response = await fetch(url, { signal });
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
  return { commenceTime, lines };
}
