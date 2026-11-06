import { Fragment, useEffect, useMemo, useState } from "react";
import { PlayerLinesPanel } from "./PlayerLinesPanel";
import {
  getPlayerProjections,
  type Player,
  type PlayerStats,
  type Position,
  type ProjectionWeek,
} from "./api/rankings";

type PositionFilter = "ALL" | "FLEX" | Position;
type ScoringFormat = "PPR" | "Half PPR" | "Standard" | "Custom";

const positions: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K"];
const excludedPositions: ("ALL" | Position)[] = ["ALL", "QB", "RB", "WR", "TE", "K"];
const scoringPresets = {
  PPR: {
    passingYards: 1,
    passingYardsPer: 25,
    passingTouchdown: 4,
    interception: -2,
    rushingYards: 1,
    rushingYardsPer: 10,
    rushingTouchdown: 6,
    reception: 1,
    tightEndReceptionBonus: 0,
    receivingYards: 1,
    receivingYardsPer: 10,
    receivingTouchdown: 6,
    fumbleLost: -2,
    fieldGoalUnder40: 3,
    fieldGoal40To49: 4,
    fieldGoal50Plus: 5,
  },
  "Half PPR": {
    passingYards: 1,
    passingYardsPer: 25,
    passingTouchdown: 4,
    interception: -2,
    rushingYards: 1,
    rushingYardsPer: 10,
    rushingTouchdown: 6,
    reception: 0.5,
    tightEndReceptionBonus: 0,
    receivingYards: 1,
    receivingYardsPer: 10,
    receivingTouchdown: 6,
    fumbleLost: -2,
    fieldGoalUnder40: 3,
    fieldGoal40To49: 4,
    fieldGoal50Plus: 5,
  },
  Standard: {
    passingYards: 1,
    passingYardsPer: 25,
    passingTouchdown: 4,
    interception: -2,
    rushingYards: 1,
    rushingYardsPer: 10,
    rushingTouchdown: 6,
    reception: 0,
    tightEndReceptionBonus: 0,
    receivingYards: 1,
    receivingYardsPer: 10,
    receivingTouchdown: 6,
    fumbleLost: -2,
    fieldGoalUnder40: 3,
    fieldGoal40To49: 4,
    fieldGoal50Plus: 5,
  },
} as const;

type ScoringSettingKey = keyof typeof scoringPresets.PPR;
type ScoringSettings = Record<ScoringSettingKey, number>;

const scoringSettingFields: {
  key: ScoringSettingKey;
  label: string;
  unit: string;
  step?: number;
}[] = [
  { key: "passingYards", label: "Passing yards", unit: "pts" },
  { key: "passingYardsPer", label: "Passing yards per", unit: "yds", step: 1 },
  { key: "passingTouchdown", label: "Passing touchdown", unit: "pts" },
  { key: "interception", label: "Interception", unit: "pts" },
  { key: "rushingYards", label: "Rushing yards", unit: "pts" },
  { key: "rushingYardsPer", label: "Rushing yards per", unit: "yds", step: 1 },
  { key: "rushingTouchdown", label: "Rushing touchdown", unit: "pts" },
  { key: "reception", label: "Reception", unit: "pts" },
  { key: "tightEndReceptionBonus", label: "TE reception bonus", unit: "pts" },
  { key: "receivingYards", label: "Receiving yards", unit: "pts" },
  { key: "receivingYardsPer", label: "Receiving yards per", unit: "yds", step: 1 },
  { key: "receivingTouchdown", label: "Receiving touchdown", unit: "pts" },
  { key: "fumbleLost", label: "Fumble lost", unit: "pts" },
  { key: "fieldGoalUnder40", label: "Field goal under 40 yds", unit: "pts" },
  { key: "fieldGoal40To49", label: "Field goal 40–49 yds", unit: "pts" },
  { key: "fieldGoal50Plus", label: "Field goal 50+ yds", unit: "pts" },
] as const;

type BreakdownItem = { key: keyof PlayerStats; label: string; points: number };

function formatStat(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

type RankedPlayer = Player & { rank: number; points: number; breakdown: BreakdownItem[] };

function yardagePoints(yards: number, points: number, per: number) {
  return per > 0 ? (yards / per) * points : 0;
}

function getPointsBreakdown(
  stats: PlayerStats,
  position: Position,
  settings: ScoringSettings,
): BreakdownItem[] {
  const touchdownPoints =
    position === "WR" || position === "TE" ? settings.receivingTouchdown : settings.rushingTouchdown;
  const items: (BreakdownItem & { value: number })[] = [
    {
      key: "passingYards",
      value: stats.passingYards,
      label: `${formatStat(stats.passingYards)} pass yds`,
      points: yardagePoints(stats.passingYards, settings.passingYards, settings.passingYardsPer),
    },
    {
      key: "passingTouchdowns",
      value: stats.passingTouchdowns,
      label: `${formatStat(stats.passingTouchdowns)} pass TD`,
      points: stats.passingTouchdowns * settings.passingTouchdown,
    },
    {
      key: "interceptions",
      value: stats.interceptions,
      label: `${formatStat(stats.interceptions)} INT`,
      points: stats.interceptions * settings.interception,
    },
    {
      key: "rushingYards",
      value: stats.rushingYards,
      label: `${formatStat(stats.rushingYards)} rush yds`,
      points: yardagePoints(stats.rushingYards, settings.rushingYards, settings.rushingYardsPer),
    },
    {
      key: "receptions",
      value: stats.receptions,
      label: `${formatStat(stats.receptions)} rec`,
      points:
        stats.receptions *
        (settings.reception + (position === "TE" ? settings.tightEndReceptionBonus : 0)),
    },
    {
      key: "receivingYards",
      value: stats.receivingYards,
      label: `${formatStat(stats.receivingYards)} rec yds`,
      points: yardagePoints(stats.receivingYards, settings.receivingYards, settings.receivingYardsPer),
    },
    {
      key: "touchdowns",
      value: stats.touchdowns,
      label: `${formatStat(stats.touchdowns)} TD`,
      points: stats.touchdowns * touchdownPoints,
    },
    {
      key: "kickingPoints",
      value: stats.kickingPoints,
      label: "Kicking",
      points: stats.kickingPoints,
    },
  ];
  return items
    .filter((item) => item.value !== 0)
    .map(({ key, label, points }) => ({ key, label, points }));
}

function formatWeek(week: ProjectionWeek) {
  const format = (date: Date) =>
    date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const games = week.games > 0 ? ` · ${week.games} games` : "";
  return `Week of ${format(week.start)} – ${format(week.end)}${games}`;
}

function formatPoints(points: number) {
  return `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(1)}`;
}

const scoringStorageKey = "fantasy-scoring-settings";
const excludedPlayersStorageKey = "fantasy-excluded-players";
/** Older versions saved settings in cookies (same names) or exclusions by name; migrated on load. */
const scoringCookieName = "fantasy-scoring-settings";
const excludedPlayersCookieName = "fantasy-excluded-players";
const legacyExcludedNamesStorageKey = "fantasy-omitted-players";

/**
 * Details are saved with each excluded ID so the Excluded players dropdown can list them
 * even if they're missing from a later week's projections.
 */
type ExcludedPlayer = Pick<Player, "id" | "name" | "position" | "team">;

function readStorageJson(key: string): unknown {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch (error) {
    console.warn(`Could not read saved "${key}".`, error);
    return null;
  }
}

function writeStorageJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not save "${key}".`, error);
  }
}

function removeStorageItem(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore: a leftover entry is harmless.
  }
}

function readCookie(name: string): string | null {
  const cookie = document.cookie.split("; ").find((item) => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function isExcludedPlayer(value: unknown): value is ExcludedPlayer {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.team === "string" &&
    excludedPositions.some((item) => item !== "ALL" && item === entry.position)
  );
}

function readExcludedPlayers(): {
  players: ExcludedPlayer[];
  /** From older versions: IDs (cookie) and names that need player details from the API. */
  pendingIds: string[];
  pendingNames: string[];
} {
  const stored = readStorageJson(excludedPlayersStorageKey);
  const players = Array.isArray(stored) ? stored.filter(isExcludedPlayer) : [];

  const cookieIds = readCookie(excludedPlayersCookieName)?.split(",").filter(Boolean) ?? [];
  const pendingIds = cookieIds.filter((id) => !players.some((player) => player.id === id));

  const legacyNames = readStorageJson(legacyExcludedNamesStorageKey);
  const pendingNames = Array.isArray(legacyNames)
    ? legacyNames.filter((name): name is string => typeof name === "string")
    : [];

  return { players, pendingIds, pendingNames };
}

function isScoringFormat(value: unknown): value is ScoringFormat {
  return value === "PPR" || value === "Half PPR" || value === "Standard" || value === "Custom";
}

function isScoringSettings(value: unknown): value is ScoringSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  return scoringSettingFields.every(
    ({ key }) => typeof settings[key] === "number" && Number.isFinite(settings[key]),
  );
}

function readScoringPreferences(): { format: ScoringFormat; settings: ScoringSettings } {
  try {
    const cookie = readCookie(scoringCookieName);
    const stored: unknown =
      readStorageJson(scoringStorageKey) ?? (cookie ? JSON.parse(cookie) : null);
    if (stored === null) return { format: "PPR", settings: { ...scoringPresets.PPR } };
    if (
      typeof stored === "object" &&
      stored !== null &&
      "format" in stored &&
      isScoringFormat(stored.format) &&
      "settings" in stored &&
      isScoringSettings(stored.settings)
    ) {
      return { format: stored.format, settings: stored.settings };
    }
    console.warn("Saved fantasy scoring preferences are invalid; using PPR defaults.");
  } catch (error) {
    console.warn("Could not read saved fantasy scoring preferences; using PPR defaults.", error);
  }

  return { format: "PPR", settings: { ...scoringPresets.PPR } };
}

function App() {
  const [position, setPosition] = useState<PositionFilter>("ALL");
  const [search, setSearch] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [projectionWeek, setProjectionWeek] = useState<ProjectionWeek | null>(null);
  const [isLoadingPlayers, setIsLoadingPlayers] = useState(true);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [initialScoring] = useState(readScoringPreferences);
  const [scoringFormat, setScoringFormat] = useState<ScoringFormat>(initialScoring.format);
  const [settings, setSettings] = useState<ScoringSettings>(initialScoring.settings);
  const [isScoringMenuOpen, setIsScoringMenuOpen] = useState(false);
  const [initialExcluded] = useState(readExcludedPlayers);
  const [excludedPlayers, setExcludedPlayers] = useState<ExcludedPlayer[]>(initialExcluded.players);
  const [pendingExcluded, setPendingExcluded] = useState({
    ids: initialExcluded.pendingIds,
    names: initialExcluded.pendingNames,
  });
  const [isExcludedMenuOpen, setIsExcludedMenuOpen] = useState(false);
  const [excludedPosition, setExcludedPosition] = useState<"ALL" | Position>("ALL");
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null);

  function toggleExpanded(id: string) {
    setExpandedPlayerId((current) => (current === id ? null : id));
  }

  useEffect(() => {
    const controller = new AbortController();

    getPlayerProjections(controller.signal)
      .then(({ players: loadedPlayers, week }) => {
        setPlayers(loadedPlayers);
        setProjectionWeek(week);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPlayersError(
          error instanceof Error ? error.message : "Could not load player projections.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingPlayers(false);
      });

    return () => controller.abort();
  }, []);

  // Fill in details for exclusions saved by older versions (cookie IDs or names only).
  useEffect(() => {
    if (players.length === 0) return;
    if (pendingExcluded.ids.length === 0 && pendingExcluded.names.length === 0) return;
    const migrated = players
      .filter(
        (player) =>
          pendingExcluded.ids.includes(player.id) || pendingExcluded.names.includes(player.name),
      )
      .map(({ id, name, position, team }) => ({ id, name, position, team }));
    setExcludedPlayers((current) => [
      ...current,
      ...migrated.filter((player) => !current.some((item) => item.id === player.id)),
    ]);
    setPendingExcluded({ ids: [], names: [] });
    deleteCookie(excludedPlayersCookieName);
    removeStorageItem(legacyExcludedNamesStorageKey);
  }, [pendingExcluded, players]);

  useEffect(() => {
    writeStorageJson(scoringStorageKey, { format: scoringFormat, settings });
    deleteCookie(scoringCookieName);
  }, [scoringFormat, settings]);

  useEffect(() => {
    writeStorageJson(excludedPlayersStorageKey, excludedPlayers);
  }, [excludedPlayers]);

  function excludePlayer({ id, name, position, team }: Player) {
    setExcludedPlayers((current) =>
      current.some((item) => item.id === id) ? current : [...current, { id, name, position, team }],
    );
  }

  function restorePlayer(id: string) {
    setExcludedPlayers((current) => current.filter((item) => item.id !== id));
  }

  function selectScoringFormat(format: Exclude<ScoringFormat, "Custom">) {
    setScoringFormat(format);
    setSettings({ ...scoringPresets[format] });
  }

  function updateScoringSetting(key: ScoringSettingKey, value: string) {
    setScoringFormat("Custom");
    setSettings((current) => ({ ...current, [key]: value === "" ? 0 : Number(value) }));
  }

  const excludedSet = useMemo(
    () => new Set(excludedPlayers.map((player) => player.id)),
    [excludedPlayers],
  );

  // Sorted by projected points; ranks are assigned per position tab below.
  const scoredPlayers = useMemo(
    () =>
      players
        .filter((player) => !excludedSet.has(player.id))
        .map((player) => {
          const breakdown = getPointsBreakdown(player.stats, player.position, settings);
          const points = breakdown.reduce((total, item) => total + item.points, 0);
          return { ...player, breakdown, points };
        })
        .sort((a, b) => b.points - a.points),
    [players, settings, excludedSet],
  );

  const visibleExcludedPlayers = excludedPlayers.filter(
    (player) => excludedPosition === "ALL" || player.position === excludedPosition,
  );

  // Ranks are within the selected position tab; search only narrows the list, keeping those ranks.
  const filteredPlayers = useMemo<RankedPlayer[]>(() => {
    const query = search.trim().toLowerCase();
    return scoredPlayers
      .filter(
        (player) =>
          position === "ALL" ||
          (position === "FLEX" && ["RB", "WR", "TE"].includes(player.position)) ||
          player.position === position,
      )
      .map((player, index) => ({ ...player, rank: index + 1 }))
      .filter((player) =>
        `${player.name} ${player.team} ${player.opponent}`.toLowerCase().includes(query),
      );
  }, [scoredPlayers, position, search]);

  return (
    <main className="page">
      <header className="page-header">
        <p className="eyebrow">FANTASY FOOTBALL</p>
        <h1>Player projections</h1>
        <p className="subtitle">Weekly point projections for fantasy football players.</p>
      </header>

      <section className="player-list" aria-label="Player rankings">
        <div className="list-heading">
          <div>
            <h2>All players</h2>
            <p>{projectionWeek ? formatWeek(projectionWeek) : "Weekly point projections"}</p>
          </div>
          <label className="search">
            <span>Search</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Player or team"
              aria-label="Search by player or team"
            />
          </label>
        </div>

        <div className="scoring-dropdown">
          <button
            type="button"
            className="scoring-trigger"
            aria-expanded={isScoringMenuOpen}
            aria-controls="scoring-settings"
            onClick={() => setIsScoringMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setIsScoringMenuOpen(false);
            }}
          >
            <span>Points settings</span>
            <span className="current-format">{scoringFormat}</span>
            <span className="dropdown-chevron" aria-hidden="true">{isScoringMenuOpen ? "⌃" : "⌄"}</span>
          </button>
          {isScoringMenuOpen && (
            <div
              className="scoring-menu"
              id="scoring-settings"
              role="region"
              aria-label="Scoring settings"
              onKeyDown={(event) => {
                if (event.key === "Escape") setIsScoringMenuOpen(false);
              }}
            >
              <div className="settings-menu-header">
                <div>
                  <p className="menu-title">Scoring format</p>
                  <p className="menu-description">Choose a preset or edit any value below.</p>
                </div>
                <div className="scoring-formats" aria-label="Scoring format">
                  {(["PPR", "Half PPR", "Standard"] as const).map((format) => (
                    <button
                      type="button"
                      key={format}
                      className={scoringFormat === format ? "format-option selected" : "format-option"}
                      aria-pressed={scoringFormat === format}
                      onClick={() => selectScoringFormat(format)}
                    >
                      {format}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-grid">
                {scoringSettingFields.map(({ key, label, unit, step }) => (
                  <label className="setting-field" key={key}>
                    <span>{label}</span>
                    <span className="setting-input-wrap">
                      <input
                        type="number"
                        step={step ?? 0.5}
                        value={settings[key]}
                        aria-label={label}
                        onChange={(event) => updateScoringSetting(key, event.currentTarget.value)}
                      />
                      <span>{unit}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="settings-note">Custom scoring settings are saved for this page. Projected points are calculated from these settings. Kicker projections arrive pre-scored, so field goal and fumble values don't change them.</p>
            </div>
          )}
        </div>

        <div className="scoring-dropdown excluded-dropdown">
          <button
            type="button"
            className="scoring-trigger"
            aria-expanded={isExcludedMenuOpen}
            aria-controls="excluded-players"
            onClick={() => setIsExcludedMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setIsExcludedMenuOpen(false);
            }}
          >
            <span>Excluded players</span>
            <span className="current-format">{excludedPlayers.length}</span>
            <span className="dropdown-chevron" aria-hidden="true">{isExcludedMenuOpen ? "⌃" : "⌄"}</span>
          </button>
          {isExcludedMenuOpen && (
            <div
              className="scoring-menu"
              id="excluded-players"
              role="region"
              aria-label="Excluded players"
              onKeyDown={(event) => {
                if (event.key === "Escape") setIsExcludedMenuOpen(false);
              }}
            >
              <div className="settings-menu-header">
                <div>
                  <p className="menu-title">Excluded players</p>
                  <p className="menu-description">Excluded players are hidden from the rankings, and everyone else is re-ranked.</p>
                </div>
                <button
                  type="button"
                  className="format-option"
                  disabled={excludedPlayers.length === 0}
                  onClick={() => setExcludedPlayers([])}
                >
                  Restore all
                </button>
              </div>
              <div className="excluded-tabs" role="group" aria-label="Filter excluded players by position">
                {excludedPositions.map((item) => {
                  const count =
                    item === "ALL"
                      ? excludedPlayers.length
                      : excludedPlayers.filter((player) => player.position === item).length;
                  return (
                    <button
                      type="button"
                      key={item}
                      className={excludedPosition === item ? "filter active" : "filter"}
                      aria-pressed={excludedPosition === item}
                      onClick={() => setExcludedPosition(item)}
                    >
                      {item === "ALL" ? "All" : item}
                      <span className="tab-count">{count}</span>
                    </button>
                  );
                })}
              </div>
              {visibleExcludedPlayers.length === 0 ? (
                <p className="excluded-empty">
                  {excludedPlayers.length === 0
                    ? "No players excluded. Use the Exclude button on a player row."
                    : `No ${excludedPosition} players excluded.`}
                </p>
              ) : (
                <ul className="excluded-list">
                  {visibleExcludedPlayers.map((player) => (
                    <li key={player.id}>
                      <span className="excluded-name">{player.name}</span>
                      <span className="excluded-meta">{player.position} · {player.team}</span>
                      <button
                        type="button"
                        className="row-action"
                        aria-label={`Restore ${player.name}`}
                        onClick={() => restorePlayer(player.id)}
                      >
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="list-controls">
          <div className="position-filters" aria-label="Filter by position">
            {positions.map((item) => (
              <button
                type="button"
                key={item}
                className={position === item ? "filter active" : "filter"}
                aria-pressed={position === item}
                onClick={() => setPosition(item)}
              >
                {item === "ALL" ? "All" : item}
              </button>
            ))}
            <span className="player-count">
              {isLoadingPlayers ? "Loading players..." : `${filteredPlayers.length} players`}
            </span>
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Player</th>
                <th scope="col">Pos</th>
                <th scope="col">Team</th>
                <th scope="col">Opponent</th>
                <th scope="col" className="points-heading">Projected points</th>
                <th scope="col">Breakdown</th>
                <th scope="col" className="action-heading"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {filteredPlayers.map((player) => {
                const isExpanded = expandedPlayerId === player.id;
                return (
                  <Fragment key={player.id}>
                    <tr
                      className={isExpanded ? "player-row expanded" : "player-row"}
                      onClick={() => toggleExpanded(player.id)}
                    >
                      <td className="rank">{player.rank}</td>
                      <td className="name">
                        <button
                          type="button"
                          className="row-toggle"
                          aria-expanded={isExpanded}
                          aria-controls={`lines-${player.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleExpanded(player.id);
                          }}
                        >
                          <span className="row-chevron" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
                          {player.name}
                        </button>
                      </td>
                      <td>{player.position}</td>
                      <td>{player.team}</td>
                      <td>{player.opponent}</td>
                      <td className="points">{player.points.toFixed(1)}</td>
                      <td className="breakdown">
                        {player.breakdown.length === 0 ? (
                          <span className="breakdown-empty">No projected stats</span>
                        ) : (
                          <ul className="breakdown-list">
                            {player.breakdown.map((item) => (
                              <li key={item.label}>
                                <span>{item.label}</span>
                                <span
                                  className={item.points < 0 ? "breakdown-points negative" : "breakdown-points"}
                                >
                                  {formatPoints(item.points)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="action">
                        <button
                          type="button"
                          className="row-action"
                          aria-label={`Exclude ${player.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            excludePlayer(player);
                          }}
                        >
                          Exclude
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="lines-row" id={`lines-${player.id}`}>
                        <td colSpan={8}>
                          <PlayerLinesPanel player={player} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {isLoadingPlayers && (
            <p className="empty-state" role="status">Loading player projections...</p>
          )}
          {playersError && (
            <p className="empty-state error-state" role="alert">{playersError}</p>
          )}
          {!isLoadingPlayers && !playersError && filteredPlayers.length === 0 && (
            <p className="empty-state">No players match your search.</p>
          )}
        </div>
      </section>
      <footer>Projected stats are provided by the server; points and ranks are calculated from your scoring settings.</footer>
    </main>
  );
}

export default App;
