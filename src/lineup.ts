import type { Player, Position } from "./api/rankings";

export type SlotType = "QB" | "RB" | "WR" | "TE" | "FLEX" | "SUPERFLEX" | "K";

/** Number of starters per slot type. Everyone else on the roster is on the bench. */
export type LineupFormat = Record<SlotType, number>;

export const slotTypes: SlotType[] = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K"];

export const slotEligibility: Record<SlotType, Position[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  FLEX: ["RB", "WR", "TE"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
  K: ["K"],
};

export const slotLabels: Record<SlotType, string> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  FLEX: "FLEX (RB/WR/TE)",
  SUPERFLEX: "SUPERFLEX (QB/RB/WR/TE)",
  K: "K",
};

export const lineupPresets: { name: string; format: LineupFormat }[] = [
  { name: "Standard", format: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 1 } },
  { name: "3 WR", format: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 1 } },
  { name: "Superflex", format: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 1, K: 1 } },
  { name: "2 QB", format: { QB: 2, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 1 } },
  { name: "No kicker", format: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 0 } },
];

/** A rostered player with this week's projected points (0 when there's no projection). */
export type RosterPlayer = Pick<Player, "id" | "name" | "position" | "team"> & {
  points: number;
  /** How the points add up, e.g. { label: "275 pass yds", points: 11 }. Empty without a projection. */
  breakdown: { label: string; points: number }[];
  opponent: string | null;
  hasProjection: boolean;
};

export type LineupSlot = { slot: SlotType; player: RosterPlayer | null };

/**
 * Highest-projected lineup for the format. Slots are filled from most to least
 * restrictive (single positions, then FLEX, then SUPERFLEX), each with the best remaining
 * eligible player. Because every slot's eligible positions contain those of the slots
 * filled before it, this greedy order is optimal: a player is only ever "spent" on a
 * narrower slot when nobody better could have filled it.
 */
export function optimizeLineup(
  roster: RosterPlayer[],
  format: LineupFormat,
): { starters: LineupSlot[]; bench: RosterPlayer[]; total: number } {
  const available = [...roster].sort((a, b) => b.points - a.points);
  const filled = new Map<SlotType, LineupSlot[]>();
  const fillOrder: SlotType[] = ["QB", "RB", "WR", "TE", "K", "FLEX", "SUPERFLEX"];

  for (const slot of fillOrder) {
    const slots: LineupSlot[] = [];
    for (let i = 0; i < format[slot]; i++) {
      const index = available.findIndex((player) => slotEligibility[slot].includes(player.position));
      slots.push({ slot, player: index === -1 ? null : available.splice(index, 1)[0] });
    }
    filled.set(slot, slots);
  }

  // Display in the usual lineup order, regardless of fill order.
  const starters = slotTypes.flatMap((slot) => filled.get(slot) ?? []);
  const total = starters.reduce((sum, { player }) => sum + (player?.points ?? 0), 0);
  return { starters, bench: available, total };
}
