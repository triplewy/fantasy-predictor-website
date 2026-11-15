import type { PlayerMarket, PlayerStats } from "./api/rankings";
import type { BreakdownItem } from "./scoring";
import { ImpliedProbabilityChart } from "./ImpliedProbabilityChart";
import { marketInfo } from "./markets";

type StatKey = keyof PlayerStats;

const statLabels: Record<StatKey, string> = {
  passingYards: "Passing yards",
  passingTouchdowns: "Passing touchdowns",
  interceptions: "Interceptions",
  rushingYards: "Rushing yards",
  receptions: "Receptions",
  receivingYards: "Receiving yards",
  touchdowns: "Rushing + receiving touchdowns",
  kickingPoints: "Kicking points",
};

const statOrder = Object.keys(statLabels) as StatKey[];

/** Stat key a market belongs to, or undefined for markets that don't map to one. */
function statOfMarket(market: string): StatKey | undefined {
  return marketInfo[market]?.stat;
}

function formatDateTime(date: Date) {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Fitted distribution parameters, e.g. "mu 24.5 · sigma 7.2" or "shape 2.1 · scale 11.9". */
function formatParameters(market: PlayerMarket): string {
  const { family, parameters } = market.distribution_function;
  if (family === "gamma") {
    return `shape ${parameters.shape?.toFixed(2)} · scale ${parameters.scale?.toFixed(2)}`;
  }
  return `mu ${parameters.mu?.toFixed(2)} · sigma ${parameters.sigma?.toFixed(2)}`;
}

/** One stat's fitted market: the fair Over-probability curve and the distribution behind it. */
function MarketCard({
  label,
  market,
  projection,
  breakdownItem,
}: {
  label: string;
  market: PlayerMarket;
  projection?: number;
  breakdownItem?: BreakdownItem;
}) {
  const { line_values, fair_over_probabilities, distribution_function } = market;
  const showChart = line_values.length > 1;
  return (
    <section className={showChart ? "lines-section" : "lines-section wide"}>
      <h3>
        <span>{label}</span>
        <span className="lines-projection">
          Projected {projection?.toFixed(1)}
          {breakdownItem && (
            <span className={breakdownItem.points < 0 ? "breakdown-points negative" : "breakdown-points"}>
              {" "}
              → {breakdownItem.points >= 0 ? "+" : "−"}
              {Math.abs(breakdownItem.points).toFixed(1)} pts
            </span>
          )}
        </span>
      </h3>
      <p className="lines-distribution">
        {distribution_function.family} · {formatParameters(market)} · mean{" "}
        {distribution_function.mean.toFixed(1)} · fit MSE {distribution_function.loo_mse.toFixed(2)} ·{" "}
        {market.bookmaker}
      </p>
      {showChart ? (
        <ImpliedProbabilityChart
          label={label}
          lineValues={line_values}
          probabilities={fair_over_probabilities}
          projection={projection}
        />
      ) : (
        <p className="lines-status">Only one line is available, so there's no curve to show.</p>
      )}
    </section>
  );
}

/** The panel only needs the player's name, projected stats, and fitted markets. */
export type PanelPlayer = {
  name: string;
  stats: PlayerStats;
  markets: PlayerMarket[];
  lastUpdatedAt: Date | null;
};

export function PlayerLinesPanel({
  player,
  breakdown,
}: {
  player: PanelPlayer;
  /** Points breakdown for the current scoring, when the caller has one. */
  breakdown?: BreakdownItem[];
}) {
  // Group the player's markets by the stat they project.
  const sections = new Map<StatKey, PlayerMarket[]>();
  for (const market of player.markets) {
    const stat = statOfMarket(market.market);
    if (!stat) continue;
    sections.set(stat, [...(sections.get(stat) ?? []), market]);
  }
  const orderedSections = statOrder.filter((stat) => sections.has(stat));

  const lastUpdated = player.lastUpdatedAt;

  return (
    <div className="lines-panel">
      <div className="lines-header">
        <div>
          <p className="menu-title">Projected markets</p>
          <p className="menu-description">
            Fair (vig-removed) probability of the over at each line, from the fitted distribution
          </p>
        </div>
        <div className="lines-header-side">
          {lastUpdated && <p className="lines-meta">Updated {formatDateTime(lastUpdated)}</p>}
        </div>
      </div>

      {orderedSections.length === 0 ? (
        <p className="lines-status">No projected markets are available for {player.name} this week.</p>
      ) : (
        <div className="lines-sections">
          {orderedSections.map((stat) =>
            sections.get(stat)!.map((market) => (
              <MarketCard
                key={market.market}
                label={statLabels[stat]}
                market={market}
                projection={player.stats[stat]}
                breakdownItem={breakdown?.find((item) => item.key === stat)}
              />
            )),
          )}
        </div>
      )}
    </div>
  );
}
