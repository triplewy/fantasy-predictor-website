import { useEffect, useMemo, useState } from "react";
import { getGames, opponentLabel, type Game } from "./api/games";
import { getPlayerLines, type PlayerLines } from "./api/playerLines";
import type { PlayerStats } from "./api/rankings";
import { projectStatsFromLines } from "./expectedStat";
import { currentNflWeek } from "./nflWeek";
import { teamCode } from "./teams";

export type PlayerProjection =
  | { status: "loading" }
  | { status: "no-game" }
  | { status: "no-lines"; opponent: string }
  | { status: "error"; message: string }
  | { status: "ready"; stats: PlayerStats; opponent: string; lastUpdatedAt: Date | null };

// Cached for the page's lifetime: games for the week, and each player's lines per game.
let gamesRequest: Promise<Game[]> | null = null;
const linesRequests = new Map<string, Promise<PlayerLines>>();

function loadGames() {
  gamesRequest ??= getGames(currentNflWeek()).catch((error: unknown) => {
    gamesRequest = null; // retry on the next attempt
    throw error;
  });
  return gamesRequest;
}

// At most a few player-lines requests in flight, so a full roster doesn't burst ~15 calls.
const maxConcurrentRequests = 4;
let activeRequests = 0;
const waiting: (() => void)[] = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (activeRequests >= maxConcurrentRequests) await new Promise<void>((resolve) => waiting.push(resolve));
  activeRequests += 1;
  try {
    return await task();
  } finally {
    activeRequests -= 1;
    waiting.shift()?.();
  }
}

function loadLines(playerId: string, gameId: string) {
  const key = `${playerId}|${gameId}`;
  let request = linesRequests.get(key);
  if (!request) {
    request = limited(() => getPlayerLines(playerId, gameId)).catch((error: unknown) => {
      linesRequests.delete(key);
      throw error;
    });
    linesRequests.set(key, request);
  }
  return request;
}

/**
 * Projected stats for each rostered player, computed in the browser from their raw
 * bookmaker lines (player-lines) for this week's game (games). Independent of the
 * project-players API.
 */
export function useRosterProjections(roster: { id: string; team: string }[]) {
  const [games, setGames] = useState<Game[] | null>(null);
  const [gamesError, setGamesError] = useState<string | null>(null);
  const [results, setResults] = useState<Map<string, PlayerProjection>>(new Map());

  useEffect(() => {
    let isCurrent = true;
    loadGames()
      .then((loaded) => isCurrent && setGames(loaded))
      .catch((error: unknown) => {
        if (isCurrent) setGamesError(error instanceof Error ? error.message : "Could not load this week's games.");
      });
    return () => {
      isCurrent = false;
    };
  }, []);

  const gameByTeam = useMemo(() => {
    const map = new Map<string, Game>();
    for (const game of games ?? []) {
      map.set(game.homeTeam, game);
      map.set(game.awayTeam, game);
    }
    return map;
  }, [games]);

  // Stable key so the effect only reruns when the set of (player, team) pairs changes.
  const rosterKey = roster.map((player) => `${player.id}:${player.team}`).sort().join(",");

  useEffect(() => {
    if (!games) return;
    let isCurrent = true;
    const update = (id: string, projection: PlayerProjection) => {
      if (isCurrent) setResults((current) => new Map(current).set(id, projection));
    };

    const unmatchedTeams = new Set<string>();
    for (const { id, team } of roster) {
      const game = gameByTeam.get(teamCode(team));
      if (!game) unmatchedTeams.add(team);
      if (!game) {
        update(id, { status: "no-game" });
        continue;
      }
      const opponent = opponentLabel(game, teamCode(team));
      loadLines(id, game.id)
        .then(({ lines }) => {
          if (lines.length === 0) return update(id, { status: "no-lines", opponent });
          const lastUpdatedAt = new Date(Math.max(...lines.map((line) => line.lastUpdatedAt.getTime())));
          update(id, { status: "ready", stats: projectStatsFromLines(lines), opponent, lastUpdatedAt });
        })
        .catch((error: unknown) =>
          update(id, { status: "error", message: error instanceof Error ? error.message : "Could not load lines." }),
        );
    }
    if (unmatchedTeams.size > 0) {
      console.info(
        `No game this week for team(s) ${[...unmatchedTeams].join(", ")}. Teams with games:`,
        [...gameByTeam.keys()].sort().join(", ") || "(none)",
      );
    }
    return () => {
      isCurrent = false;
    };
    // rosterKey captures the roster's relevant contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, gameByTeam, rosterKey]);

  const projections = new Map<string, PlayerProjection>(
    roster.map(({ id }) => [id, gamesError ? { status: "error", message: gamesError } : (results.get(id) ?? { status: "loading" })]),
  );
  return {
    projections,
    gamesError,
    isLoadingGames: games === null && gamesError === null,
    /** Games loaded, but none were returned or recognized for this week. */
    hasNoGames: games !== null && games.length === 0,
  };
}
