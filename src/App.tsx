import { useEffect, useMemo, useState } from "react";
import { signOut, useSession } from "./AuthGate";
import { ComparePlayers } from "./ComparePlayers";
import { LineupOptimizer } from "./LineupOptimizer";
import { currentNflWeek, getWeeksRemaining } from "./nflWeek";
import {
  currentPage,
  currentRankingsPosition,
  currentRankingType,
  pageHref,
  rankingsHref,
  type Page,
  type PositionFilter,
  type RankingType,
} from "./routes";
import { readStorageJson, removeStorageItem, writeStorageJson } from "./storage";
import {
  formatStat,
  getPointsBreakdown,
  scoringPresets,
  scoringSections,
  scoringSettingFields,
  type BreakdownItem,
  type ScoringFormat,
  type ScoringSettingKey,
  type ScoringSettings,
} from "./scoring";
import {
  getPlayerProjections,
  getSeasonProjections,
  getSeasonStatsBreakdown,
  type Player,
  type Position,
  type ProjectionWeek,
  type SeasonBreakdownItem,
  type SeasonPlayer,
  calculatePerWeekProjectedTotal,
  calculateSeasonProjectedTotal,
  calculateSeasonStatsTotal,
} from "./api/rankings";
import { getTeamProjections, type TeamProjection } from "./api/teams";

const positions: PositionFilter[] = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "DST"];

function positionLabel(item: PositionFilter) {
  return item === "ALL" ? "All" : item === "DST" ? "D/ST" : item;
}
const excludedPositions: ("ALL" | Position)[] = ["ALL", "QB", "RB", "WR", "TE", "K"];

type RankedPlayer = (Player | SeasonPlayer) & {
  rank: number;
  points: number;
  breakdown: BreakdownItem[];
  seasonStatsBreakdown?: SeasonBreakdownItem[];
  seasonStatsTotal?: number;
  seasonProjectedTotal?: number;
  perWeekProjectedTotal?: number;
};
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
  return `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(2)}`;
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
  { page: "rankings", title: "Rankings" },
  { page: "lineup", title: "Lineup optimizer" },
  { page: "compare", title: "Compare players" },
];

function App() {
  // The Rankings type and position tab live in the URL (#/rankings/weekly/wr); see routes.ts.
  const [rankingType, setRankingTypeState] = useState<RankingType>(currentRankingType);
  const [position, setPositionState] = useState<PositionFilter>(currentRankingsPosition);
  const setPosition = (next: PositionFilter) => {
    window.location.hash = rankingsHref(next, rankingType);
  };
  const setRankingType = (next: RankingType) => {
    window.location.hash = rankingsHref(position, next);
  };
  const [search, setSearch] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [seasonPlayers, setSeasonPlayers] = useState<SeasonPlayer[]>([]);
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
  const [page, setPage] = useState<Page>(currentPage);
  const session = useSession();
  // The week both projection requests ask for (from/to); shown in the heading.
  const [queriedWeek] = useState(currentNflWeek);
  const weeksRemaining = useMemo(() => getWeeksRemaining(new Date(), "season-2026"), []);

  // Hash routing (see routes.ts): follow tab clicks, back/forward and redirects.
  useEffect(() => {
    const onHashChange = () => {
      setPage(currentPage());
      // Leaving Rankings keeps the last tabs, so returning to Rankings restores them.
      if (currentPage() === "rankings") {
        setRankingTypeState(currentRankingType());
        setPositionState(currentRankingsPosition());
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Projections power the Rankings page, the Lineup optimizer and the Compare page, so
  // they're fetched the first time any of those pages is shown.
  const [hasRequestedProjections, setHasRequestedProjections] = useState(false);
  useEffect(() => {
    if (page === "rankings" || page === "compare") setHasRequestedProjections(true);
  }, [page]);

  // Load weekly projections once; season projections are fetched separately when the
  // Season tab is selected so switching tabs doesn't refetch the weekly data.
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
  }, [hasRequestedProjections, queriedWeek]);

  const [hasRequestedSeason, setHasRequestedSeason] = useState(false);
  const [isLoadingSeason, setIsLoadingSeason] = useState(false);
  const [seasonError, setSeasonError] = useState<string | null>(null);
  const [seasonUpdatedAt, setSeasonUpdatedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (page === "rankings" && rankingType === "season") setHasRequestedSeason(true);
  }, [page, rankingType]);

  useEffect(() => {
    if (!hasRequestedSeason) return;
    const controller = new AbortController();
    setIsLoadingSeason(true);
    setSeasonError(null);

    getSeasonProjections("season-2026", controller.signal)
      .then(({ players: loadedPlayers, updatedAt }) => {
        setSeasonPlayers(loadedPlayers);
        setSeasonUpdatedAt(updatedAt);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSeasonError(
          error instanceof Error ? error.message : "Could not load season projections.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingSeason(false);
      });

    return () => controller.abort();
  }, [hasRequestedSeason]);

  // Team game projections provide implied team scores for all weekly player groups.
  const isTeamTab = page === "rankings" && position === "DST";
  const [teams, setTeams] = useState<TeamProjection[]>([]);
  const [hasRequestedTeams, setHasRequestedTeams] = useState(false);
  const [isLoadingTeams, setIsLoadingTeams] = useState(true);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  useEffect(() => {
    if (page === "rankings" || page === "compare") setHasRequestedTeams(true);
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

  function excludePlayer({ id, name, position, team }: Player | SeasonPlayer) {
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
      (rankingType === "season" ? seasonPlayers : players)
        .filter((player) => !excludedSet.has(player.id))
        .map((player) => {
          if ("totalSeasonStats" in player) {
            // For Season Projections, show total season projections breakdown
            const breakdown = getPointsBreakdown(player.totalSeasonStats, player.position, settings);
            const seasonStatsBreakdown = getSeasonStatsBreakdown(player, settings);
            const seasonStatsTotal = seasonStatsBreakdown.reduce((sum, item) => sum + item.points, 0);
            const seasonProjectedTotal = breakdown.reduce((sum, item) => sum + item.points, 0);
            // RoS projected total points is used for ranking and the RoS Projected Total column
            const rosBreakdown = getPointsBreakdown(player.stats, player.position, settings);
            const points = rosBreakdown.reduce((total, item) => total + item.points, 0);
            const perWeekProjectedTotal = weeksRemaining > 0 ? points / weeksRemaining : 0;

            return {
              ...player,
              breakdown,
              points,
              seasonStatsBreakdown,
              seasonStatsTotal,
              seasonProjectedTotal,
              perWeekProjectedTotal,
            };
          }

          const breakdown = getPointsBreakdown(player.stats, player.position, settings);
          const points = breakdown.reduce((total, item) => total + item.points, 0);
          return { ...player, breakdown, points };
        })
        .sort((a, b) => b.points - a.points),
    [players, seasonPlayers, rankingType, settings, excludedSet, weeksRemaining],
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
        `${player.name} ${player.team} ${"opponent" in player ? player.opponent : ""}`.toLowerCase().includes(query),
      );
  }, [scoredPlayers, position, search]);

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
              // Rankings links back to the last ranking type and position tab viewed.
              href={tab.page === "rankings" ? rankingsHref(position, rankingType) : pageHref(tab.page)}
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
      ) : page === "compare" ? (
        <ComparePlayers
          players={players}
          teams={teams}
          settings={settings}
          scoringControl={scoringControl}
          isLoading={isLoadingPlayers}
          error={playersError}
          teamsLoading={isLoadingTeams}
          teamsError={teamsError}
        />
      ) : (

        <section className="player-list" aria-label="Player rankings">
          <div className="list-heading">
            <div>
              <h2>
                {isTeamTab ? "D/ST" : "All players"}
                <span className="heading-week">
                  {rankingType === "season" ? " · 2026 Rest of Season" : ` · Week of ${formatQueriedWeek(queriedWeek)}`}
                </span>
              </h2>
              <p>
                {rankingType === "season"
                  ? (seasonUpdatedAt
                      ? `Updated ${formatUpdatedAt(seasonUpdatedAt)} · ${weeksRemaining} weeks remaining`
                      : `Rest-of-season point projections · ${weeksRemaining} weeks remaining`)
                  : (formatWeek(projectionWeek, projectionsUpdatedAt) ?? "Weekly point projections")}
              </p>
            </div>
            <div className="ranking-type-selector" role="group" aria-label="Ranking type">
              <button
                type="button"
                className={`filter${rankingType === "weekly" ? " active" : ""}`}
                aria-pressed={rankingType === "weekly"}
                onClick={() => setRankingType("weekly")}
              >
                Weekly
              </button>
              <button
                type="button"
                className={`filter${rankingType === "season" ? " active" : ""}`}
                aria-pressed={rankingType === "season"}
                onClick={() => setRankingType("season")}
              >
                Season
              </button>
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
                  : rankingType === "season"
                    ? isLoadingSeason
                      ? "Loading players..."
                      : `${filteredPlayers.length} players`
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
                  {rankingType === "season" && <th scope="col" className="points-heading">Season Proj. Total</th>}
                  {rankingType === "season" && <th scope="col" className="points-heading">Season Stats Total</th>}
                  {rankingType !== "season" && <th scope="col">Opponent</th>}
                  <th scope="col" className="points-heading">
                    {rankingType === "season" ? "RoS Proj. Total" : "Proj. points"}
                  </th>
                  {rankingType === "season" && <th scope="col" className="points-heading col-highlight">Per-Week Proj. Total</th>}
                  <th scope="col" className="breakdown-heading">{rankingType === "season" ? "Season Projections" : "Breakdown"}</th>
                  {rankingType === "season" && <th scope="col" className="breakdown-heading">Season Stats</th>}
                  <th scope="col" className="action-heading"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {filteredPlayers.map((player) => (
                  <tr key={player.id} className="player-row">
                  <td className="rank">{player.rank}</td>
                  <td className="name">{player.name}</td>
                  <td>{player.position}</td>
                  <td>{player.team}</td>
                  {rankingType === "season" && "seasonToDateStats" in player && (
                    <td className="points">{(player.seasonProjectedTotal ?? calculateSeasonProjectedTotal(player, settings)).toFixed(2)}</td>
                  )}
                  {rankingType === "season" && "seasonToDateStats" in player && (
                    <td className="points">{(player.seasonStatsTotal ?? calculateSeasonStatsTotal(player, settings)).toFixed(2)}</td>
                  )}
                  {rankingType !== "season" && <td>{"opponent" in player ? player.opponent : ""}</td>}
                  <td className="points">{player.points.toFixed(2)}</td>
                  {rankingType === "season" && "seasonToDateStats" in player && (
                    <td className="points col-highlight">
                      {(player.perWeekProjectedTotal ?? calculatePerWeekProjectedTotal(player, settings, weeksRemaining)).toFixed(2)}
                    </td>
                  )}
                  <td className="breakdown">
                    {player.breakdown.length === 0 ? (
                      <span className="breakdown-empty">No projected stats</span>
                    ) : (
                      <ul className={`breakdown-list${rankingType === "season" ? " season-breakdown-list" : ""}`}>
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
                  {rankingType === "season" && (
                    <td className="breakdown">
                      {"seasonStatsBreakdown" in player && player.seasonStatsBreakdown && player.seasonStatsBreakdown.length > 0 ? (
                        <ul className="breakdown-list season-breakdown-list">
                          {player.seasonStatsBreakdown.map((stat) => (
                            <li key={stat.market}>
                              <span>{formatStat(stat.value)} {stat.label}</span>
                              <span
                                className={
                                  stat.points < 0 ? "breakdown-points negative" : "breakdown-points"
                                }
                              >
                                {formatPoints(stat.points)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="breakdown-empty">No season-to-date stats</span>
                      )}
                    </td>
                  )}
                  <td className="action">
                    <button
                      type="button"
                      className="row-action"
                      aria-label={`compare ${player.name}`}
                      onClick={() => {
                        window.location.hash = `#/compare?player=${player.id}`;
                      }}
                    >
                      Compare
                    </button>
                    <button
                      type="button"
                      className="row-action"
                      aria-label={`exclude ${player.name}`}
                      onClick={() => excludePlayer(player)}
                    >
                      Exclude
                    </button>
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
            {rankingType === "season" ? (
              <>
                {isLoadingSeason && (
                  <p className="empty-state" role="status">Loading season projections...</p>
                )}
                {seasonError && (
                  <p className="empty-state error-state" role="alert">{seasonError}</p>
                )}
                {!isLoadingSeason && !seasonError && filteredPlayers.length === 0 && (
                  <p className="empty-state">No players match your search.</p>
                )}
              </>
            ) : (
              <>
                {isLoadingPlayers && (
                  <p className="empty-state" role="status">Loading player projections...</p>
                )}
                {playersError && (
                  <p className="empty-state error-state" role="alert">{playersError}</p>
                )}
                {!isLoadingPlayers && !playersError && filteredPlayers.length === 0 && (
                  <p className="empty-state">No players match your search.</p>
                )}
              </>
            )}
          </div>
          )}
        </section>
      )}
    </main>
  );
}

export default App;
