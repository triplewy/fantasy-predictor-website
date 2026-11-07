import { fetchAsUser, functionUrl } from "../supabase";
import type { Position } from "./rankings";
import { teamCode } from "../teams";

/** A player from the full /players list, used to build a team (no projections). */
export type ListedPlayer = {
  /** Sleeper player ID — the same ID project-players uses, so rosters join to projections. */
  id: string;
  name: string;
  position: Position;
  /** Canonical team code (e.g. "CIN"), or "FA" for free agents. */
  team: string;
};

// Fullbacks count as running backs; other positions (defense, IDP, etc.) aren't supported.
const positionMap: Record<string, Position> = { QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", K: "K" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}

/** Parse one player, accepting the field names the API is likely to use. */
function parseListedPlayer(value: unknown): ListedPlayer | undefined {
  if (!isRecord(value)) return undefined;
  const rawId = value.player_id ?? value.id;
  const id = typeof rawId === "number" ? String(rawId) : firstString(rawId);
  const combinedName = [value.first_name, value.last_name].filter((part) => typeof part === "string").join(" ");
  const name = firstString(value.player, value.name, value.full_name, combinedName);
  const position = typeof value.position === "string" ? positionMap[value.position.toUpperCase()] : undefined;
  if (!id || !name || !position) return undefined;
  // /players sends the team as team_id; accept team too. Normalized so it matches /games.
  const team = firstString(value.team_id, value.team);
  return { id, name, position, team: team ? teamCode(team) : "FA" };
}

/** Every supported fantasy player from /players, sorted by name. */
export async function getAllPlayers(signal?: AbortSignal): Promise<ListedPlayer[]> {
  const response = await fetchAsUser(functionUrl("players"), signal);
  if (!response.ok) {
    throw new Error(`Could not load the player list (server returned ${response.status}).`);
  }

  const data: unknown = await response.json();
  const entries = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.players) ? data.players : null;
  if (!entries) throw new Error("Could not load the player list: the server returned an invalid response.");

  const players = entries.map(parseListedPlayer).filter((player): player is ListedPlayer => player !== undefined);
  if (players.length === 0 && entries.length > 0) {
    throw new Error("Could not load the player list: no players had a recognizable id, name and position.");
  }
  return players.sort((a, b) => a.name.localeCompare(b.name));
}
