import type { PlayerStats, Position } from "./api/rankings";
import type { TeamStats } from "./api/teams";

/** Scoring settings, presets and the per-stat points breakdown shared by every page. */

export type ScoringFormat = "PPR" | "Half PPR" | "Standard" | "Custom";

/** Team defense / special teams defaults, shared by every preset. */
const defenseDefaults = {
  dstKickoffReturnTouchdown: 6,
  dstPuntReturnTouchdown: 6,
  dstInterceptionReturnTouchdown: 6,
  dstFumbleReturnTouchdown: 6,
  dstBlockedKickReturnTouchdown: 6,
  dstTwoPointReturn: 2,
  dstOnePointSafety: 1,
  dstSack: 1,
  dstBlockedKick: 2,
  dstInterception: 2,
  dstFumbleRecovery: 2,
  dstSafety: 2,
  dstPointsAllowed0: 5,
  dstPointsAllowed1To6: 4,
  dstPointsAllowed7To13: 3,
  dstPointsAllowed14To17: 1,
  dstPointsAllowed18To27: 0,
  dstPointsAllowed28To34: -1,
  dstPointsAllowed35To45: -3,
  dstPointsAllowed46Plus: -5,
  dstYardsAllowedUnder100: 5,
  dstYardsAllowed100To199: 3,
  dstYardsAllowed200To299: 2,
  dstYardsAllowed300To349: 0,
  dstYardsAllowed350To399: -1,
  dstYardsAllowed400To449: -3,
  dstYardsAllowed450To499: -5,
  dstYardsAllowed500To549: -6,
  dstYardsAllowed550Plus: -7,
} as const;

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
    fieldGoal60Plus: 6,
    ...defenseDefaults,
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
    fieldGoal60Plus: 6,
    ...defenseDefaults,
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
    fieldGoal60Plus: 6,
    ...defenseDefaults,
  },
} as const;

export type ScoringSettingKey = keyof typeof scoringPresets.PPR;
export type ScoringSettings = Record<ScoringSettingKey, number>;

export type ScoringSection = "passing" | "rushing" | "receiving" | "turnovers" | "kicking" | "defense";

/** Settings menu sub-sections, in order; offense sections start open, kicking and D/ST collapsed. */
export const scoringSections: { section: ScoringSection; title: string; defaultOpen: boolean }[] = [
  { section: "passing", title: "Passing", defaultOpen: true },
  { section: "rushing", title: "Rushing", defaultOpen: true },
  { section: "receiving", title: "Receiving", defaultOpen: true },
  { section: "turnovers", title: "Turnovers", defaultOpen: true },
  { section: "kicking", title: "Kicking (K)", defaultOpen: false },
  { section: "defense", title: "Defense (D/ST)", defaultOpen: false },
];

export const scoringSettingFields: {
  key: ScoringSettingKey;
  label: string;
  unit: string;
  step?: number;
  section: ScoringSection;
}[] = [
  { key: "passingYards", label: "Passing yards", unit: "pts", section: "passing" },
  { key: "passingYardsPer", label: "Passing yards per", unit: "yds", step: 1, section: "passing" },
  { key: "passingTouchdown", label: "Passing touchdown", unit: "pts", section: "passing" },
  { key: "interception", label: "Interception", unit: "pts", section: "turnovers" },
  { key: "rushingYards", label: "Rushing yards", unit: "pts", section: "rushing" },
  { key: "rushingYardsPer", label: "Rushing yards per", unit: "yds", step: 1, section: "rushing" },
  { key: "rushingTouchdown", label: "Rushing touchdown", unit: "pts", section: "rushing" },
  { key: "reception", label: "Reception", unit: "pts", section: "receiving" },
  { key: "tightEndReceptionBonus", label: "TE reception bonus", unit: "pts", section: "receiving" },
  { key: "receivingYards", label: "Receiving yards", unit: "pts", section: "receiving" },
  { key: "receivingYardsPer", label: "Receiving yards per", unit: "yds", step: 1, section: "receiving" },
  { key: "receivingTouchdown", label: "Receiving touchdown", unit: "pts", section: "receiving" },
  { key: "fumbleLost", label: "Fumble lost", unit: "pts", section: "turnovers" },
  { key: "fieldGoalUnder40", label: "Field goal under 40 yds", unit: "pts", section: "kicking" },
  { key: "fieldGoal40To49", label: "Field goal 40–49 yds", unit: "pts", section: "kicking" },
  // Key kept from when this was the 50+ tier, so saved custom values still apply.
  { key: "fieldGoal50Plus", label: "Field goal 50–59 yds", unit: "pts", section: "kicking" },
  { key: "fieldGoal60Plus", label: "Field goal 60+ yds", unit: "pts", section: "kicking" },
  { key: "dstKickoffReturnTouchdown", label: "Kickoff return TD", unit: "pts", section: "defense" },
  { key: "dstPuntReturnTouchdown", label: "Punt return TD", unit: "pts", section: "defense" },
  { key: "dstInterceptionReturnTouchdown", label: "Interception return TD", unit: "pts", section: "defense" },
  { key: "dstFumbleReturnTouchdown", label: "Fumble return TD", unit: "pts", section: "defense" },
  { key: "dstBlockedKickReturnTouchdown", label: "Blocked punt or FG return TD", unit: "pts", section: "defense" },
  { key: "dstTwoPointReturn", label: "2pt return", unit: "pts", section: "defense" },
  { key: "dstOnePointSafety", label: "1pt safety", unit: "pts", section: "defense" },
  { key: "dstSack", label: "Each sack", unit: "pts", section: "defense" },
  { key: "dstBlockedKick", label: "Blocked punt, PAT or FG", unit: "pts", section: "defense" },
  { key: "dstInterception", label: "Each interception", unit: "pts", section: "defense" },
  { key: "dstFumbleRecovery", label: "Each fumble recovered", unit: "pts", section: "defense" },
  { key: "dstSafety", label: "Each safety", unit: "pts", section: "defense" },
  { key: "dstPointsAllowed0", label: "0 pts allowed", unit: "pts", section: "defense" },
  { key: "dstPointsAllowed1To6", label: "1–6 pts allowed", unit: "pts", section: "defense" },
  { key: "dstPointsAllowed7To13", label: "7–13 pts allowed", unit: "pts", section: "defense" },
  { key: "dstPointsAllowed14To17", label: "14–17 pts allowed", unit: "pts", section: "defense" },
  { key: "dstPointsAllowed18To27", label: "18–27 pts allowed", unit: "pts", section: "defense" },
  { key: "dstPointsAllowed28To34", label: "28–34 pts allowed", unit: "pts", section: "defense" },
  { key: "dstPointsAllowed35To45", label: "35–45 pts allowed", unit: "pts", section: "defense" },
  { key: "dstPointsAllowed46Plus", label: "46+ pts allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowedUnder100", label: "Under 100 yds allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowed100To199", label: "100–199 yds allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowed200To299", label: "200–299 yds allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowed300To349", label: "300–349 yds allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowed350To399", label: "350–399 yds allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowed400To449", label: "400–449 yds allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowed450To499", label: "450–499 yds allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowed500To549", label: "500–549 yds allowed", unit: "pts", section: "defense" },
  { key: "dstYardsAllowed550Plus", label: "550+ yds allowed", unit: "pts", section: "defense" },
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

/** Points-allowed tiers: [highest points allowed in the tier, setting]. */
const pointsAllowedTiers: [number, ScoringSettingKey][] = [
  [0, "dstPointsAllowed0"],
  [6, "dstPointsAllowed1To6"],
  [13, "dstPointsAllowed7To13"],
  [17, "dstPointsAllowed14To17"],
  [27, "dstPointsAllowed18To27"],
  [34, "dstPointsAllowed28To34"],
  [45, "dstPointsAllowed35To45"],
  [Infinity, "dstPointsAllowed46Plus"],
];

/**
 * Fantasy points for the tier an expected points-allowed value falls in. Scores are whole
 * numbers, so the mean is rounded first (17.4 → 17 → 14–17 tier). Tiering a mean is an
 * approximation: it ignores the chance the actual score lands in a neighboring tier.
 */
export function pointsAllowedPoints(pointsAllowed: number, settings: ScoringSettings): number {
  const score = Math.max(0, Math.round(pointsAllowed));
  return settings[pointsAllowedTiers.find(([max]) => score <= max)![1]];
}

/** Yards-allowed tiers: [highest yards allowed in the tier, setting]. */
const yardsAllowedTiers: [number, ScoringSettingKey][] = [
  [99, "dstYardsAllowedUnder100"],
  [199, "dstYardsAllowed100To199"],
  [299, "dstYardsAllowed200To299"],
  [349, "dstYardsAllowed300To349"],
  [399, "dstYardsAllowed350To399"],
  [449, "dstYardsAllowed400To449"],
  [499, "dstYardsAllowed450To499"],
  [549, "dstYardsAllowed500To549"],
  [Infinity, "dstYardsAllowed550Plus"],
];

/** Fantasy points for the tier the expected yards allowed (rounded) falls in; an approximation, like points allowed. */
export function yardsAllowedPoints(yardsAllowed: number, settings: ScoringSettings): number {
  const yards = Math.round(yardsAllowed);
  return settings[yardsAllowedTiers.find(([max]) => yards <= max)![1]];
}

/** The projection is total D/ST TDs of any kind, so each is scored at the average return-TD value. */
const touchdownSettings: ScoringSettingKey[] = [
  "dstKickoffReturnTouchdown",
  "dstPuntReturnTouchdown",
  "dstInterceptionReturnTouchdown",
  "dstFumbleReturnTouchdown",
  "dstBlockedKickReturnTouchdown",
];

function defenseTouchdownPoints(settings: ScoringSettings): number {
  return touchdownSettings.reduce((total, key) => total + settings[key], 0) / touchdownSettings.length;
}

export type TeamBreakdownItem = {
  key: "pointsAllowed" | "yardsAllowed" | "sacks" | "interceptions" | "touchdowns";
  label: string;
  points: number;
};

/** Only touchdowns, points and yards allowed, sacks and interceptions are projected; the other D/ST settings don't affect points yet. */
export function getTeamPointsBreakdown(stats: TeamStats, settings: ScoringSettings): TeamBreakdownItem[] {
  const items: TeamBreakdownItem[] = [];
  if (stats.pointsAllowed !== null) {
    items.push({
      key: "pointsAllowed",
      label: `${formatStat(stats.pointsAllowed)} pts allowed`,
      points: pointsAllowedPoints(stats.pointsAllowed, settings),
    });
  }
  if (stats.yardsAllowed !== null) {
    items.push({
      key: "yardsAllowed",
      label: `${Math.round(stats.yardsAllowed)} yds allowed`,
      points: yardsAllowedPoints(stats.yardsAllowed, settings),
    });
  }
  if (stats.sacks !== null && stats.sacks !== 0) {
    items.push({
      key: "sacks",
      label: `${formatStat(stats.sacks)} sacks`,
      points: stats.sacks * settings.dstSack,
    });
  }
  if (stats.interceptions !== null && stats.interceptions !== 0) {
    items.push({
      key: "interceptions",
      label: `${formatStat(stats.interceptions)} INT`,
      points: stats.interceptions * settings.dstInterception,
    });
  }
  if (stats.touchdowns !== null && stats.touchdowns !== 0) {
    items.push({
      key: "touchdowns",
      label: `${formatStat(stats.touchdowns)} TD`,
      points: stats.touchdowns * defenseTouchdownPoints(settings),
    });
  }
  return items;
}
