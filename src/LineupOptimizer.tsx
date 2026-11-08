import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { getAllPlayers, type ListedPlayer } from "./api/players";
import type { Player, PlayerStats, Position } from "./api/rankings";
import { currentNflWeek } from "./nflWeek";
import { PlayerLinesPanel } from "./PlayerLinesPanel";
import { getPointsBreakdown, type ScoringSettings } from "./scoring";
import { useRosterProjections, type PlayerProjection } from "./useRosterProjections";
import {
  isSavedLineup,
  lineupFromOptimal,
  lineupPresets,
  optimizeLineup,
  placeNewPlayer,
  reconcileLineup,
  sitPlayer,
  slotEligibility,
  slotLabels,
  slotTypes,
  startPlayer,
  type LineupFormat,
  type RosterPlayer,
  type SavedLineup,
  type SlotType,
} from "./lineup";
import { readStorageJson, writeStorageJson } from "./storage";

type SavedRosterPlayer = Pick<Player, "id" | "name" | "position" | "team">;

const rosterStorageKey = "fantasy-my-team";
const formatStorageKey = "fantasy-lineup-format";
/** The user's own starters and bench (start/sit choices), separate from the team list. */
const lineupStorageKey = "fantasy-my-lineup";

function readLineup(): SavedLineup | null {
  const stored = readStorageJson(lineupStorageKey);
  return isSavedLineup(stored) ? stored : null;
}

const shortSlotLabel = (slot: SlotType) => (slot === "SUPERFLEX" ? "SFLEX" : slot);
const positions: Position[] = ["QB", "RB", "WR", "TE", "K"];

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
const maxSlotsPerType = 4;

// Placeholder stats for the lines panel when a player has a game but no lines yet.
const emptyStats: PlayerStats = {
  passingYards: 0,
  passingTouchdowns: 0,
  interceptions: 0,
  rushingYards: 0,
  receptions: 0,
  receivingYards: 0,
  touchdowns: 0,
  kickingPoints: 0,
};

function isSavedRosterPlayer(value: unknown): value is SavedRosterPlayer {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.team === "string" &&
    positions.some((position) => position === entry.position)
  );
}

function readRoster(): SavedRosterPlayer[] {
  const stored = readStorageJson(rosterStorageKey);
  return Array.isArray(stored) ? stored.filter(isSavedRosterPlayer) : [];
}

function readFormat(): LineupFormat {
  const stored = readStorageJson(formatStorageKey);
  const fallback = lineupPresets[0].format;
  if (typeof stored !== "object" || stored === null) return { ...fallback };
  const entry = stored as Record<string, unknown>;
  return Object.fromEntries(
    slotTypes.map((slot) => {
      const count = entry[slot];
      return [
        slot,
        typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= maxSlotsPerType
          ? count
          : fallback[slot],
      ];
    }),
  ) as LineupFormat;
}

/** Short label for a player who has no projection (yet). */
function projectionNote(projection: PlayerProjection): string | null {
  switch (projection.status) {
    case "loading":
      return "Loading lines…";
    case "no-game":
      return "No game this week";
    case "no-lines":
      return "No lines yet";
    case "error":
      return "Lines unavailable";
    case "ready":
      return null;
  }
}

/** The current time, re-rendering every minute so relative times stay current. */
function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** "just now", "12m ago", "3h ago", "45h ago" (hours are the largest unit). */
function timeAgo(date: Date, now: number) {
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function formatTimestamp(date: Date) {
  return date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function weekRangeLabel() {
  const { from, to } = currentNflWeek();
  const format = (date: Date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Week of ${format(from)} – ${format(to)}`;
}

function formatPoints(points: number) {
  return `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(1)}`;
}

function presetName(format: LineupFormat) {
  return (
    lineupPresets.find((preset) => slotTypes.every((slot) => preset.format[slot] === format[slot]))?.name ??
    "Custom"
  );
}

export function LineupOptimizer({
  settings,
  scoringControl,
}: {
  /** Scoring settings used to turn each player's projected stats into points. */
  settings: ScoringSettings;
  scoringControl: ReactNode;
}) {
  const [roster, setRoster] = useState<SavedRosterPlayer[]>(readRoster);
  const [format, setFormat] = useState<LineupFormat>(readFormat);
  const [query, setQuery] = useState("");
  const [isFormatMenuOpen, setIsFormatMenuOpen] = useState(false);
  // null until the user (or the first optimal fill) sets a lineup.
  const [savedLineup, setSavedLineup] = useState<SavedLineup | null>(readLineup);
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null);
  const [playerList, setPlayerList] = useState<ListedPlayer[] | null>(null);
  const [playerListError, setPlayerListError] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    loadPlayerList()
      .then((list) => isCurrent && setPlayerList(list))
      .catch((caught: unknown) => {
        if (isCurrent) setPlayerListError(caught instanceof Error ? caught.message : "Could not load the player list.");
      });
    return () => {
      isCurrent = false;
    };
  }, []);
  const isPlayerListLoading = playerList === null && playerListError === null;

  useEffect(() => writeStorageJson(rosterStorageKey, roster), [roster]);
  useEffect(() => writeStorageJson(formatStorageKey, format), [format]);
  useEffect(() => {
    if (savedLineup) writeStorageJson(lineupStorageKey, savedLineup);
  }, [savedLineup]);

  const listedById = useMemo(() => new Map((playerList ?? []).map((player) => [player.id, player])), [playerList]);
  // Latest team from /players (trades, signings), falling back to the one saved when added.
  const rosterWithTeams = useMemo(
    () => roster.map((saved) => ({ ...saved, team: listedById.get(saved.id)?.team ?? saved.team })),
    [roster, listedById],
  );
  const { projections, gamesError, isLoadingGames, hasNoGames, refreshCount, loadedAt } =
    useRosterProjections(rosterWithTeams);
  const now = useNow();

  // How fresh the lineup's odds are: newest and oldest of each player's latest line update.
  const updateTimes = roster.flatMap((player) => {
    const projection = projections.get(player.id);
    return projection?.status === "ready" && projection.lastUpdatedAt ? [projection.lastUpdatedAt.getTime()] : [];
  });
  const newestUpdate = updateTimes.length ? new Date(Math.max(...updateTimes)) : null;
  const oldestUpdate = updateTimes.length ? new Date(Math.min(...updateTimes)) : null;
  const rosterIds = useMemo(() => new Set(roster.map((player) => player.id)), [roster]);

  // Search the full player list; names starting with the query come first.
  const suggestions = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text || !playerList) return [];
    const startsWith = (player: ListedPlayer) => player.name.toLowerCase().startsWith(text);
    return playerList
      .filter((player) => !rosterIds.has(player.id))
      .filter((player) => `${player.name} ${player.team}`.toLowerCase().includes(text))
      .sort((a, b) => Number(startsWith(b)) - Number(startsWith(a)) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [playerList, query, rosterIds]);

  // Points come from each player's projected stats (computed from their raw lines) under
  // the current scoring. Players without a projection count as 0 until one arrives.
  const rosterWithPoints: RosterPlayer[] = rosterWithTeams.map((saved) => {
    const projection = projections.get(saved.id) ?? { status: "loading" as const };
    if (projection.status !== "ready") {
      return {
        ...saved,
        points: 0,
        breakdown: [],
        stats: null,
        gameId: projection.status === "no-lines" ? projection.gameId : null,
        opponent: projection.status === "no-lines" ? projection.opponent : null,
        hasProjection: false,
        note: projectionNote(projection),
      };
    }
    const breakdown = getPointsBreakdown(projection.stats, saved.position, settings);
    return {
      ...saved,
      points: breakdown.reduce((total, item) => total + item.points, 0),
      breakdown,
      stats: projection.stats,
      gameId: projection.gameId,
      opponent: projection.opponent,
      hasProjection: true,
      note: null,
    };
  });
  const isLoadingProjections = isLoadingGames || rosterWithPoints.some((player) => player.note === "Loading lines…");
  const optimal = optimizeLineup(rosterWithPoints, format);
  const starterCount = slotTypes.reduce((total, slot) => total + format[slot], 0);

  // The user's lineup, fitted to the current format and team (see reconcileLineup). Every
  // start/sit action works from this, so slot indexes always line up with what's shown.
  const lineup = useMemo(
    () => reconcileLineup(savedLineup ?? { starters: [], bench: [] }, format, roster),
    [savedLineup, format, roster],
  );

  // First visit (nothing saved yet): start from the optimal lineup once projections are in.
  useEffect(() => {
    if (savedLineup === null && roster.length > 0 && !isLoadingProjections) {
      setSavedLineup(lineupFromOptimal(optimal));
    }
    // optimal is derived from the same inputs; only re-check when loading settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedLineup, roster.length, isLoadingProjections]);

  const playersById = new Map(rosterWithPoints.map((player) => [player.id, player]));
  const starters = lineup.starters.map(({ slot, playerId }) => ({
    slot,
    player: playerId ? (playersById.get(playerId) ?? null) : null,
  }));
  const bench = lineup.bench.flatMap((id) => playersById.get(id) ?? []);
  const currentTotal = starters.reduce((total, { player }) => total + (player?.points ?? 0), 0);
  const pointsBehindOptimal = optimal.total - currentTotal;
  const isOptimal = pointsBehindOptimal < 0.05;
  const optimalStarterIds = new Set(optimal.starters.flatMap(({ player }) => (player ? [player.id] : [])));

  function addPlayer(player: ListedPlayer) {
    const { id, name, position, team } = player;
    setRoster((current) => (current.some((item) => item.id === id) ? current : [...current, { id, name, position, team }]));
    // Before the first lineup exists, the first optimal fill will place them.
    if (savedLineup) setSavedLineup(placeNewPlayer(lineup, id, position));
    setQuery("");
  }

  function removePlayer(id: string) {
    setRoster((current) => current.filter((player) => player.id !== id));
    if (savedLineup) {
      setSavedLineup({
        starters: lineup.starters.map((entry) => (entry.playerId === id ? { ...entry, playerId: null } : entry)),
        bench: lineup.bench.filter((benchId) => benchId !== id),
      });
    }
  }

  function applyOptimalLineup() {
    setSavedLineup(lineupFromOptimal(optimal));
  }

  function setSlotCount(slot: keyof LineupFormat, value: number) {
    setFormat((current) => ({ ...current, [slot]: Math.min(maxSlotsPerType, Math.max(0, value)) }));
  }

  function renderPlayerCell(player: RosterPlayer) {
    return (
      <>
        <span className="lineup-name">{player.name}</span>
        <span className="lineup-meta">
          {player.position} · {player.team}
          {player.opponent ? ` ${player.opponent}` : ""}
        </span>
      </>
    );
  }

  /** Bench player's "Start at…" choices: every slot they're eligible for, noting swaps. */
  function startOptions(player: RosterPlayer) {
    return lineup.starters.flatMap(({ slot }, index) => {
      if (!slotEligibility[slot].includes(player.position)) return [];
      const sameType = lineup.starters.filter((entry) => entry.slot === slot).length;
      const number = lineup.starters.slice(0, index + 1).filter((entry) => entry.slot === slot).length;
      const occupant = starters[index].player;
      const label = `${shortSlotLabel(slot)}${sameType > 1 ? ` ${number}` : ""}${occupant ? ` (swap ${occupant.name})` : " (empty)"}`;
      return [{ index, label }];
    });
  }

  function renderRow(
    slotLabel: string,
    player: RosterPlayer | null,
    emptyLabel: string,
    key: string,
    context: { kind: "starter"; slotIndex: number } | { kind: "bench" },
  ) {
    // Players with a game this week can be opened to see their raw bookmaker lines.
    const canExpand = player !== null && player.gameId !== null;
    const isExpanded = canExpand && expandedPlayerId === player.id;
    const toggle = () => canExpand && setExpandedPlayerId(isExpanded ? null : player.id);
    return (
      <Fragment key={key}>
        <tr
          className={canExpand ? (isExpanded ? "player-row expanded" : "player-row") : undefined}
          onClick={toggle}
        >
          <td className="lineup-slot">{slotLabel}</td>
          <td>
            {!player ? (
              <span className="lineup-empty">{emptyLabel}</span>
            ) : canExpand ? (
              <button
                type="button"
                className="row-toggle lineup-toggle"
                aria-expanded={isExpanded}
                aria-controls={`lineup-lines-${player.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  toggle();
                }}
              >
                <span className="row-chevron" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
                <span>{renderPlayerCell(player)}</span>
              </button>
            ) : (
              renderPlayerCell(player)
            )}
            {player && context.kind === "starter" && player.hasProjection && !optimalStarterIds.has(player.id) && (
              <span className="lineup-tag sit">Not in optimal</span>
            )}
            {player && context.kind === "bench" && optimalStarterIds.has(player.id) && (
              <span className="lineup-tag start">Optimal starter</span>
            )}
          </td>
          <td className="points">
            {!player ? "—" : player.hasProjection ? player.points.toFixed(1) : <span className="lineup-empty">{player.note}</span>}
          </td>
          <td className="breakdown">
            {player && player.breakdown.length > 0 && (
              <ul className="breakdown-list">
                {player.breakdown.map((item) => (
                  <li key={item.label}>
                    <span>{item.label}</span>
                    <span className={item.points < 0 ? "breakdown-points negative" : "breakdown-points"}>
                      {formatPoints(item.points)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </td>
          <td className="action">
            {player && (
              <span className="lineup-actions">
                {context.kind === "starter" ? (
                  <button
                    type="button"
                    className="row-action"
                    aria-label={`Move ${player.name} to the bench`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSavedLineup(sitPlayer(lineup, context.slotIndex));
                    }}
                  >
                    Sit
                  </button>
                ) : (
                  <select
                    className="start-select"
                    aria-label={`Start ${player.name} at…`}
                    value=""
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const slotIndex = Number(event.currentTarget.value);
                      if (!Number.isNaN(slotIndex)) setSavedLineup(startPlayer(lineup, player.id, slotIndex));
                    }}
                    disabled={startOptions(player).length === 0}
                  >
                    <option value="" disabled>
                      Start at…
                    </option>
                    {startOptions(player).map((option) => (
                      <option key={option.index} value={option.index}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              <button
                type="button"
                className="row-action"
                aria-label={`Remove ${player.name} from your team`}
                onClick={(event) => {
                  event.stopPropagation();
                  removePlayer(player.id);
                }}
              >
                Remove
              </button>
              </span>
            )}
          </td>
        </tr>
        {isExpanded && player.gameId && (
          <tr className="lines-row" id={`lineup-lines-${player.id}`}>
            <td colSpan={5}>
              <PlayerLinesPanel
                // Remount after an automatic refetch so an open panel shows the new lines.
                key={refreshCount}
                player={{
                  id: player.id,
                  gameId: player.gameId,
                  name: player.name,
                  stats: player.stats ?? emptyStats,
                  breakdown: player.breakdown,
                }}
              />
            </td>
          </tr>
        )}
      </Fragment>
    );
  }

  const currentPreset = presetName(format);

  return (
    <section className="player-list lineup" aria-label="Lineup optimizer">
      <div className="list-heading">
        <div>
          <h2>Lineup optimizer</h2>
          <p>
            Add your team, set your starters, and compare against the optimal lineup
            {` · ${weekRangeLabel()}`}
          </p>
        </div>
      </div>

      {scoringControl}

      <div className="scoring-dropdown">
        <button
          type="button"
          className="scoring-trigger"
          aria-expanded={isFormatMenuOpen}
          aria-controls="league-format"
          onClick={() => setIsFormatMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setIsFormatMenuOpen(false);
          }}
        >
          <span>League format</span>
          <span className="current-format">
            {currentPreset} · {starterCount} starters
          </span>
          <span className="dropdown-chevron" aria-hidden="true">{isFormatMenuOpen ? "⌃" : "⌄"}</span>
        </button>
        {isFormatMenuOpen && (
          <div
            className="scoring-menu"
            id="league-format"
            role="region"
            aria-label="League format"
            onKeyDown={(event) => {
              if (event.key === "Escape") setIsFormatMenuOpen(false);
            }}
          >
            <div className="settings-menu-header">
              <div>
                <p className="menu-title">Starting lineup</p>
                <p className="menu-description">Choose a preset or set how many of each slot your league starts.</p>
              </div>
              <div className="scoring-formats" aria-label="League format preset">
                {lineupPresets.map((preset) => (
                  <button
                    type="button"
                    key={preset.name}
                    className={currentPreset === preset.name ? "format-option selected" : "format-option"}
                    aria-pressed={currentPreset === preset.name}
                    onClick={() => setFormat({ ...preset.format })}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-grid">
              {slotTypes.map((slot) => (
                <div className="setting-field" key={slot}>
                  <span>{slotLabels[slot]}</span>
                  <span className="stepper">
                    <button
                      type="button"
                      aria-label={`Fewer ${slot} slots`}
                      disabled={format[slot] === 0}
                      onClick={() => setSlotCount(slot, format[slot] - 1)}
                    >
                      −
                    </button>
                    <output aria-live="polite">{format[slot]}</output>
                    <button
                      type="button"
                      aria-label={`More ${slot} slots`}
                      disabled={format[slot] === maxSlotsPerType}
                      onClick={() => setSlotCount(slot, format[slot] + 1)}
                    >
                      +
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <p className="settings-note">
              {starterCount} starters · everyone else on your team goes to the bench. Saved in this browser.
            </p>
          </div>
        )}
      </div>

      <div className="lineup-body">
        <div className="lineup-panel-heading">
          <h3>My lineup</h3>
          <div className="lineup-totals">
            <span className="lineup-total">{currentTotal.toFixed(1)} pts</span>
            {roster.length > 0 &&
              (isOptimal ? (
                <span className="lineup-optimal-note">✓ Optimal lineup</span>
              ) : (
                <>
                  <span className="lineup-optimal-note">
                    Optimal {optimal.total.toFixed(1)} pts{" "}
                    {/* Your lineup relative to optimal, so it reads as points you're missing. */}
                    <span className="lineup-diff">(−{pointsBehindOptimal.toFixed(1)})</span>
                  </span>
                  <button type="button" className="format-option" onClick={applyOptimalLineup}>
                    Use optimal lineup
                  </button>
                </>
              ))}
          </div>
        </div>

        {roster.length > 0 && (
          <div className="lineup-freshness">
            {newestUpdate && oldestUpdate ? (
              <span
                title={`Odds last updated ${formatTimestamp(newestUpdate)} (newest) · ${formatTimestamp(oldestUpdate)} (oldest player). Loaded into this page ${formatTimestamp(loadedAt)}.`}
              >
                Lines updated <strong>{timeAgo(newestUpdate, now)}</strong>
                {oldestUpdate.getTime() !== newestUpdate.getTime() && (
                  <>
                    {" "}
                    · oldest <strong>{timeAgo(oldestUpdate, now)}</strong>
                  </>
                )}
              </span>
            ) : (
              <span>{isLoadingProjections ? "Loading lines…" : "No line updates yet"}</span>
            )}
          </div>
        )}

        <div className="roster-search">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && suggestions[0]) addPlayer(suggestions[0]);
              if (event.key === "Escape") setQuery("");
            }}
            placeholder={isPlayerListLoading ? "Loading players..." : "Add a player to your team by name or team"}
            aria-label="Search players to add to your team"
            disabled={isPlayerListLoading || playerList === null}
          />
          {suggestions.length > 0 && (
            <ul className="roster-suggestions" aria-label="Matching players">
              {suggestions.map((player) => (
                <li key={player.id}>
                  <button type="button" onClick={() => addPlayer(player)}>
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

        {isLoadingProjections && (
          <p className="lineup-note" role="status">Loading bookmaker lines and calculating projections…</p>
        )}
        {gamesError && <p className="lineup-note error-state" role="alert">{gamesError}</p>}
        {hasNoGames && (
          <p className="lineup-note error-state" role="alert">
            No games were returned for this week ({weekRangeLabel()}), so no projections can be calculated.
          </p>
        )}
        {roster.length === 0 && (
          <p className="lineup-note">Your team is empty. Search above to add your players; they're saved in this browser.</p>
        )}

        <div className="lineup-table-scroll">
          <table className="lineup-table">
            <thead>
              <tr>
                <th scope="col">Slot</th>
                <th scope="col">Player</th>
                <th scope="col" className="points-heading">Proj</th>
                <th scope="col">Breakdown</th>
                <th scope="col" className="action-heading"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {starters.map(({ slot, player }, index) =>
                renderRow(
                  shortSlotLabel(slot),
                  player,
                  "Empty",
                  `${slot}-${index}`,
                  { kind: "starter", slotIndex: index },
                ),
              )}
            </tbody>
          </table>
        </div>

        {bench.length > 0 && (
          <>
            <h3 className="bench-heading">Bench</h3>
            <div className="lineup-table-scroll">
              <table className="lineup-table bench">
                <tbody>{bench.map((player) => renderRow("BN", player, "", player.id, { kind: "bench" }))}</tbody>
              </table>
            </div>
          </>
        )}
        {rosterWithPoints.some((player) => !player.hasProjection && !player.note?.startsWith("Loading")) && (
          <p className="lineup-note">
            Players without a projection (no game this week, or no bookmaker lines yet) count as 0. Projections
            are calculated from each player's raw bookmaker lines.
          </p>
        )}
      </div>
    </section>
  );
}
