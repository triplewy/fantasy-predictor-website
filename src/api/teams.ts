import { fetchAsUser, functionUrl } from "../supabase";

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
  const touchdowns = parseNullableStat(value.stats.player_tds);
  const pointsAllowed = parseNullableStat(value.stats.points_allowed);
  const yardsAllowed = parseNullableStat(value.stats.yards_allowed);
  const interceptions = parseNullableStat(value.stats.interceptions);
  if (touchdowns === undefined || pointsAllowed === undefined) return undefined;
  const sacks = parseNullableStat(value.stats.sacks);
  if (yardsAllowed === undefined || interceptions === undefined || sacks === undefined) return undefined;
  const gameTotal = parseNullableStat(value.game_total ?? value.total ?? value.stats.game_total ?? value.stats.total);
  const spread = parseNullableStat(value.spread ?? value.stats.spread);
  if (gameTotal === undefined || spread === undefined) return undefined;
  return {
    team: value.team,
    matchup: value.matchup,
    opponent: parseOpponent(value.matchup, value.team),
    gameTotal,
    spread,
    stats: { touchdowns, pointsAllowed, yardsAllowed, interceptions, sacks },
  };
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
