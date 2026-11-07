import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Player, Position } from "./api/rankings";
import {
  lineupPresets,
  optimizeLineup,
  slotLabels,
  slotTypes,
  type LineupFormat,
  type RosterPlayer,
} from "./lineup";
import { readStorageJson, writeStorageJson } from "./storage";

type ProjectedPlayer = Player & { points: number };
type SavedRosterPlayer = Pick<Player, "id" | "name" | "position" | "team">;

const rosterStorageKey = "fantasy-my-team";
const formatStorageKey = "fantasy-lineup-format";
const positions: Position[] = ["QB", "RB", "WR", "TE", "K"];
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

function presetName(format: LineupFormat) {
  return (
    lineupPresets.find((preset) => slotTypes.every((slot) => preset.format[slot] === format[slot]))?.name ??
    "Custom"
  );
}

export function LineupOptimizer({
  players,
  isLoading,
  error,
  scoringControl,
  weekLabel,
}: {
  /** Every player with this week's projected points under the current scoring settings. */
  players: ProjectedPlayer[];
  isLoading: boolean;
  error: string | null;
  scoringControl: ReactNode;
  weekLabel: string | null;
}) {
  const [roster, setRoster] = useState<SavedRosterPlayer[]>(readRoster);
  const [format, setFormat] = useState<LineupFormat>(readFormat);
  const [query, setQuery] = useState("");
  const [isFormatMenuOpen, setIsFormatMenuOpen] = useState(false);

  useEffect(() => writeStorageJson(rosterStorageKey, roster), [roster]);
  useEffect(() => writeStorageJson(formatStorageKey, format), [format]);

  const playersById = useMemo(() => new Map(players.map((player) => [player.id, player])), [players]);
  const rosterIds = useMemo(() => new Set(roster.map((player) => player.id)), [roster]);

  const suggestions = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return [];
    return players
      .filter((player) => !rosterIds.has(player.id))
      .filter((player) => `${player.name} ${player.team}`.toLowerCase().includes(text))
      .slice(0, 8);
  }, [players, query, rosterIds]);

  // Rostered players without a projection this week (bye, injury, not listed) score 0.
  const rosterWithPoints: RosterPlayer[] = roster.map((saved) => {
    const projected = playersById.get(saved.id);
    return {
      ...saved,
      points: projected?.points ?? 0,
      opponent: projected?.opponent ?? null,
      hasProjection: projected !== undefined,
    };
  });
  const lineup = optimizeLineup(rosterWithPoints, format);
  const starterCount = slotTypes.reduce((total, slot) => total + format[slot], 0);

  function addPlayer(player: ProjectedPlayer) {
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
          {!player ? "—" : player.hasProjection ? player.points.toFixed(1) : <span className="lineup-empty">No proj</span>}
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
            {weekLabel && ` · ${weekLabel}`}
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
            placeholder={isLoading ? "Loading players..." : "Add a player to your team by name or team"}
            aria-label="Search players to add to your team"
            disabled={isLoading}
          />
          {suggestions.length > 0 && (
            <ul className="roster-suggestions" aria-label="Matching players">
              {suggestions.map((player) => (
                <li key={player.id}>
                  <button type="button" onClick={() => addPlayer(player)}>
                    <span className="lineup-name">{player.name}</span>
                    <span className="lineup-meta">
                      {player.position} · {player.team} · {player.points.toFixed(1)} pts
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && suggestions.length === 0 && !isLoading && (
            <p className="lineup-note">No players match "{query.trim()}".</p>
          )}
        </div>

        {error && <p className="lineup-note error-state" role="alert">{error}</p>}
        {roster.length === 0 && (
          <p className="lineup-note">Your team is empty. Search above to add your players; they're saved in this browser.</p>
        )}

        <table className="lineup-table">
          <thead>
            <tr>
              <th scope="col">Slot</th>
              <th scope="col">Player</th>
              <th scope="col" className="points-heading">Proj</th>
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

        {lineup.bench.length > 0 && (
          <>
            <h3 className="bench-heading">Bench</h3>
            <table className="lineup-table bench">
              <tbody>{lineup.bench.map((player) => renderRow("BN", player, "", player.id))}</tbody>
            </table>
          </>
        )}
        {rosterWithPoints.some((player) => !player.hasProjection) && (
          <p className="lineup-note">
            "No proj" players aren't in this week's projections (bye, injury or no lines yet) and count as 0.
          </p>
        )}
      </div>
    </section>
  );
}
