import { Fragment, useEffect, useMemo, useState } from "react";
import { signOut, useSession } from "./AuthGate";
import { LineupOptimizer } from "./LineupOptimizer";
import { currentNflWeek } from "./nflWeek";
import { PlayerLinesPanel } from "./PlayerLinesPanel";
import {
  currentPage,
  currentRankingsPosition,
  pageHref,
  rankingsHref,
  type Page,
  type PositionFilter,
} from "./routes";
import { readStorageJson, removeStorageItem, writeStorageJson } from "./storage";
import {
  getPointsBreakdown,
  scoringPresets,
  scoringSections,
  scoringSettingFields,
  type BreakdownItem,
  type ScoringFormat,
  type ScoringSettingKey,
  type ScoringSettings,
} from "./scoring";
import { getPlayerProjections, type Player, type Position, type ProjectionWeek } from "./api/rankings";
import { getTeamProjections, type TeamProjection } from "./api/teams";

const positions: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "DST"];

function positionLabel(item: PositionFilter) {
  return item === "ALL" ? "All" : item === "DST" ? "D/ST" : item;
}
const excludedPositions: ("ALL" | Position)[] = ["ALL", "QB", "RB", "WR", "TE", "K"];

type RankedPlayer = Player & { rank: number; points: number; breakdown: BreakdownItem[] };
type RankedTeam = TeamProjection & { rank: number; projectedPointsAllowed: number | null };

/**
 * The NFL week the page queries ([from, to), Tuesday 4 AM Eastern to the next), shown as
 * its Tuesday–Monday dates in Eastern: "Nov 3 – 9", or "Oct 27 – Nov 2" across months.
 */
function formatQueriedWeek({ from, to }: { from: Date; to: Date }) {
  const parts = (date: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat(undefined, { timeZone: "America/New_York", month: "short", day: "numeric" })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  const start = parts(from);
  const end = parts(new Date(to.getTime() - 86_400_000)); // last day: Monday
  return start.month === end.month
    ? `${start.month} ${start.day} – ${end.day}`
    : `${start.month} ${start.day} – ${end.month} ${end.day}`;
}

/** Game count and last update, from the projections response. */
function formatWeek(week: ProjectionWeek | null, updatedAt: Date | null) {
  const parts: string[] = [];
  if (week && week.games > 0) parts.push(`${week.games} games`);
  if (updatedAt) parts.push(`Updated ${formatUpdatedAt(updatedAt)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "2:51 PM" today, "Thu 2:51 PM" within the past week, otherwise "Nov 6, 2:51 PM". */
function formatUpdatedAt(date: Date) {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const daysAgo = (Date.now() - date.getTime()) / 86_400_000;
  if (new Date().toDateString() === date.toDateString()) return time;
  if (daysAgo < 6) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
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

/**
 * Saved settings with any missing or invalid values (e.g. settings saved before the D/ST
 * fields existed) filled from the format's preset; PPR for Custom. Null if not an object.
 */
function completeScoringSettings(value: unknown, format: ScoringFormat): ScoringSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const saved = value as Record<string, unknown>;
  const settings: ScoringSettings = { ...scoringPresets[format === "Custom" ? "PPR" : format] };
  for (const { key } of scoringSettingFields) {
    const item = saved[key];
    if (typeof item === "number" && Number.isFinite(item)) settings[key] = item;
  }
  return settings;
}

function readScoringPreferences(): { format: ScoringFormat; settings: ScoringSettings } {
  try {
    const cookie = readCookie(scoringCookieName);
    const stored: unknown =
      readStorageJson(scoringStorageKey) ?? (cookie ? JSON.parse(cookie) : null);
    if (stored === null) return { format: "PPR", settings: { ...scoringPresets.PPR } };
    if (typeof stored === "object" && stored !== null && "format" in stored && isScoringFormat(stored.format)) {
      const settings = completeScoringSettings("settings" in stored ? stored.settings : null, stored.format);
      if (settings) return { format: stored.format, settings };
    }
    console.warn("Saved fantasy scoring preferences are invalid; using PPR defaults.");
  } catch (error) {
    console.warn("Could not read saved fantasy scoring preferences; using PPR defaults.", error);
  }

  return { format: "PPR", settings: { ...scoringPresets.PPR } };
}

const pageTabs: { page: Page; title: string }[] = [
  { page: "rankings", title: "Weekly rankings" },
  { page: "lineup", title: "Lineup optimizer" },
];

function App() {
  // The Rankings position tab lives in the URL (#/rankings/wr); see routes.ts.
  const [position, setPositionState] = useState<PositionFilter>(currentRankingsPosition);
  const setPosition = (next: PositionFilter) => {
    window.location.hash = rankingsHref(next);
  };
  const [search, setSearch] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [projectionWeek, setProjectionWeek] = useState<ProjectionWeek | null>(null);
  const [projectionsUpdatedAt, setProjectionsUpdatedAt] = useState<Date | null>(null);
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
  const [collapsedTeamGroups, setCollapsedTeamGroups] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState<Page>(currentPage);
  const session = useSession();
  // The week both projection requests ask for (from/to); shown in the heading.
  const [queriedWeek] = useState(currentNflWeek);

  // Hash routing (see routes.ts): follow tab clicks, back/forward and redirects.
  useEffect(() => {
    const onHashChange = () => {
      setPage(currentPage());
      // Leaving Rankings keeps the last tab, so returning to Rankings restores it.
      if (currentPage() === "rankings") setPositionState(currentRankingsPosition());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function toggleExpanded(id: string) {
    setExpandedPlayerId((current) => (current === id ? null : id));
  }

  function toggleTeamGroup(team: string) {
    setCollapsedTeamGroups((current) => {
      const next = new Set(current);
      if (next.has(team)) next.delete(team);
      else next.add(team);
      return next;
    });
  }

  // Projections only power the Rankings page, so they're fetched the first time it's shown;
  // the Lineup optimizer gets each player's projection from player-lines.
  const [hasRequestedProjections, setHasRequestedProjections] = useState(false);
  useEffect(() => {
    if (page === "rankings") setHasRequestedProjections(true);
  }, [page]);

  useEffect(() => {
    if (!hasRequestedProjections) return;
    const controller = new AbortController();

    getPlayerProjections(queriedWeek, controller.signal)
      .then(({ players: loadedPlayers, week, updatedAt }) => {
        setPlayers(loadedPlayers);
        setProjectionWeek(week);
        setProjectionsUpdatedAt(updatedAt);
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
  }, [hasRequestedProjections]);

  // Team game projections provide implied team scores for all weekly player groups.
  const isTeamTab = page === "rankings" && position === "DST";
  const [teams, setTeams] = useState<TeamProjection[]>([]);
  const [hasRequestedTeams, setHasRequestedTeams] = useState(false);
  const [isLoadingTeams, setIsLoadingTeams] = useState(true);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  useEffect(() => {
    if (page === "rankings") setHasRequestedTeams(true);
  }, [page]);

  useEffect(() => {
    if (!hasRequestedTeams) return;
    const controller = new AbortController();
    getTeamProjections(queriedWeek, controller.signal)
      .then(setTeams)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTeamsError(error instanceof Error ? error.message : "Could not load D/ST projections.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingTeams(false);
      });
    return () => controller.abort();
  }, [hasRequestedTeams]);

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

  const playerTeamGroups = useMemo(() => {
    const playersByTeam = new Map<string, RankedPlayer[]>();
    for (const player of filteredPlayers) {
      const group = playersByTeam.get(player.team) ?? [];
      group.push(player);
      playersByTeam.set(player.team, group);
    }

    const projectionsByTeam = new Map(teams.map((team) => [team.team, team]));
    return [...playersByTeam.entries()]
      .map(([team, teamPlayers]) => {
        const projection = projectionsByTeam.get(team);
        const impliedScore =
          projection && projection.gameTotal !== null && projection.spread !== null
            ? (projection.gameTotal - projection.spread) / 2
            : null;
        return {
          team,
          impliedScore,
          gameTotal: projection?.gameTotal ?? null,
          spread: projection?.spread ?? null,
          players: teamPlayers,
        };
      })
      .sort((a, b) => {
        if (a.impliedScore === null) return b.impliedScore === null ? a.team.localeCompare(b.team) : 1;
        if (b.impliedScore === null) return -1;
        return b.impliedScore - a.impliedScore || a.team.localeCompare(b.team);
      });
  }, [filteredPlayers, teams]);

  const filteredTeams = useMemo<RankedTeam[]>(() => {
    const query = search.trim().toLowerCase();
    return teams
      .map((team) => ({
        ...team,
        // The API spread is team-relative (it reverses for home and away), so this is the opponent's implied score.
        projectedPointsAllowed:
          team.gameTotal !== null && team.spread !== null ? (team.gameTotal + team.spread) / 2 : null,
      }))
      .sort((a, b) => {
        if (a.projectedPointsAllowed === null) return b.projectedPointsAllowed === null ? 0 : 1;
        if (b.projectedPointsAllowed === null) return -1;
        return a.projectedPointsAllowed - b.projectedPointsAllowed;
      })
      .map((team, index) => ({ ...team, rank: index + 1 }))
      .filter((team) => `${team.team} ${team.opponent}`.toLowerCase().includes(query));
  }, [teams, search]);

  const topFavoriteKeys = useMemo(
    () => {
      const favorites = teams
        .filter((team) => team.spread !== null && team.spread < 0)
        .sort((a, b) => a.spread! - b.spread!)
        .slice(0, 5);
      return new Map<string, number>(
        favorites.map((team, index): [string, number] => [`${team.team} ${team.matchup}`, index + 1]),
      );
    },
    [teams],
  );

  const renderSettingField = ({ key, label, unit, step }: (typeof scoringSettingFields)[number]) => (
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
  );

  const scoringControl = (
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
          {scoringSections.map(({ section, title, defaultOpen }) => (
            <details className="settings-section" key={section} open={defaultOpen}>
              <summary>{title}</summary>
              <div className="settings-grid">
                {scoringSettingFields.filter((field) => field.section === section).map(renderSettingField)}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <main className="page">
      <div className="top-bar">
        <nav className="page-tabs" aria-label="Pages">
          {pageTabs.map((tab) => (
            <a
              key={tab.page}
              // Rankings links back to the last position tab viewed.
              href={tab.page === "rankings" ? rankingsHref(position) : pageHref(tab.page)}
              className={page === tab.page ? "page-tab active" : "page-tab"}
              aria-current={page === tab.page ? "page" : undefined}
            >
              {tab.title}
            </a>
          ))}
        </nav>
        {session && (
          <div className="account">
            <span className="account-email">{session.user.email}</span>
            <button type="button" className="row-action" onClick={() => signOut()}>
              Sign out
            </button>
          </div>
        )}
      </div>

      {page === "lineup" ? (
        <LineupOptimizer settings={settings} scoringControl={scoringControl} />
      ) : (

        <section className="player-list" aria-label="Player rankings">
          <div className="list-heading">
            <div>
              <h2>
                {isTeamTab ? "D/ST" : "All players"}
                <span className="heading-week"> · Week of {formatQueriedWeek(queriedWeek)}</span>
              </h2>
              <p>{formatWeek(projectionWeek, projectionsUpdatedAt) ?? "Weekly point projections"}</p>
            </div>
            <label className="search">
              <span>Search</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={isTeamTab ? "Team" : "Player or team"}
                aria-label={isTeamTab ? "Search by team" : "Search by player or team"}
              />
            </label>
          </div>

          {scoringControl}

          {!isTeamTab && (
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
          )}

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
                  {positionLabel(item)}
                </button>
              ))}
              <span className="player-count">
                {isTeamTab
                  ? isLoadingTeams
                    ? "Loading teams..."
                    : `${filteredTeams.length} teams`
                  : isLoadingPlayers
                    ? "Loading players..."
                    : `${filteredPlayers.length} players`}
              </span>
            </div>
          </div>

          {isTeamTab ? (
            <div className="table-scroll">
              <p className="spread-context-note">
                ❗ A larger favorite spread can lead to more predictable opponent passing situations, creating sack and turnover chances.
              </p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Team</th>
                    <th scope="col">Opponent</th>
                    <th scope="col" className="sorted-column" aria-sort="ascending">
                      Pts allowed <span className="sort-arrow" aria-hidden="true">↑</span>
                    </th>
                    <th scope="col">Total</th>
                    <th scope="col">Spread</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTeams.map((team) => (
                    <tr key={`${team.team} ${team.matchup}`}>
                      <td className="rank">{team.rank}</td>
                      <td className="name">{team.team} D/ST</td>
                      <td>{team.opponent}</td>
                      <td>{team.projectedPointsAllowed === null ? "—" : team.projectedPointsAllowed.toFixed(1)}</td>
                      <td>{team.gameTotal === null ? "—" : team.gameTotal.toFixed(1)}</td>
                      <td
                        className={topFavoriteKeys.has(`${team.team} ${team.matchup}`)
                          ? `favorite-spread favorite-spread-${topFavoriteKeys.get(`${team.team} ${team.matchup}`)}`
                          : undefined}
                        title={topFavoriteKeys.has(`${team.team} ${team.matchup}`)
                          ? "Top-five favorite by spread; the opponent may face more passing situations, creating sack and turnover chances."
                          : undefined}
                        aria-label={topFavoriteKeys.has(`${team.team} ${team.matchup}`)
                          ? `${team.team} is a top-five favorite; a likely pass-heavy opponent script may create sack and turnover chances.`
                          : undefined}
                      >
                        {team.spread === null ? "—" : `${team.spread > 0 ? "+" : ""}${team.spread.toFixed(1)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {isLoadingTeams && <p className="empty-state" role="status">Loading D/ST projections...</p>}
              {teamsError && <p className="empty-state error-state" role="alert">{teamsError}</p>}
              {!isLoadingTeams && !teamsError && filteredTeams.length === 0 && (
                <p className="empty-state">{teams.length === 0 ? "No D/ST projections this week." : "No teams match your search."}</p>
              )}
            </div>
          ) : (
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
              {playerTeamGroups.map((group) => {
                const isGroupCollapsed = collapsedTeamGroups.has(group.team);
                return (
                  <tbody key={group.team} className="team-group" id={`team-players-${group.team}`}>
                    <tr className="team-group-row">
                      <th scope="rowgroup" colSpan={8}>
                        <button
                          type="button"
                          className="team-group-toggle"
                          aria-expanded={!isGroupCollapsed}
                          aria-controls={`team-players-${group.team}`}
                          onClick={() => toggleTeamGroup(group.team)}
                        >
                          <span className="team-group-name">{group.team}</span>
                          <span className="team-group-projections">
                            {`Projected score ${group.impliedScore === null ? "—" : group.impliedScore.toFixed(1)}`}
                            {` · Total ${group.gameTotal === null ? "—" : group.gameTotal.toFixed(1)}`}
                            {` · Spread ${group.spread === null ? "—" : `${group.spread > 0 ? "+" : ""}${group.spread.toFixed(1)}`}`}
                          </span>
                          <span className="team-group-chevron" aria-hidden="true">
                            {isGroupCollapsed ? "▸" : "▾"}
                          </span>
                        </button>
                      </th>
                    </tr>
                    {!isGroupCollapsed && group.players.map((player) => {
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
                                <span className="row-chevron" aria-hidden="true">
                                  {isExpanded ? "▾" : "▸"}
                                </span>
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
                                        className={
                                          item.points < 0 ? "breakdown-points negative" : "breakdown-points"
                                        }
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
                );
              })}
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
          )}
        </section>
      )}
    </main>
  );
}

export default App;
