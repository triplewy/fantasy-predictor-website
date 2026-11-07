import type { PlayerStats, Position } from "./api/rankings";

/** Scoring settings, presets and the per-stat points breakdown shared by every page. */

export type ScoringFormat = "PPR" | "Half PPR" | "Standard" | "Custom";

export const scoringPresets = {
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

export type ScoringSettingKey = keyof typeof scoringPresets.PPR;
export type ScoringSettings = Record<ScoringSettingKey, number>;

export const scoringSettingFields: {
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

export type BreakdownItem = { key: keyof PlayerStats; label: string; points: number };

export function formatStat(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}


export function yardagePoints(yards: number, points: number, per: number) {
  return per > 0 ? (yards / per) * points : 0;
}

export function getPointsBreakdown(
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
