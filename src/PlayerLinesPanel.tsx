import { useEffect, useState } from "react";
import { cachedPlayerLines, loadPlayerLines, type PlayerLine, type PlayerLines } from "./api/playerLines";
import type { PlayerStats } from "./api/rankings";
import { ImpliedProbabilityChart } from "./ImpliedProbabilityChart";
import { bookmakerColor, sortBookmakers } from "./bookmakerColors";
import { BookmakerMeansStrip } from "./BookmakerMeansStrip";
import { bookmakerMeans } from "./expectedStat";
import { marketInfo } from "./markets";

type StatKey = keyof PlayerStats;

type PanelPlayer = {
  id: string;
  gameId: string;
  name: string;
  stats: PlayerStats;
  breakdown: { key: StatKey; label: string; points: number }[];
};


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

/**
 * An anytime TD bet is the same as over 0.5 total TDs, so it becomes the 0.5 line of the
 * total TDs ladder. If a book prices the same line twice, the later one in API order is
 * kept — matching how the backend's projection resolves the duplicate.
 */
function mergeAnytimeTouchdowns(lines: PlayerLine[]): PlayerLine[] {
  const merged = lines.map((line) =>
    line.market === "player_anytime_td" ? { ...line, market: "player_tds_over", lineValue: 0.5 } : line,
  );
  const lastIndex = new Map<string, number>();
  merged.forEach((line, index) => lastIndex.set(`${line.market}|${line.bookmaker}|${line.lineValue}`, index));
  return merged.filter(
    (line, index) => lastIndex.get(`${line.market}|${line.bookmaker}|${line.lineValue}`) === index,
  );
}


function marketLabel(market: string) {
  return (
    marketInfo[market]?.label ??
    market
      .replace(/^player_/, "")
      .replace(/_/g, " ")
      .replace(/^\w/, (letter) => letter.toUpperCase())
  );
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

function MarketTable({
  market,
  lines,
  focusedBookmaker,
}: {
  market: string;
  lines: PlayerLine[];
  focusedBookmaker: string | null;
}) {
  const bookmakers = sortBookmakers(lines.map((line) => line.bookmaker));
  const lineValues = [...new Set(lines.map((line) => line.lineValue))].sort((a, b) => a - b);
  const odds = new Map(lines.map((line) => [`${line.lineValue}|${line.bookmaker}`, line.overDecimalOdds]));

  return (
    <div className="lines-table-scroll">
      <table className="lines-table" aria-label={`${marketLabel(market)} lines`}>
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th
              scope="col"
              className="numeric"
              title="Average of 1 ÷ decimal odds across bookmakers. Includes the bookmakers' margin."
            >
              Implied
            </th>
            {bookmakers.map((bookmaker) => (
              <th
                scope="col"
                className={bookmaker === focusedBookmaker ? "numeric focused" : "numeric"}
                key={bookmaker}
              >
                <span className="book-heading">
                  <span className="legend-dot" style={{ background: bookmakerColor(bookmaker) }} aria-hidden="true" />
                  {bookmaker}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lineValues.map((lineValue) => {
            const rowOdds = bookmakers
              .map((bookmaker) => odds.get(`${lineValue}|${bookmaker}`))
              .filter((value): value is number => value !== undefined);
            const implied = rowOdds.reduce((total, value) => total + 1 / value, 0) / rowOdds.length;
            return (
              <tr key={lineValue}>
                <th scope="row">Over {lineValue}</th>
                <td className="numeric implied">{(implied * 100).toFixed(0)}%</td>
                {bookmakers.map((bookmaker) => {
                  const value = odds.get(`${lineValue}|${bookmaker}`);
                  return (
                    <td
                      className={bookmaker === focusedBookmaker ? "numeric focused" : "numeric"}
                      key={bookmaker}
                    >
                      {value === undefined ? <span className="no-line">—</span> : value.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PlayerLinesPanel({ player }: { player: PanelPlayer }) {
  const cacheKey = `${player.id}|${player.gameId}`;
  const [data, setData] = useState<PlayerLines | null>(() => cachedPlayerLines(player.id, player.gameId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<"chart" | "table">("chart");
  // Shared by every chart and table in the panel, so one click compares a book everywhere.
  const [focusedBookmaker, setFocusedBookmaker] = useState<string | null>(null);

  useEffect(() => {
    const cached = cachedPlayerLines(player.id, player.gameId);
    if (cached) {
      setData(cached);
      return;
    }
    // The request is shared (other views may be waiting on it), so it isn't aborted on
    // unmount; results are just ignored once this panel is gone.
    let isCurrent = true;
    setData(null);
    setError(null);
    loadPlayerLines(player.id, player.gameId)
      .then((result) => isCurrent && setData(result))
      .catch((caught: unknown) => {
        if (isCurrent) setError(caught instanceof Error ? caught.message : "Could not load bookmaker lines.");
      });
    return () => {
      isCurrent = false;
    };
  }, [cacheKey, player.id, player.gameId, attempt]);

  if (error) {
    return (
      <div className="lines-panel">
        <p className="lines-status error-state" role="alert">
          {error}{" "}
          <button type="button" className="row-action" onClick={() => setAttempt((count) => count + 1)}>
            Retry
          </button>
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="lines-panel">
        <p className="lines-status" role="status">Loading bookmaker lines for {player.name}...</p>
      </div>
    );
  }

  if (data.lines.length === 0) {
    return (
      <div className="lines-panel">
        <p className="lines-status">No bookmaker lines are available for {player.name} in this game.</p>
      </div>
    );
  }

  // Group lines by the projected stat they feed, then by market.
  const sections = new Map<StatKey | "other", Map<string, PlayerLine[]>>();
  for (const line of mergeAnytimeTouchdowns(data.lines)) {
    const section = marketInfo[line.market]?.stat ?? "other";
    const markets = sections.get(section) ?? new Map<string, PlayerLine[]>();
    markets.set(line.market, [...(markets.get(line.market) ?? []), line]);
    sections.set(section, markets);
  }

  // Each bookmaker's expected value per stat, from the raw lines in API order (as the backend).
  const meansByStat = new Map<StatKey, ReturnType<typeof bookmakerMeans>>();
  for (const stat of statOrder) {
    const statLines = data.lines.filter((line) => marketInfo[line.market]?.stat === stat);
    if (statLines.length > 0) meansByStat.set(stat, bookmakerMeans(statLines));
  }

  const allBookmakers = sortBookmakers(data.lines.map((line) => line.bookmaker));

  const lastUpdated = new Date(Math.max(...data.lines.map((line) => line.lastUpdatedAt.getTime())));
  const bookmakerCount = new Set(data.lines.map((line) => line.bookmaker)).size;
  const orderedSections = [...statOrder, "other" as const].filter((key) => sections.has(key));

  return (
    <div className="lines-panel">
      <div className="lines-header">
        <div>
          <p className="menu-title">Bookmaker lines</p>
          <p className="menu-description">
            Implied probability of the over (1 ÷ decimal odds) at each line, from {bookmakerCount}{" "}
            bookmaker{bookmakerCount === 1 ? "" : "s"}. These lines are what the projected stats are
            based on.
          </p>
        </div>
        <div className="lines-header-side">
          <div className="scoring-formats" role="group" aria-label="Lines view">
            {(["chart", "table"] as const).map((option) => (
              <button
                type="button"
                key={option}
                className={view === option ? "format-option selected" : "format-option"}
                aria-pressed={view === option}
                onClick={() => setView(option)}
              >
                {option === "chart" ? "Chart" : "Table"}
              </button>
            ))}
          </div>
          <p className="lines-meta">
            {data.commenceTime && <span>Kickoff {formatDateTime(data.commenceTime)}</span>}
            <span>Updated {formatDateTime(lastUpdated)}</span>
          </p>
        </div>
      </div>

      <div className="lines-legend" role="group" aria-label="Focus a bookmaker in every chart">
        {allBookmakers.map((bookmaker) => (
          <button
            type="button"
            key={bookmaker}
            className={focusedBookmaker && focusedBookmaker !== bookmaker ? "legend-book muted" : "legend-book"}
            aria-pressed={focusedBookmaker === bookmaker}
            title={focusedBookmaker === bookmaker ? "Show all bookmakers" : `Compare ${bookmaker} with the average`}
            onClick={() => setFocusedBookmaker(focusedBookmaker === bookmaker ? null : bookmaker)}
          >
            <span className="legend-dot" style={{ background: bookmakerColor(bookmaker) }} aria-hidden="true" />
            {bookmaker}
          </button>
        ))}
        <span className="legend-key" aria-hidden="true">
          <span className="legend-line" />
          Average
        </span>
        <span className="legend-key" aria-hidden="true">
          <span className="legend-projection" />
          Projection (avg)
        </span>
        <span className="legend-key" aria-hidden="true">
          <span className="legend-median" />
          Median
        </span>
        <span className="lines-legend-hint">
          {focusedBookmaker ? (
            <button type="button" className="legend-reset" onClick={() => setFocusedBookmaker(null)}>
              Show all
            </button>
          ) : (
            "Click a bookmaker to compare it with the average"
          )}
        </span>
      </div>

      <div className="lines-sections">
        {orderedSections.flatMap((section) => {
          const markets = sections.get(section)!;
          const breakdownItem =
            section === "other" ? undefined : player.breakdown.find((item) => item.key === section);
          // One card per market: charts sit side by side, tables span the full row.
          const means = section === "other" ? undefined : meansByStat.get(section);
          return [...markets].map(([market, lines], marketIndex) => {
            const showChart = view === "chart" && new Set(lines.map((line) => line.lineValue)).size > 1;
            return (
              <section className={showChart ? "lines-section" : "lines-section wide"} key={market}>
                <h3>
                  <span>
                    {section === "other" ? marketLabel(market) : statLabels[section]}
                    {section !== "other" && markets.size > 1 && (
                      <span className="lines-market-label"> · {marketLabel(market)}</span>
                    )}
                  </span>
                  {section !== "other" && (
                    <span className="lines-projection">
                      Projected {player.stats[section].toFixed(1)}
                      {breakdownItem && (
                        <span className={breakdownItem.points < 0 ? "breakdown-points negative" : "breakdown-points"}>
                          {" "}
                          → {breakdownItem.points >= 0 ? "+" : "−"}
                          {Math.abs(breakdownItem.points).toFixed(1)} pts
                        </span>
                      )}
                    </span>
                  )}
                </h3>
                {marketIndex === 0 && section !== "other" && means && means.average !== null && (
                  <BookmakerMeansStrip
                    label={statLabels[section]}
                    means={means.means}
                    excluded={means.excluded}
                    average={means.average}
                    focusedBookmaker={focusedBookmaker}
                    onFocusBookmaker={setFocusedBookmaker}
                  />
                )}
                {showChart ? (
                  <ImpliedProbabilityChart
                    label={marketLabel(market)}
                    lines={lines}
                    projection={section === "other" ? undefined : player.stats[section]}
                    focusedBookmaker={focusedBookmaker}
                  />
                ) : (
                  <MarketTable market={market} lines={lines} focusedBookmaker={focusedBookmaker} />
                )}
              </section>
            );
          });
        })}
      </div>
    </div>
  );
}
