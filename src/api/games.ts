import { fetchAsUser, functionUrl } from "../supabase";
import { teamCode } from "../teams";

export type Game = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: Date | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Home/away teams (as canonical codes) from explicit fields, or from a matchup string like
 * "BUF @ MIN" / "Buffalo Bills at Minnesota Vikings" / "MIN vs BUF".
 */
function parseTeams(value: Record<string, unknown>): { homeTeam: string; awayTeam: string } | undefined {
  const home = value.home_team ?? value.home;
  const away = value.away_team ?? value.away;
  if (typeof home === "string" && typeof away === "string") {
    return { homeTeam: teamCode(home), awayTeam: teamCode(away) };
  }
  if (typeof value.matchup !== "string") return undefined;
  const atMatch = value.matchup.split(/\s+@\s+|\s+at\s+/i);
  if (atMatch.length === 2) return { awayTeam: teamCode(atMatch[0]), homeTeam: teamCode(atMatch[1]) };
  const vsMatch = value.matchup.split(/\s+vs\.?\s+/i);
  if (vsMatch.length === 2) return { homeTeam: teamCode(vsMatch[0]), awayTeam: teamCode(vsMatch[1]) };
  return undefined;
}

function parseGame(value: unknown): Game | undefined {
  if (!isRecord(value)) return undefined;
  const rawId = value.game_id ?? value.id;
  const id = typeof rawId === "number" ? String(rawId) : typeof rawId === "string" && rawId ? rawId : undefined;
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
  const games = entries.map(parseGame).filter((game): game is Game => game !== undefined);
  if (games.length < entries.length) {
    console.warn(
      `Skipped ${entries.length - games.length} of ${entries.length} games with an unrecognized shape. Sample:`,
      entries.find((entry) => parseGame(entry) === undefined),
    );
  }
  return games;
}

/** "@ MIN" for the away team, "vs BUF" for the home team. */
export function opponentLabel(game: Game, team: string) {
  return team === game.awayTeam ? `@ ${game.homeTeam}` : `vs ${game.awayTeam}`;
}
