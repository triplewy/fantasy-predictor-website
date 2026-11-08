/**
 * Hash routing: #/rankings and #/lineup-optimizer. The part after "#" never reaches the
 * server, so every URL loads index.html and works on GitHub Pages (refresh, bookmarks,
 * shared links) without server rewrites.
 */
export type Page = "rankings" | "lineup";

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

function pageForHash(hash: string): Page {
  if (hash === pageHashes.lineup) return "lineup";
  return legacyHashes[hash] ?? "rankings";
}

export function currentPage(): Page {
  return pageForHash(window.location.hash);
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
  const canonical = pageHashes[pageForHash(hash)];
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
    replaceHash(pageHashes[pageForHash(saved)]);
  } else {
    normalizeLocation();
  }
}
