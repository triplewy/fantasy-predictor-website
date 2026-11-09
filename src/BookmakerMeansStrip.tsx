import { useState } from "react";
import { bookmakerColor } from "./bookmakerColors";
import { niceTicks, useWidth } from "./ImpliedProbabilityChart";

/** One bookmaker's value for one stat (its projection from its own lines). */
export type BookmakerMean = { bookmaker: string; mean: number };

const margin = { top: 22, right: 16, bottom: 26, left: 16 };
/** Space between the "Avg" label and the axis, which the dots sit on. */
const lineHeight = 14;
const dotRadius = 4;

/** Decimals follow the stat's scale (yards: 1, counts like TDs: 2), so diffs match their values. */
function decimalsFor(scale: number) {
  return Math.abs(scale) >= 20 ? 1 : 2;
}

function formatValue(value: number, scale = value) {
  return value.toFixed(decimalsFor(scale));
}

function formatDiff(value: number, scale: number) {
  return `${value >= 0 ? "+" : "−"}${formatValue(Math.abs(value), scale)}`;
}

/**
 * Sample standard deviation (n − 1) of the bookmakers' expected values: how far books
 * typically sit from the average. Null with fewer than two bookmakers.
 */
function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Text anchors for the Avg and Median labels: centered over their lines, but pushed apart
 * (each away from the other) when the lines are too close for both labels, and kept inside
 * the chart at the edges.
 */
function markerAnchors(averageX: number, medianX: number, width: number) {
  const edge = (markerX: number) =>
    markerX > width - 60 ? ("end" as const) : markerX < 60 ? ("start" as const) : ("middle" as const);
  if (Math.abs(averageX - medianX) >= 90) return { average: edge(averageX), median: edge(medianX) };
  return averageX <= medianX
    ? { average: "end" as const, median: "start" as const }
    : { average: "start" as const, median: "end" as const };
}

/**
 * Strip plot: every bookmaker's expected value as a dot on one shared line, with the
 * average of the dots — the projection used in the breakdown — marked.
 */
export function BookmakerMeansStrip({
  label,
  means,
  excluded,
  average,
  focusedBookmaker,
  onFocusBookmaker,
  note,
  valueLabel = "Expected value",
  showAverage = true,
}: {
  /**
   * False when each dot is a book's median (yardage): only the average of the medians (the
   * projection) is shown, as "avg median", with no median-of-medians or std dev.
   */
  showAverage?: boolean;
  /** What each dot is: "Expected value" (a curve's mean) or "Median" (yardage). */
  valueLabel?: string;
  /** Extra caption text, e.g. how the values were scaled. */
  note?: string;
  label: string;
  means: BookmakerMean[];
  excluded: string[];
  average: number;
  focusedBookmaker: string | null;
  onFocusBookmaker: (bookmaker: string | null) => void;
}) {
  const [containerRef, width] = useWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<string | null>(null);

  const medianValue = median(means.map((item) => item.mean));
  const spread = standardDeviation(means.map((item) => item.mean));
  const values = [...means.map((item) => item.mean), average, ...(showAverage ? [medianValue] : [])];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.08 || Math.max(Math.abs(average) * 0.05, 0.1);
  const domain = [min - pad, max + pad] as const;

  const plotWidth = Math.max(width - margin.left - margin.right, 0);
  const axisY = margin.top + lineHeight;
  const lineY = axisY;
  const height = axisY + margin.bottom;
  const x = (value: number) => margin.left + ((value - domain[0]) / (domain[1] - domain[0])) * plotWidth;
  const ticks = niceTicks(domain[0], domain[1], Math.max(2, Math.floor(plotWidth / 70)));
  const averageX = x(average);
  const medianX = x(medianValue);
  const anchors = showAverage
    ? markerAnchors(averageX, medianX, width)
    : { average: markerAnchors(averageX, averageX + 90, width).average, median: "middle" as const };
  // Nudge labels off their line when pushed apart, so text doesn't sit on the line.
  const labelX = (markerX: number, anchor: "start" | "middle" | "end") =>
    anchor === "start" ? markerX + 3 : anchor === "end" ? markerX - 3 : markerX;

  // Focused/hovered book is drawn last so it sits on top of any overlapping dots.
  const ordered = [...means].sort((a, b) => {
    const rank = (name: string) => (name === hovered ? 2 : name === focusedBookmaker ? 1 : 0);
    return rank(a.bookmaker) - rank(b.bookmaker);
  });
  const active = means.find((item) => item.bookmaker === hovered);

  return (
    <div className="means-strip" ref={containerRef}>
      <p className="means-caption">
        {showAverage ? (
          <>
            {valueLabel} by bookmaker · average of {means.length} = <strong>{formatValue(average)}</strong>
            {" "}· median = <strong>{formatValue(medianValue, average)}</strong>
            {" "}·{" "}
            <span title="Standard deviation of the bookmakers' expected values (sample, n − 1): how far books typically sit from the average.">
              std dev = <strong>{spread === null ? "—" : `±${formatValue(spread, average)}`}</strong>
            </span>
          </>
        ) : (
          <>
            {valueLabel} by bookmaker · avg median of {means.length} = <strong>{formatValue(average)}</strong>
          </>
        )}
        {note && <span> · {note}</span>}
        {excluded.length > 0 && (
          <span className="means-excluded">
            {" "}
            · {excluded.join(", ")} not counted (no usable curve)
          </span>
        )}
      </p>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${label}: ${valueLabel.toLowerCase()} by bookmaker. ${[...means]
            .sort((a, b) => a.mean - b.mean)
            .map((item) => `${item.bookmaker} ${formatValue(item.mean, average)}`)
            .join(", ")}. ${
            showAverage
              ? `Average ${formatValue(average)}, median ${formatValue(medianValue, average)}${
                  spread === null ? "" : `, standard deviation ${formatValue(spread, average)}`
                }`
              : `Average median ${formatValue(average)}`
          }.`}
        >
          <line className="prob-axis" x1={margin.left} x2={margin.left + plotWidth} y1={axisY} y2={axisY} />
          {ticks.map((tick) => (
            <text key={tick} className="prob-tick" x={x(tick)} y={axisY + 16} textAnchor="middle">
              {tick}
            </text>
          ))}

          {showAverage && (
            <>
              <line className="means-median" x1={medianX} x2={medianX} y1={margin.top - 4} y2={axisY} />
              <text
                className="means-median-label"
                x={labelX(medianX, anchors.median)}
                y={margin.top - 8}
                textAnchor={anchors.median}
              >
                Med {formatValue(medianValue, average)}
              </text>
            </>
          )}

          <line className="prob-projection" x1={averageX} x2={averageX} y1={margin.top - 4} y2={axisY} />
          <text
            className="prob-projection-label"
            x={labelX(averageX, anchors.average)}
            y={margin.top - 8}
            textAnchor={anchors.average}
          >
            {showAverage ? "Avg" : "Avg med"} {formatValue(average)}
          </text>

          {ordered.map((item) => {
            const muted = focusedBookmaker !== null && focusedBookmaker !== item.bookmaker;
            const emphasized = focusedBookmaker === item.bookmaker || hovered === item.bookmaker;
            return (
              <g
                key={item.bookmaker}
                className={muted ? "means-dot muted" : "means-dot"}
                onPointerEnter={() => setHovered(item.bookmaker)}
                onPointerLeave={() => setHovered(null)}
                onClick={() => onFocusBookmaker(focusedBookmaker === item.bookmaker ? null : item.bookmaker)}
              >
                <circle className="means-hit" cx={x(item.mean)} cy={lineY} r={dotRadius + 5} />
                <circle
                  cx={x(item.mean)}
                  cy={lineY}
                  r={emphasized ? dotRadius + 1.5 : dotRadius}
                  style={{ fill: bookmakerColor(item.bookmaker) }}
                />
              </g>
            );
          })}
        </svg>
      )}
      {active && (
        <div
          className="prob-tooltip means-tooltip"
          style={{
            left: Math.min(Math.max(x(active.mean) - 90, 0), Math.max(width - 180, 0)),
            top: axisY + 30,
            width: 180,
          }}
          role="status"
        >
          <p className="prob-tooltip-title prob-tooltip-book">
            <span className="legend-dot" style={{ background: bookmakerColor(active.bookmaker) }} />
            {active.bookmaker}
          </p>
          <p className="prob-tooltip-focus">
            <span>{showAverage ? "Expected" : valueLabel}</span>
            <span>{formatValue(active.mean, average)}</span>
          </p>
          <p className="prob-tooltip-focus">
            <span>{showAverage ? "vs average" : "vs avg median"}</span>
            <span>{formatDiff(active.mean - average, average)}</span>
          </p>
          {showAverage && (
            <p className="prob-tooltip-focus">
              <span>vs median</span>
              <span>{formatDiff(active.mean - medianValue, average)}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
