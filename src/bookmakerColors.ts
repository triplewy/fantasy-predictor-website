/**
 * One fixed color per bookmaker, keyed by name, so a book keeps its color on every chart,
 * player, tooltip and table. Slot order is the validated categorical palette order
 * (adjacent pairs pass colorblind-separation checks) — don't reorder without re-validating.
 * Bookmakers not listed here share a neutral gray rather than getting a generated hue.
 */
const bookmakerColorMap: Record<string, string> = {
  DraftKings: "#2a78d6",
  FanDuel: "#eb6834",
  BetMGM: "#1baf7a",
  Caesars: "#eda100",
  Fanatics: "#e87ba4",
  BetRivers: "#008300",
  "BetOnline.ag": "#6250d6",
  Bovada: "#e34948",
};

export const otherBookmakerColor = "#898781";

export function bookmakerColor(bookmaker: string): string {
  return bookmakerColorMap[bookmaker] ?? otherBookmakerColor;
}

/** Known books in palette order, then any others alphabetically. */
export function sortBookmakers(bookmakers: Iterable<string>): string[] {
  const order = Object.keys(bookmakerColorMap);
  return [...new Set(bookmakers)].sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    return a.localeCompare(b);
  });
}
