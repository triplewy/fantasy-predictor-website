/**
 * Hash routing. The part after "#" never reaches the server, so every URL loads index.html
 * and works on GitHub Pages (refresh, bookmarks, shared links) without server rewrites.
 *   #/rankings/weekly              Weekly rankings, all positions (also #/rankings)
 *   #/rankings/weekly/qb … /dst    Weekly rankings filtered to a position tab (dst = D/ST)
 *   #/rankings/season              Season rankings, all positions
 *   #/rankings/season/qb … /dst    Season rankings filtered to a position tab (dst = D/ST)
 *   #/lineup-optimizer             Lineup optimizer
 *   #/compare                      Compare players
 *   #/compare?player=<id>          Compare players, adding that player on arrival
 */
export type Page = "rankings" | "lineup" | "compare";
export type RankingType = "weekly" | "season";
export type PositionFilter = "ALL" | "QB" | "RB" | "WR" | "TE" | "FLEX" | "K" | "DST";

const positionSlugs: Record<PositionFilter, string> = {
  ALL: "",
  QB: "qb",
  RB: "rb",
  WR: "wr",
  TE: "te",
  FLEX: "flex",
  K: "k",
  DST: "dst",
};

const pageHashes: Record<Page, string> = {
  rankings: "#/rankings",
  lineup: "#/lineup-optimizer",
  compare: "#/compare",
};

// Older links, still honored.
const legacyHashes: Record<string, Page> = {
  "#/lineup": "lineup",
  "#/": "rankings",
};

const postSignInRouteKey = "fantasy-post-sign-in-route";

export function pageHref(page: Page): string {
  return pageHashes[page];
}

/** Route hashes start with "#/" (or are empty). Anything else — e.g. Supabase's
 * "#access_token=…" sign-in callback — isn't a route and must be left alone. */
function isRouteHash(hash: string) {
  return hash === "" || hash === "#" || hash.startsWith("#/");
}

type Route = { page: Page; rankingType: RankingType; position: PositionFilter };

/** The query string portion of a hash ("" when absent), e.g. "?player=123". */
function queryFor(hash: string): string {
  const index = hash.indexOf("?");
  return index === -1 ? "" : hash.slice(index);
}

/** Parse a route hash (case-insensitive). Unknown routes and positions fall back to Weekly Rankings/All. */
function parseHash(hash: string): Route {
  const lower = hash.split("?")[0].toLowerCase();
  if (lower === pageHashes.lineup) return { page: "lineup", rankingType: "weekly", position: "ALL" };
  if (lower === pageHashes.compare) return { page: "compare", rankingType: "weekly", position: "ALL" };
  const rankings = lower.match(/^#\/rankings(?:\/(weekly|season))?(?:\/([a-z]+))?\/?$/);
  if (rankings) {
    const rankingType: RankingType = rankings[1] === "season" ? "season" : "weekly";
    const slug = rankings[2] ?? "";
    const position = (Object.keys(positionSlugs) as PositionFilter[]).find((key) => positionSlugs[key] === slug);
    return { page: "rankings", rankingType, position: position ?? "ALL" };
  }
  return { page: legacyHashes[lower] ?? "rankings", rankingType: "weekly", position: "ALL" };
}

function hashFor({ page, rankingType, position }: Route): string {
  if (page === "lineup") return pageHashes.lineup;
  if (page === "compare") return pageHashes.compare;
  const base = `${pageHashes.rankings}/${rankingType}`;
  return position === "ALL" ? base : `${base}/${positionSlugs[position]}`;
}

/** Canonical hash for a route, preserving the ?player= query on #/compare. */
function canonicalHash(hash: string): string {
  const route = parseHash(hash);
  const canonical = hashFor(route);
  return route.page === "compare" ? canonical + queryFor(hash) : canonical;
}

function pageForHash(hash: string): Page {
  return parseHash(hash).page;
}

/** The `?player=<id>` query on #/compare, if any. */
export function comparePlayerParam(): string | null {
  const { hash } = window.location;
  const index = hash.indexOf("?");
  if (index === -1) return null;
  return new URLSearchParams(hash.slice(index + 1)).get("player");
}

export function currentPage(): Page {
  return pageForHash(window.location.hash);
}

/** The Rankings type in the URL ("weekly" when none, or on another page). */
export function currentRankingType(): RankingType {
  return parseHash(window.location.hash).rankingType;
}

/** The Rankings position tab in the URL ("ALL" when none, or on another page). */
export function currentRankingsPosition(): PositionFilter {
  return parseHash(window.location.hash).position;
}

/** URL for a Rankings tab, e.g. "#/rankings/weekly/wr" or "#/rankings/season". */
export function rankingsHref(position: PositionFilter, rankingType: RankingType = "weekly"): string {
  return hashFor({ page: "rankings", rankingType, position });
}

function replaceHash(hash: string) {
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
  // replaceState doesn't fire hashchange; notify the app so it re-reads the page.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/**
 * Rewrite the address bar to the canonical page hash without reloading: no hash, old
 * links and unknown routes go to their page. Sign-in callbacks are left untouched.
 */
export function normalizeLocation() {
  const { hash } = window.location;
  if (!isRouteHash(hash)) return;
  const canonical = canonicalHash(hash);
  if (hash !== canonical) replaceHash(canonical);
}

/** Before leaving for Google sign-in: remember the page to come back to. */
export function rememberRouteForSignIn() {
  try {
    sessionStorage.setItem(postSignInRouteKey, window.location.hash);
  } catch {
    // Without storage, sign-in just lands on Rankings.
  }
}

/** After sign-in completes (and Supabase has cleared its tokens from the URL). */
export function restoreRouteAfterSignIn() {
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(postSignInRouteKey);
    sessionStorage.removeItem(postSignInRouteKey);
  } catch {
    // Ignore: fall through to normalizing.
  }
  if (saved && isRouteHash(saved) && isRouteHash(window.location.hash)) {
    replaceHash(canonicalHash(saved));
  } else {
    normalizeLocation();
  }
}
