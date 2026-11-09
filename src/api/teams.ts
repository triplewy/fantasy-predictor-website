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

/**
 * The team's TD scale, the same one project-players applies to its players: anytime-TD
 * prices carry margin, so a team's players' TDs are scaled to what its game lines imply.
 */
export type TdCalibration = {
  /** The team's implied score from spreads and totals; null without game lines. */
  impliedPoints: number | null;
  /** Its kicker's projected points; null without one. */
  kickingPoints: number | null;
  /** (impliedPoints − kickingPoints) / 6; null without both. */
  impliedTds: number | null;
  /** Its players' and D/ST's anytime TDs before scaling. */
  projectedTds: number;
  /** impliedTds / projectedTds, or the backend's fallback; multiply player TDs by it. */
  factor: number;
};

export type TeamProjection = {
  /** Team ID (abbreviation), e.g. "KC". */
  team: string;
  matchup: string;
  opponent: string;
  stats: TeamStats;
  /** Null when the API doesn't send it. */
  tdCalibration: TdCalibration | null;
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

function parseTdCalibration(value: unknown): TdCalibration | null {
  if (!isRecord(value)) return null;
  const impliedPoints = parseNullableStat(value.implied_points);
  const kickingPoints = parseNullableStat(value.kicking_points);
  const impliedTds = parseNullableStat(value.implied_tds);
  const projectedTds = parseNullableStat(value.projected_tds);
  const factor = parseNullableStat(value.factor);
  if (impliedPoints === undefined || kickingPoints === undefined || impliedTds === undefined) return null;
  if (projectedTds == null || factor == null || factor <= 0) return null;
  return { impliedPoints, kickingPoints, impliedTds, projectedTds, factor };
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
  return {
    team: value.team,
    matchup: value.matchup,
    opponent: parseOpponent(value.matchup, value.team),
    stats: { touchdowns, pointsAllowed, yardsAllowed, interceptions, sacks },
    tdCalibration: parseTdCalibration(value.td_calibration),
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
