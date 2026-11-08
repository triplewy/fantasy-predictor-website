import type { PlayerStats } from "./api/rankings";

export type StatKey = keyof PlayerStats;

/** Which projected stat each bookmaker market feeds into. Unknown markets are shown under "Other". */
export const marketInfo: Record<string, { stat: StatKey; label: string }> = {
  player_pass_yds_alternate: { stat: "passingYards", label: "Passing yards" },
  player_pass_tds_alternate: { stat: "passingTouchdowns", label: "Passing TDs" },
  player_pass_interceptions_alternate: { stat: "interceptions", label: "Interceptions" },
  player_rush_yds_alternate: { stat: "rushingYards", label: "Rushing yards" },
  player_receptions_alternate: { stat: "receptions", label: "Receptions" },
  player_reception_yds_alternate: { stat: "receivingYards", label: "Receiving yards" },
  player_anytime_td: { stat: "touchdowns", label: "Anytime TD" },
  player_tds_over: { stat: "touchdowns", label: "Total TDs (over 0.5 = anytime TD)" },
  player_kicking_points_alternate: { stat: "kickingPoints", label: "Kicking points" },
  // Main (single over/under) lines, combined with the alternates into each stat's curve.
  player_pass_yds: { stat: "passingYards", label: "Passing yards · main O/U line" },
  player_pass_tds: { stat: "passingTouchdowns", label: "Passing TDs · main O/U line" },
  player_pass_interceptions: { stat: "interceptions", label: "Interceptions · main O/U line" },
  player_rush_yds: { stat: "rushingYards", label: "Rushing yards · main O/U line" },
  player_receptions: { stat: "receptions", label: "Receptions · main O/U line" },
  player_reception_yds: { stat: "receivingYards", label: "Receiving yards · main O/U line" },
  player_kicking_points: { stat: "kickingPoints", label: "Kicking points · main O/U line" },
};

/**
 * Base market for each non-touchdown stat (backend STAT_MARKETS): the stat's curve is
 * `${base}_alternate` lines plus the `${base}` main O/U line.
 */
export const statBaseMarkets: Record<Exclude<StatKey, "touchdowns">, string> = {
  passingYards: "player_pass_yds",
  passingTouchdowns: "player_pass_tds",
  interceptions: "player_pass_interceptions",
  rushingYards: "player_rush_yds",
  receivingYards: "player_reception_yds",
  receptions: "player_receptions",
  kickingPoints: "player_kicking_points",
};
