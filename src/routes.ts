/**
 * Hash routing. The part after "#" never reaches the server, so every URL loads index.html
 * and works on GitHub Pages (refresh, bookmarks, shared links) without server rewrites.
 *   #/rankings              Rankings, all positions
 *   #/rankings/qb … /dst    Rankings filtered to a position tab (dst = D/ST)
 *   #/lineup-optimizer      Lineup optimizer
 */
export type Page = "rankings" | "lineup";
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

type Route = { page: Page; position: PositionFilter };

/** Parse a route hash (case-insensitive). Unknown routes and positions fall back to Rankings/All. */
function parseHash(hash: string): Route {
  const lower = hash.toLowerCase();
  if (lower === pageHashes.lineup) return { page: "lineup", position: "ALL" };
  const rankings = lower.match(/^#\/rankings(?:\/([a-z]+))?\/?$/);
  if (rankings) {
    const slug = rankings[1] ?? "";
    const position = (Object.keys(positionSlugs) as PositionFilter[]).find((key) => positionSlugs[key] === slug);
    return { page: "rankings", position: position ?? "ALL" };
  }
  return { page: legacyHashes[lower] ?? "rankings", position: "ALL" };
}

function hashFor({ page, position }: Route): string {
  if (page === "lineup") return pageHashes.lineup;
  return position === "ALL" ? pageHashes.rankings : `${pageHashes.rankings}/${positionSlugs[position]}`;
}

function pageForHash(hash: string): Page {
  return parseHash(hash).page;
}

export function currentPage(): Page {
  return pageForHash(window.location.hash);
}

/** The Rankings position tab in the URL ("ALL" when none, or on another page). */
export function currentRankingsPosition(): PositionFilter {
  return parseHash(window.location.hash).position;
}

/** URL for a Rankings position tab, e.g. "#/rankings/wr". */
export function rankingsHref(position: PositionFilter): string {
  return hashFor({ page: "rankings", position });
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
  const canonical = hashFor(parseHash(hash));
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
    replaceHash(hashFor(parseHash(saved)));
  } else {
    normalizeLocation();
  }
}
