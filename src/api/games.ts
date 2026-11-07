import { fetchAsUser, functionUrl } from "../supabase";

export type Game = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: Date | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Home/away from explicit fields, or from a "AWAY @ HOME" matchup string. */
function parseTeams(value: Record<string, unknown>): { homeTeam: string; awayTeam: string } | undefined {
  if (typeof value.home_team === "string" && typeof value.away_team === "string") {
    return { homeTeam: value.home_team.toUpperCase(), awayTeam: value.away_team.toUpperCase() };
  }
  if (typeof value.matchup !== "string") return undefined;
  const [away, home] = value.matchup.split("@").map((part) => part.trim().toUpperCase());
  return away && home ? { homeTeam: home, awayTeam: away } : undefined;
}

function parseGame(value: unknown): Game | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.game_id === "string" ? value.game_id : typeof value.id === "string" ? value.id : undefined;
  const teams = parseTeams(value);
  if (!id || !teams) return undefined;
  const commenceTime = typeof value.commence_time === "string" ? new Date(value.commence_time) : null;
  return {
    id,
    ...teams,
    commenceTime: commenceTime && !Number.isNaN(commenceTime.getTime()) ? commenceTime : null,
  };
}

/**
 * Games in the NFL week [from, to). Expects
 * `GET /games?from=<ISO>&to=<ISO>` → `{ games: [{ game_id, matchup: "AWAY @ HOME", commence_time }] }`
 * (or a bare array, or home_team/away_team instead of matchup).
 */
export async function getGames(week: { from: Date; to: Date }, signal?: AbortSignal): Promise<Game[]> {
  const url = functionUrl("games");
  url.searchParams.set("from", week.from.toISOString());
  url.searchParams.set("to", week.to.toISOString());
  const response = await fetchAsUser(url, signal);
  if (!response.ok) throw new Error(`Could not load this week's games (server returned ${response.status}).`);

  const data: unknown = await response.json();
  const entries = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.games) ? data.games : null;
  if (!entries) throw new Error("Could not load this week's games: the server returned an invalid response.");
  return entries.map(parseGame).filter((game): game is Game => game !== undefined);
}

/** "@ MIN" for the away team, "vs BUF" for the home team. */
export function opponentLabel(game: Game, team: string) {
  return team === game.awayTeam ? `@ ${game.homeTeam}` : `vs ${game.awayTeam}`;
}
