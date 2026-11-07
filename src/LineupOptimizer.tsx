import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getAllPlayers, type ListedPlayer } from "./api/players";
import type { Player, Position } from "./api/rankings";
import { currentNflWeek } from "./nflWeek";
import { getPointsBreakdown, type ScoringSettings } from "./scoring";
import { useRosterProjections, type PlayerProjection } from "./useRosterProjections";
import {
  lineupPresets,
  optimizeLineup,
  slotLabels,
  slotTypes,
  type LineupFormat,
  type RosterPlayer,
} from "./lineup";
import { readStorageJson, writeStorageJson } from "./storage";

type SavedRosterPlayer = Pick<Player, "id" | "name" | "position" | "team">;

const rosterStorageKey = "fantasy-my-team";
const formatStorageKey = "fantasy-lineup-format";
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

  const listedById = useMemo(() => new Map((playerList ?? []).map((player) => [player.id, player])), [playerList]);
  // Latest team from /players (trades, signings), falling back to the one saved when added.
  const rosterWithTeams = useMemo(
    () => roster.map((saved) => ({ ...saved, team: listedById.get(saved.id)?.team ?? saved.team })),
    [roster, listedById],
  );
  const { projections, gamesError, isLoadingGames, hasNoGames } = useRosterProjections(rosterWithTeams);
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
      opponent: projection.opponent,
      hasProjection: true,
      note: null,
    };
  });
  const isLoadingProjections = isLoadingGames || rosterWithPoints.some((player) => player.note === "Loading lines…");
  const lineup = optimizeLineup(rosterWithPoints, format);
  const starterCount = slotTypes.reduce((total, slot) => total + format[slot], 0);

  function addPlayer(player: ListedPlayer) {
    const { id, name, position, team } = player;
    setRoster((current) => (current.some((item) => item.id === id) ? current : [...current, { id, name, position, team }]));
    setQuery("");
  }

  function removePlayer(id: string) {
    setRoster((current) => current.filter((player) => player.id !== id));
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

  function renderRow(slotLabel: string, player: RosterPlayer | null, emptyLabel: string, key: string) {
    return (
      <tr key={key}>
        <td className="lineup-slot">{slotLabel}</td>
        <td>{player ? renderPlayerCell(player) : <span className="lineup-empty">{emptyLabel}</span>}</td>
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
            <button
              type="button"
              className="row-action"
              aria-label={`Remove ${player.name} from your team`}
              onClick={() => removePlayer(player.id)}
            >
              Remove
            </button>
          )}
        </td>
      </tr>
    );
  }

  const currentPreset = presetName(format);

  return (
    <section className="player-list lineup" aria-label="Lineup optimizer">
      <div className="list-heading">
        <div>
          <h2>Lineup optimizer</h2>
          <p>
            Add your team and the best lineup is filled from this week's projections
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
          <h3>Optimal lineup</h3>
          <span className="lineup-total">{lineup.total.toFixed(1)} pts</span>
        </div>

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
              {lineup.starters.map(({ slot, player }, index) =>
                renderRow(
                  slot === "SUPERFLEX" ? "SFLEX" : slot,
                  player,
                  `Empty — add a ${slotLabels[slot].replace(/ \(.*/, "")} eligible player`,
                  `${slot}-${index}`,
                ),
              )}
            </tbody>
          </table>
        </div>

        {lineup.bench.length > 0 && (
          <>
            <h3 className="bench-heading">Bench</h3>
            <div className="lineup-table-scroll">
              <table className="lineup-table bench">
                <tbody>{lineup.bench.map((player) => renderRow("BN", player, "", player.id))}</tbody>
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
