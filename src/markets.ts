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
};
