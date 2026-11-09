import { useCallback, useEffect, useMemo, useState } from "react";
import { getGames, opponentLabel, type Game } from "./api/games";
import { clearPlayerLinesCache, getPlayerLines, loadPlayerLines } from "./api/playerLines";
import type { PlayerStats } from "./api/rankings";
import { currentNflWeek } from "./nflWeek";
import { teamCode } from "./teams";

export type PlayerProjection =
  | { status: "loading" }
  | { status: "no-game" }
  | { status: "no-lines"; opponent: string; gameId: string }
  | { status: "error"; message: string }
  | {
      status: "ready";
      stats: PlayerStats;
      opponent: string;
      gameId: string;
      /** Newest last_updated_at across the player's lines: how fresh their odds are. */
      lastUpdatedAt: Date | null;
    };

// Games for the week, cached for the page's lifetime (lines are cached in api/playerLines).
let gamesRequest: Promise<Game[]> | null = null;

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
  return loadPlayerLines(playerId, gameId, () => limited(() => getPlayerLines(playerId, gameId)));
}

// Coming back to a tab whose lines are older than this refetches them automatically.
const autoRefreshAfterMs = 30 * 60 * 1000;

/**
 * Projected stats for each rostered player in this week's game (games), as player-lines
 * returns them alongside the player's lines (the backend's projection, TDs calibrated).
 */
export function useRosterProjections(roster: { id: string; team: string }[]) {
  const [games, setGames] = useState<Game[] | null>(null);
  const [gamesError, setGamesError] = useState<string | null>(null);
  const [results, setResults] = useState<Map<string, PlayerProjection>>(new Map());
  // Bumped by refresh() to refetch games and lines; loadedAt is when this page last fetched.
  const [refreshCount, setRefreshCount] = useState(0);
  const [loadedAt, setLoadedAt] = useState(() => new Date());

  /** Drop cached games and lines and fetch everything again (used when returning to a stale tab). */
  const refresh = useCallback(() => {
    gamesRequest = null;
    clearPlayerLinesCache();
    setGames(null);
    setGamesError(null);
    setResults(new Map());
    setLoadedAt(new Date());
    setRefreshCount((count) => count + 1);
  }, []);

  // Returning to a tab that's been open a while: refresh rather than show old lines.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.getTime() > autoRefreshAfterMs) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadedAt, refresh]);

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
  }, [refreshCount]);

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
        .then(({ lines, stats }) => {
          if (lines.length === 0) return update(id, { status: "no-lines", opponent, gameId: game.id });
          if (!stats) return update(id, { status: "error", message: "The server returned no projection for this player." });
          const lastUpdatedAt = new Date(Math.max(...lines.map((line) => line.lastUpdatedAt.getTime())));
          update(id, { status: "ready", stats, opponent, gameId: game.id, lastUpdatedAt });
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
    /** Increments on each refetch; use as a key to reload anything showing cached lines. */
    refreshCount,
    /** When this page last fetched games and lines. */
    loadedAt,
  };
}
