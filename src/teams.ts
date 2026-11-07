/**
 * NFL team codes as used by /players and project-players. Games may name teams in full
 * (e.g. The Odds API: "Minnesota Vikings") or with alternate codes, so everything is
 * normalized to these before matching players to games.
 */
const fullNames: Record<string, string> = {
  "arizona cardinals": "ARI",
  "atlanta falcons": "ATL",
  "baltimore ravens": "BAL",
  "buffalo bills": "BUF",
  "carolina panthers": "CAR",
  "chicago bears": "CHI",
  "cincinnati bengals": "CIN",
  "cleveland browns": "CLE",
  "dallas cowboys": "DAL",
  "denver broncos": "DEN",
  "detroit lions": "DET",
  "green bay packers": "GB",
  "houston texans": "HOU",
  "indianapolis colts": "IND",
  "jacksonville jaguars": "JAX",
  "kansas city chiefs": "KC",
  "las vegas raiders": "LV",
  "los angeles chargers": "LAC",
  "los angeles rams": "LAR",
  "miami dolphins": "MIA",
  "minnesota vikings": "MIN",
  "new england patriots": "NE",
  "new orleans saints": "NO",
  "new york giants": "NYG",
  "new york jets": "NYJ",
  "philadelphia eagles": "PHI",
  "pittsburgh steelers": "PIT",
  "san francisco 49ers": "SF",
  "seattle seahawks": "SEA",
  "tampa bay buccaneers": "TB",
  "tennessee titans": "TEN",
  "washington commanders": "WAS",
};

// Alternate abbreviations some sources use.
const aliases: Record<string, string> = {
  JAC: "JAX",
  LA: "LAR",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
  WSH: "WAS",
  GNB: "GB",
  KAN: "KC",
  NWE: "NE",
  NOR: "NO",
  SFO: "SF",
  TAM: "TB",
  LVR: "LV",
};

/** Normalize a team name or code to the canonical code ("Minnesota Vikings" → "MIN"). */
export function teamCode(value: string): string {
  const trimmed = value.trim();
  const fromName = fullNames[trimmed.toLowerCase()];
  if (fromName) return fromName;
  const upper = trimmed.toUpperCase();
  return aliases[upper] ?? upper;
}
