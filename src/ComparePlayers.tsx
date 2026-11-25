import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { getAllPlayers, type ListedPlayer } from "./api/players";
import type { Player, PlayerMarket, PlayerStats, Position } from "./api/rankings";
import type { TeamProjection } from "./api/teams";
import { teamCode } from "./teams";
import { formatStat, getPointsBreakdown, type ScoringSettings } from "./scoring";
import { marketInfo } from "./markets";
import { comparePlayerParam } from "./routes";
import { readStorageJson, writeStorageJson } from "./storage";
import { MarketOverlayChart, type OverlaySeries } from "./MarketOverlayChart";

const maxPlayers = 5;
const storageKey = "fantasy-compare-players";

type SavedPlayer = Pick<Player, "id" | "name" | "position" | "team" | "opponent">;

export type ComparedPlayer = {
  id: string;
  name: string;
  position: Position;
  team: string;
  opponent: string;
  stats?: PlayerStats;
  markets?: PlayerMarket[];
  hasProjection: boolean;
};

function isSavedPlayer(value: unknown): value is SavedPlayer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.position === "string" &&
    typeof candidate.team === "string" &&
    (candidate.opponent === undefined || typeof candidate.opponent === "string")
  );
}

function readSavedPlayers(): SavedPlayer[] {
  const stored = readStorageJson(storageKey);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(isSavedPlayer)
    .slice(0, maxPlayers)
    .map(({ id, name, position, team, opponent }) => ({
      id,
      name,
      position,
      team,
      opponent: opponent ?? "",
    }));
}

function writeSavedPlayers(players: SavedPlayer[]) {
  writeStorageJson(storageKey, players);
}

// The full player list is large and rarely changes, so it's fetched once per page load and
// shared across visits to this tab.
let playerListRequest: Promise<ListedPlayer[]> | null = null;
function loadPlayerList() {
  playerListRequest ??= getAllPlayers().catch((error: unknown) => {
    playerListRequest = null; // allow a retry on the next visit
    throw error;
  });
  return playerListRequest;
}

/** Row labels for each breakdown key, in display order. */
const breakdownRows: { key: keyof PlayerStats; label: string }[] = [
  { key: "passingYards", label: "Pass yds" },
  { key: "passingTouchdowns", label: "Pass TD" },
  { key: "interceptions", label: "INT" },
  { key: "rushingYards", label: "Rush yds" },
  { key: "receptions", label: "Rec" },
  { key: "receivingYards", label: "Rec yds" },
  { key: "touchdowns", label: "TD" },
  { key: "kickingPoints", label: "Kicking" },
];

/** One color per compared slot, used for the overlay curves and the legend. */
const seriesColors = ["#2f6f4f", "#b3541e", "#3b5bdb", "#8a4baf", "#0f8b8d"];

/** Rows where the lowest value wins; everything else (including points) is higher-is-better. */
const lowerIsBetterRows = new Set(["interceptions", "spread"]);

/** Bold the winning value in a row; ties all win; rows with no numeric values are skipped. */
function winningIndexes(values: (number | undefined)[], lowerIsBetter: boolean): Set<number> {
  const numeric = values
    .map((value, index) => ({ value, index }))
    .filter((entry): entry is { value: number; index: number } => entry.value !== undefined);
  if (numeric.length === 0) return new Set();
  const best = Math.min(...numeric.map((entry) => entry.value));
  const worst = Math.max(...numeric.map((entry) => entry.value));
  const target = lowerIsBetter ? best : worst;
  return new Set(numeric.filter((entry) => entry.value === target).map((entry) => entry.index));
}

type Props = {
  players: Player[];
  teams: TeamProjection[];
  settings: ScoringSettings;
  scoringControl: ReactNode;
  isLoading: boolean;
  error: string | null;
  teamsLoading?: boolean;
  teamsError?: string | null;
};

export function ComparePlayers({
  players,
  teams,
  settings,
  scoringControl,
  isLoading,
  error,
  teamsLoading = false,
  teamsError = null,
}: Props) {
  const [playerList, setPlayerList] = useState<ListedPlayer[] | null>(null);
  const [playerListError, setPlayerListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  // Saved picks persist across visits; stats and markets always come from live projections.
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayer[]>(readSavedPlayers);
  const [teamDetailsExpanded, setTeamDetailsExpanded] = useState(false);
  // Legend interactions: ⌘/Ctrl-click toggles a player dulled (multi-select); plain click shows only that player (click again to show all).
  const [dulledPlayerIds, setDulledPlayerIds] = useState<ReadonlySet<string>>(new Set());

  function handleLegendClick(playerId: string, event: ReactMouseEvent) {
    if (event.metaKey || event.ctrlKey) {
      setDulledPlayerIds((current) => {
        const next = new Set(current);
        if (next.has(playerId)) next.delete(playerId);
        else next.add(playerId);
        return next;
      });
      return;
    }
    setDulledPlayerIds((current) => {
      const others = comparedIdList.filter((id) => id !== playerId);
      const onlyThisShown = others.length > 0 && others.every((id) => current.has(id)) && !current.has(playerId);
      return onlyThisShown ? new Set() : new Set(others);
    });
  }

  useEffect(() => {
    let cancelled = false;
    loadPlayerList()
      .then((list) => {
        if (!cancelled) setPlayerList(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPlayerListError(
            error instanceof Error ? error.message : "Could not load the player list.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projectionsById = useMemo(
    () => new Map(players.map((player) => [player.id, player])),
    [players],
  );

  // A "Compare" button from another page can land here with `?player=<id>` in the hash.
  // Add that player on arrival, then drop the query so the URL reads `#/compare`.
  // The query is only stripped once the player is found, or once both data sources have
  // finished loading and the player genuinely doesn't exist.
  useEffect(() => {
    const param = comparePlayerParam();
    if (!param) return;
    const target = projectionsById.get(param) ?? playerList?.find((p) => p.id === param);
    if (!target) {
      if (isLoading || playerList === null) return;
      history.replaceState(null, "", "#/compare");
      return;
    }
    setSavedPlayers((current) => {
      if (current.length >= maxPlayers || current.some((saved) => saved.id === target.id)) {
        return current;
      }
      return [
        ...current,
        {
          id: target.id,
          name: target.name,
          position: target.position,
          team: target.team,
          opponent: "opponent" in target ? (target.opponent as string) ?? "" : "",
        },
      ];
    });
    try {
      history.replaceState(null, "", "#/compare");
    } catch {
      // Ignore: the URL is cosmetic here.
    }
  }, [isLoading, playerList, projectionsById]);

  // project-teams returns raw team codes; normalize both sides to match /players.
  const teamsByTeam = useMemo(
    () => new Map(teams.map((team) => [teamCode(team.team), team])),
    [teams],
  );

  // Saved picks are retained even if they don't have a projection this week,
  // allowing users to view them and remove them from comparison.
  const compared = useMemo<ComparedPlayer[]>(
    () =>
      savedPlayers.map((saved) => {
        const projection = projectionsById.get(saved.id);
        if (projection) {
          return {
            id: projection.id,
            name: projection.name,
            position: projection.position,
            team: projection.team,
            opponent: projection.opponent,
            stats: projection.stats,
            markets: projection.markets,
            hasProjection: true,
          };
        }
        return {
          id: saved.id,
          name: saved.name,
          position: saved.position as Position,
          team: saved.team,
          opponent: saved.opponent,
          hasProjection: false,
        };
      }),
    [savedPlayers, projectionsById],
  );
  const comparedIdList = useMemo(() => compared.map((player) => player.id), [compared]);

  useEffect(() => {
    writeSavedPlayers(savedPlayers);
  }, [savedPlayers]);

  const comparedIds = useMemo(() => new Set(savedPlayers.map((player) => player.id)), [savedPlayers]);

  // Search the full player list; names starting with the query come first.
  const suggestions = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text || !playerList) return [];
    const startsWith = (player: ListedPlayer) => player.name.toLowerCase().startsWith(text);
    return playerList
      .filter((player) => !comparedIds.has(player.id))
      .filter((player) => `${player.name} ${player.team}`.toLowerCase().includes(text))
      .sort((a, b) => Number(startsWith(b)) - Number(startsWith(a)) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [playerList, query, comparedIds]);

  // Keep the highlight in range as the suggestion list changes.
  useEffect(() => {
    setHighlightedIndex((current) => (current >= suggestions.length ? suggestions.length - 1 : current));
  }, [suggestions.length]);

  function addPlayer(player: ListedPlayer) {
    const projection = projectionsById.get(player.id);
    setSavedPlayers((current) => {
      if (current.length >= maxPlayers || current.some((saved) => saved.id === player.id)) return current;
      return [
        ...current,
        {
          id: player.id,
          name: player.name,
          position: player.position,
          team: player.team,
          opponent: projection?.opponent ?? "",
        },
      ];
    });
    setQuery("");
    setHighlightedIndex(0);
  }

  function removePlayer(id: string) {
    setSavedPlayers((current) => current.filter((player) => player.id !== id));
  }

  // Points breakdown per compared player, keyed by stat for row alignment; each item also
  // carries the raw projected stat value it was computed from.
  const breakdowns = useMemo(
    () =>
      compared.map((player) => {
        if (!player.stats) return new Map<keyof PlayerStats, { key: keyof PlayerStats; label: string; points: number; value: number }>();
        const items = getPointsBreakdown(player.stats, player.position, settings);
        return new Map(items.map((item) => [item.key, item]));
      }),
    [compared, settings],
  );

  const totals = useMemo(
    () =>
      compared.map((player, index) => {
        if (!player.hasProjection || !player.stats) return undefined;
        return [...breakdowns[index].values()].reduce((sum, item) => sum + item.points, 0);
      }),
    [compared, breakdowns],
  );

  // Only show rows where at least one compared player has a non-zero contribution.
  const visibleRows = useMemo(
    () =>
      breakdownRows.filter(({ key }) =>
        breakdowns.some((breakdown) => breakdown.has(key)),
      ),
    [breakdowns],
  );

  const winners = useMemo(() => winningIndexes(totals, false), [totals]);
  const teamTotals = useMemo(
    () =>
      compared.map((player) => {
        const team = teamsByTeam.get(teamCode(player.team));
        return team && team.gameTotal !== null && team.spread !== null
          ? (team.gameTotal - team.spread) / 2
          : undefined;
      }),
    [compared, teamsByTeam],
  );
  const teamTotalWinners = useMemo(() => winningIndexes(teamTotals, false), [teamTotals]);
  const teamWinners = useMemo(
    () =>
      winningIndexes(
        compared.map((player) => teamsByTeam.get(teamCode(player.team))?.gameTotal ?? undefined),
        false,
      ),
    [compared, teamsByTeam],
  );
  const spreadWinners = useMemo(
    () =>
      winningIndexes(
        compared.map((player) => teamsByTeam.get(teamCode(player.team))?.spread ?? undefined),
        true,
      ),
    [compared, teamsByTeam],
  );

  // Per-market overlays: one chart per market that at least one compared player has.
  const marketOverlays = useMemo(() => {
    const byMarket = new Map<
      string,
      { label: string; stat: keyof PlayerStats; entries: { player: ComparedPlayer; market: PlayerMarket }[] }
    >();
    compared.forEach((player) => {
      for (const market of player.markets ?? []) {
        const info = marketInfo[market.market];
        if (!info) continue;
        const entry = byMarket.get(market.market) ?? { label: info.label, stat: info.stat, entries: [] };
        entry.entries.push({ player, market });
        byMarket.set(market.market, entry);
      }
    });
    return [...byMarket.entries()]
      .map(([market, { label, stat, entries }]) => ({
        market,
        label,
        stat,
        series: entries.map(({ player, market: playerMarket }): OverlaySeries => ({
          id: player.id,
          name: player.name,
          color: seriesColors[compared.findIndex((comparedPlayer) => comparedPlayer.id === player.id) % seriesColors.length],
          lineValues: playerMarket.line_values,
          probabilities: playerMarket.fair_over_probabilities,
          projection: player.stats?.[stat] ?? 0,
        })),
      }))
      .sort((a, b) => {
        const order = breakdownRows.map((row) => row.key);
        return order.indexOf(a.stat) - order.indexOf(b.stat) || a.label.localeCompare(b.label);
      });
  }, [compared]);

  // Team-market overlays: one chart each for the game total and the team's spread,
  // using the fitted curves from /project-teams (spread curve is team-perspective).
  const teamMarketOverlays = useMemo(() => {
    const groups: { market: string; label: string; series: OverlaySeries[] }[] = [];
    const definitions = [
      { market: "totals", label: "Game total", projection: (team: TeamProjection) => team.gameTotal },
      { market: "spreads", label: "Team spread", projection: (team: TeamProjection) => team.spread },
    ];
    for (const { market, label, projection } of definitions) {
      const series: OverlaySeries[] = [];
      compared.forEach((player, index) => {
        const team = teamsByTeam.get(teamCode(player.team));
        const curve = team?.markets.find((entry) => entry.market === market);
        if (!team || !curve) return;
        series.push({
          id: player.id,
          name: player.name,
          color: seriesColors[index % seriesColors.length],
          lineValues: curve.line_values,
          probabilities: curve.fair_over_probabilities,
          projection: projection(team) ?? undefined,
        });
      });
      if (series.length > 0) groups.push({ market, label, series });
    }
    return groups;
  }, [compared, teamsByTeam]);

  const hasLiveMarkets = marketOverlays.length > 0;

  function renderLegend(series: OverlaySeries[]) {
    return (
      <ul className="compare-legend">
        {series.map((entry) => {
          const dulled = dulledPlayerIds.has(entry.id);
          return (
            <li key={entry.id}>
              <button
                type="button"
                className={`compare-legend-item${dulled ? " dulled" : ""}`}
                aria-pressed={dulled}
                title="Click: show only this player (again to show all). ⌘/Ctrl-click: toggle dull"
                onClick={(event) => handleLegendClick(entry.id, event)}
              >
                <span
                  className="compare-series-dot"
                  style={{ background: entry.color }}
                  aria-hidden="true"
                />
                {entry.name}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="player-list" aria-label="Compare players">
      <div className="list-heading">
        <div>
          <h2>Compare players</h2>
          <p>Pick up to {maxPlayers} players to line up their projected points side by side.</p>
        </div>
      </div>

      {scoringControl}

      {isLoading && <p className="lineup-note" role="status">Loading player projections…</p>}
      {error && <p className="lineup-note error-state" role="alert">{error}</p>}
      {teamsLoading && <p className="lineup-note" role="status">Loading team projections…</p>}
      {teamsError && <p className="lineup-note error-state" role="alert">{teamsError}</p>}

      <div className="roster-search compare-search">
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setHighlightedIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && suggestions.length > 0) {
              addPlayer(suggestions[highlightedIndex] ?? suggestions[0]);
            } else if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((current) => (current + 1) % suggestions.length);
            } else if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((current) =>
                current <= 0 ? suggestions.length - 1 : current - 1,
              );
            } else if (event.key === "Escape") {
              setQuery("");
            }
          }}
          placeholder={playerList === null ? "Loading players..." : "Add a player by name or team"}
          aria-label="Search players to compare"
          disabled={playerList === null}
        />
        {suggestions.length > 0 && (
          <ul className="roster-suggestions" role="listbox" aria-label="Matching players">
            {suggestions.map((player, index) => (
              <li key={player.id} role="option" aria-selected={index === highlightedIndex}>
                <button
                  type="button"
                  className={index === highlightedIndex ? "highlighted" : undefined}
                  onClick={() => addPlayer(player)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className="lineup-name">{player.name}</span>
                  <span className="lineup-meta">
                    {player.position} · {player.team}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {playerListError && <p className="lineup-note error-state" role="alert">{playerListError}</p>}
        {query.trim() && suggestions.length === 0 && playerList !== null && (
          <p className="lineup-note">No players match "{query.trim()}".</p>
        )}
      </div>

      {compared.length === 0 ? (
        <p className="empty-state">
          {isLoading
            ? "Loading player projections…"
            : "Search above to add players to compare."}
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="compare-table">
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  {compared.map((player, index) => (
                    <th scope="col" key={player.id} className="compare-player-heading">
                      <div className="compare-player-name">
                        <span
                          className="compare-series-dot"
                          style={{ background: seriesColors[index % seriesColors.length] }}
                          aria-hidden="true"
                        />
                        {player.name}
                      </div>
                      <div className="compare-player-meta">
                        {player.position} · {player.team}
                        {player.opponent ? ` ${player.opponent}` : ""}
                        {!player.hasProjection && !isLoading && (
                          <span className="compare-no-projection"> (No projection)</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="row-action"
                        onClick={() => removePlayer(player.id)}
                        aria-label={`Remove ${player.name} from comparison`}
                      >
                        Remove
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Proj. points</th>
                  {compared.map((player, index) => {
                    const total = totals[index];
                    return (
                      <td
                        key={player.id}
                        className={`points compare-points${winners.has(index) ? " winner" : ""}`}
                      >
                        {total === undefined ? "—" : total.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <th scope="row">
                    <button
                      type="button"
                      className="compare-toggle"
                      aria-expanded={teamDetailsExpanded}
                      onClick={() => setTeamDetailsExpanded((current) => !current)}
                    >
                      Team total
                      <span className="compare-toggle-chevron" aria-hidden="true">
                        {teamDetailsExpanded ? "▾" : "▸"}
                      </span>
                    </button>
                  </th>
                  {compared.map((player, index) => (
                    <td
                      key={player.id}
                      className={`compare-stat${teamTotalWinners.has(index) ? " winner" : ""}`}
                    >
                      {teamTotals[index] === undefined ? "—" : teamTotals[index].toFixed(2)}
                    </td>
                  ))}
                </tr>
                {teamDetailsExpanded && (
                <>
                <tr className="compare-subordinate">
                  <th scope="row">Game total</th>
                  {compared.map((player, index) => {
                    const team = teamsByTeam.get(teamCode(player.team));
                    return (
                      <td
                        key={player.id}
                        className={`compare-stat${teamWinners.has(index) ? " winner" : ""}`}
                      >
                        {team?.gameTotal === null || team?.gameTotal === undefined
                          ? "—"
                          : team.gameTotal.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
                <tr className="compare-subordinate">
                  <th scope="row">Team spread</th>
                  {compared.map((player, index) => {
                    const team = teamsByTeam.get(teamCode(player.team));
                    return (
                      <td
                        key={player.id}
                        className={`compare-stat${spreadWinners.has(index) ? " winner" : ""}`}
                      >
                        {team?.spread === null || team?.spread === undefined
                          ? "—"
                          : `${team.spread > 0 ? "+" : ""}${team.spread.toFixed(2)}`}
                      </td>
                    );
                  })}
                </tr>
                </>
                )}
                {visibleRows.map(({ key, label }) => {
                  const rowWinners = winningIndexes(
                    compared.map((_, index) => breakdowns[index].get(key)?.value),
                    lowerIsBetterRows.has(key),
                  );
                  return (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      {compared.map((player, index) => {
                        const item = breakdowns[index].get(key);
                        return (
                          <td
                            key={player.id}
                            className={`compare-stat${rowWinners.has(index) ? " winner" : ""}`}
                          >
                            {item === undefined ? (
                              "—"
                            ) : (
                              <span className="compare-raw-stat">{formatStat(item.value)}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="compare-markets">
            <div className="compare-markets-header">
              <h3>Market overlays</h3>
              <p>Fair (vig-removed) probability of the over at each line, one curve per player.</p>
            </div>
            {hasLiveMarkets || teamMarketOverlays.length > 0 ? (
              <div className="compare-market-grid">
                {marketOverlays.map(({ market, label, series }) => (
                  <section key={market} className="compare-market-card">
                    <h4>{label}</h4>
                    <MarketOverlayChart
                      label={label}
                      series={series}
                      dulledIds={dulledPlayerIds}
                    />
                    {renderLegend(series)}
                  </section>
                ))}
                {teamMarketOverlays.map(({ market, label, series }) => (
                  <section key={market} className="compare-market-card">
                    <h4>{label}</h4>
                    <MarketOverlayChart
                      label={label}
                      series={series}
                      dulledIds={dulledPlayerIds}
                    />
                    {renderLegend(series)}
                  </section>
                ))}
              </div>
            ) : (
              <p className="lines-status">
                {isLoading
                  ? "Loading market projections…"
                  : "No market projections are available for the selected players this week."}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
