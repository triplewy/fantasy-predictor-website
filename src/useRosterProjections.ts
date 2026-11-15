import { useCallback, useEffect, useMemo, useState } from "react";
import { getGames, opponentLabel, type Game } from "./api/games";
import { getPlayerProjections, type Player, type PlayerMarket } from "./api/rankings";
import { currentNflWeek } from "./nflWeek";
import { teamCode } from "./teams";

export type PlayerProjection =
  | { status: "loading" }
  | { status: "no-game" }
  | { status: "no-lines"; opponent: string; gameId: string }
  | { status: "error"; message: string }
  | {
      status: "ready";
      stats: Player["stats"];
      markets: PlayerMarket[];
      opponent: string;
      gameId: string;
      /** When the player's markets were last updated. */
      lastUpdatedAt: Date | null;
    };

// Games for the week, cached for the page's lifetime.
let gamesRequest: Promise<Game[]> | null = null;

function loadGames() {
  gamesRequest ??= getGames(currentNflWeek()).catch((error: unknown) => {
    gamesRequest = null; // retry on the next attempt
    throw error;
  });
  return gamesRequest;
}

// Coming back to a tab whose projections are older than this refetches them automatically.
const autoRefreshAfterMs = 30 * 60 * 1000;

/**
 * Projected stats for each rostered player in this week's game, from the same project-players
 * call the Rankings page uses. Players missing from the response have no lines yet; players
 * whose team has no game this week are on a bye.
 */
export function useRosterProjections(roster: { id: string; team: string }[]) {
  const [games, setGames] = useState<Game[] | null>(null);
  const [gamesError, setGamesError] = useState<string | null>(null);
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [projectionsError, setProjectionsError] = useState<string | null>(null);
  // Bumped by refresh() to refetch games and projections; loadedAt is when this page last fetched.
  const [refreshCount, setRefreshCount] = useState(0);
  const [loadedAt, setLoadedAt] = useState(() => new Date());

  /** Drop cached games and projections and fetch everything again (used when returning to a stale tab). */
  const refresh = useCallback(() => {
    gamesRequest = null;
    setGames(null);
    setGamesError(null);
    setPlayers(null);
    setProjectionsError(null);
    setLoadedAt(new Date());
    setRefreshCount((count) => count + 1);
  }, []);

  // Returning to a tab that's been open a while: refresh rather than show old projections.
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
    getPlayerProjections(currentNflWeek())
      .then(({ players: loadedPlayers }) => isCurrent && setPlayers(loadedPlayers))
      .catch((error: unknown) => {
        if (isCurrent) setProjectionsError(error instanceof Error ? error.message : "Could not load player projections.");
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

  const playerById = useMemo(() => new Map((players ?? []).map((player) => [player.id, player])), [players]);

  const projections = useMemo(() => {
    const map = new Map<string, PlayerProjection>();
    if (gamesError || projectionsError) {
      const message = gamesError ?? projectionsError!;
      for (const { id } of roster) map.set(id, { status: "error", message });
      return map;
    }
    if (!games || !players) {
      for (const { id } of roster) map.set(id, { status: "loading" });
      return map;
    }
    for (const { id, team } of roster) {
      const game = gameByTeam.get(teamCode(team));
      if (!game) {
        map.set(id, { status: "no-game" });
        continue;
      }
      const player = playerById.get(id);
      if (!player || player.gameId !== game.id) {
        map.set(id, { status: "no-lines", opponent: opponentLabel(game, teamCode(team)), gameId: game.id });
        continue;
      }
      map.set(id, {
        status: "ready",
        stats: player.stats,
        markets: player.markets,
        opponent: opponentLabel(game, teamCode(team)),
        gameId: game.id,
        lastUpdatedAt: player.lastUpdatedAt,
      });
    }
    return map;
  }, [roster, games, players, gameByTeam, playerById, gamesError, projectionsError]);

  return {
    projections,
    gamesError,
    isLoadingGames: games === null && gamesError === null,
    /** Games loaded, but none were returned or recognized for this week. */
    hasNoGames: games !== null && games.length === 0,
    /** Increments on each refetch; use as a key to reload anything showing cached lines. */
    refreshCount,
    /** When this page last fetched games and projections. */
    loadedAt,
  };
}
