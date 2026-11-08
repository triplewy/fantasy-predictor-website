import type { Player, PlayerStats, Position } from "./api/rankings";

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
  breakdown: { key: keyof PlayerStats; label: string; points: number }[];
  /** Projected stats, when available (for the bookmaker-lines panel). */
  stats: PlayerStats | null;
  /** This week's game, when the player has one (needed to load their lines). */
  gameId: string | null;
  opponent: string | null;
  hasProjection: boolean;
  /** Why there's no projection yet, e.g. "Loading lines…" or "Bye week". */
  note: string | null;
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

/**
 * The user's own lineup: who starts in each slot (in display order) and who's on the
 * bench, saved separately so start/sit choices persist. Players are referenced by ID.
 */
export type SavedLineup = {
  starters: { slot: SlotType; playerId: string | null }[];
  bench: string[];
};

/** Every starting slot for the format, in display order (e.g. QB, RB, RB, WR, …). */
export function slotList(format: LineupFormat): SlotType[] {
  return slotTypes.flatMap((slot) => Array.from({ length: format[slot] }, () => slot));
}

/**
 * Fit a saved lineup to the current format and roster: starters keep their slots where
 * the slot type still exists (in order), removed players disappear, starters without a
 * slot (or no longer eligible) move to the bench, and roster players not placed anywhere
 * (newly added) are appended to the bench.
 */
export function reconcileLineup(
  saved: SavedLineup,
  format: LineupFormat,
  roster: { id: string; position: Position }[],
): SavedLineup {
  const positions = new Map(roster.map((player) => [player.id, player.position]));
  const used = new Set<string>();
  const overflow: string[] = [];

  const savedBySlot = new Map<SlotType, string[]>();
  for (const { slot, playerId } of saved.starters) {
    if (!playerId || !positions.has(playerId) || used.has(playerId)) continue;
    if (!slotEligibility[slot]?.includes(positions.get(playerId)!)) {
      overflow.push(playerId);
      used.add(playerId);
      continue;
    }
    savedBySlot.set(slot, [...(savedBySlot.get(slot) ?? []), playerId]);
    used.add(playerId);
  }

  const starters = slotTypes.flatMap((slot) => {
    const queue = savedBySlot.get(slot) ?? [];
    const filled = Array.from({ length: format[slot] }, (_, index) => ({ slot, playerId: queue[index] ?? null }));
    overflow.push(...queue.slice(format[slot]));
    return filled;
  });

  const startingIds = new Set(starters.flatMap((entry) => (entry.playerId ? [entry.playerId] : [])));
  const bench: string[] = [];
  for (const id of [...saved.bench, ...overflow, ...roster.map((player) => player.id)]) {
    if (positions.has(id) && !startingIds.has(id) && !bench.includes(id)) bench.push(id);
  }
  return { starters, bench };
}

/** The optimizer's result as a saved lineup. */
export function lineupFromOptimal(optimal: { starters: LineupSlot[]; bench: RosterPlayer[] }): SavedLineup {
  return {
    starters: optimal.starters.map(({ slot, player }) => ({ slot, playerId: player?.id ?? null })),
    bench: optimal.bench.map((player) => player.id),
  };
}

/** Start a bench player in a slot; whoever was there takes the player's place on the bench. */
export function startPlayer(lineup: SavedLineup, playerId: string, slotIndex: number): SavedLineup {
  const occupant = lineup.starters[slotIndex]?.playerId ?? null;
  const starters = lineup.starters.map((entry, index) => (index === slotIndex ? { ...entry, playerId } : entry));
  const bench = lineup.bench.flatMap((id) => (id === playerId ? (occupant ? [occupant] : []) : [id]));
  return { starters, bench };
}

/** Move a starter to the top of the bench, leaving the slot empty. */
export function sitPlayer(lineup: SavedLineup, slotIndex: number): SavedLineup {
  const occupant = lineup.starters[slotIndex]?.playerId;
  if (!occupant) return lineup;
  return {
    starters: lineup.starters.map((entry, index) => (index === slotIndex ? { ...entry, playerId: null } : entry)),
    bench: [occupant, ...lineup.bench],
  };
}

/** Put a newly added player in the first empty slot they fit (most specific first), else the bench. */
export function placeNewPlayer(lineup: SavedLineup, playerId: string, position: Position): SavedLineup {
  const fillOrder: SlotType[] = ["QB", "RB", "WR", "TE", "K", "FLEX", "SUPERFLEX"];
  for (const slot of fillOrder) {
    if (!slotEligibility[slot].includes(position)) continue;
    const index = lineup.starters.findIndex((entry) => entry.slot === slot && entry.playerId === null);
    if (index !== -1) {
      return {
        starters: lineup.starters.map((entry, i) => (i === index ? { ...entry, playerId } : entry)),
        bench: lineup.bench.filter((id) => id !== playerId),
      };
    }
  }
  return { ...lineup, bench: [...lineup.bench.filter((id) => id !== playerId), playerId] };
}

export function isSavedLineup(value: unknown): value is SavedLineup {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    Array.isArray(entry.starters) &&
    entry.starters.every(
      (starter) =>
        typeof starter === "object" &&
        starter !== null &&
        slotTypes.includes((starter as { slot: SlotType }).slot) &&
        ((starter as { playerId: unknown }).playerId === null ||
          typeof (starter as { playerId: unknown }).playerId === "string"),
    ) &&
    Array.isArray(entry.bench) &&
    entry.bench.every((id) => typeof id === "string")
  );
}
