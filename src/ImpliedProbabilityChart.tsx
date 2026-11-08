import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { PlayerLine } from "./api/playerLines";
import { bookmakerColor, sortBookmakers } from "./bookmakerColors";

type LinePoint = {
  lineValue: number;
  /** Average of 1 ÷ decimal odds across the bookmakers offering this line. */
  averageImplied: number;
  books: { bookmaker: string; odds: number; implied: number; isMainLine: boolean; underOdds: number | null }[];
};

/** Charts are portrait: taller than they are wide. */
const aspectRatio = 1.8;
const minHeight = 400;
const margin = { top: 22, right: 16, bottom: 32, left: 42 };
const yTicks = [0, 0.25, 0.5, 0.75, 1];

export function toLinePoints(lines: PlayerLine[]): LinePoint[] {
  const byLine = new Map<number, LinePoint["books"]>();
  for (const line of lines) {
    const books = byLine.get(line.lineValue) ?? [];
    books.push({
      bookmaker: line.bookmaker,
      odds: line.overDecimalOdds,
      implied: 1 / line.overDecimalOdds,
      isMainLine: line.isMainLine ?? false,
      underOdds: line.underDecimalOdds,
    });
    byLine.set(line.lineValue, books);
  }
  return [...byLine]
    .sort(([a], [b]) => a - b)
    .map(([lineValue, books]) => ({
      lineValue,
      averageImplied: books.reduce((total, book) => total + book.implied, 0) / books.length,
      books: sortBookmakers(books.map((book) => book.bookmaker)).map(
        (name) => books.find((book) => book.bookmaker === name)!,
      ),
    }));
}

/** Round, evenly spaced axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, target: number): number[] {
  const span = max - min || 1;
  const rough = span / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + 1e-9; tick += step) {
    ticks.push(Number(tick.toFixed(6)));
  }
  return ticks;
}

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Difference in percentage points, e.g. "+2.1 pts". */
function formatDiff(value: number) {
  const points = value * 100;
  return `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} pts`;
}

export function ImpliedProbabilityChart({
  label,
  lines,
  projection,
  focusedBookmaker,
}: {
  label: string;
  lines: PlayerLine[];
  projection?: number;
  /** When set, only this bookmaker's line is drawn, against the average. */
  focusedBookmaker: string | null;
}) {
  const points = useMemo(() => toLinePoints(lines), [lines]);
  const [containerRef, width] = useWidth<HTMLDivElement>();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const plotWidth = Math.max(width - margin.left - margin.right, 0);
  const height = Math.max(Math.round(width * aspectRatio), minHeight);
  const plotHeight = height - margin.top - margin.bottom;

  const minLine = points[0]?.lineValue ?? 0;
  const maxLine = points[points.length - 1]?.lineValue ?? 1;
  const pad = (maxLine - minLine) * 0.03 || 0.5;
  const domain = [minLine - pad, maxLine + pad] as const;

  const x = (value: number) => margin.left + ((value - domain[0]) / (domain[1] - domain[0])) * plotWidth;
  const y = (probability: number) => margin.top + (1 - probability) * plotHeight;

  // With only a few lines, label the lines themselves rather than round numbers between them.
  const xTicks =
    points.length <= 8 && plotWidth / points.length >= 40
      ? points.map((point) => point.lineValue)
      : niceTicks(minLine, maxLine, Math.max(2, Math.floor(plotWidth / 70)));
  // The average only means something where 2+ books price the same line; lines offered by
  // a single book would make it jump between books' differing margins.
  const consensusPoints = points.filter((point) => point.books.length > 1);
  const averagePath = consensusPoints
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.lineValue)},${y(point.averageImplied)}`)
    .join(" ");
  // Each bookmaker's own ladder, in its fixed color.
  const bookLadders = useMemo(() => {
    const byBook = new Map<string, { lineValue: number; implied: number; isMainLine: boolean }[]>();
    for (const point of points) {
      for (const book of point.books) {
        byBook.set(book.bookmaker, [
          ...(byBook.get(book.bookmaker) ?? []),
          { lineValue: point.lineValue, implied: book.implied, isMainLine: book.isMainLine },
        ]);
      }
    }
    return sortBookmakers(byBook.keys()).map((bookmaker) => ({
      bookmaker,
      color: bookmakerColor(bookmaker),
      ladder: byBook.get(bookmaker)!,
    }));
  }, [points]);

  const hasAverage = consensusPoints.length > 1;

  // Focus only applies if this market has the focused book; otherwise everyone is shown.
  const isFocused = bookLadders.some((book) => book.bookmaker === focusedBookmaker);
  const visibleLadders = isFocused
    ? bookLadders.filter((book) => book.bookmaker === focusedBookmaker)
    : bookLadders;

  const showProjection =
    projection !== undefined && projection >= domain[0] && projection <= domain[1];

  const active = activeIndex === null ? null : points[activeIndex];
  const focusedBook = isFocused
    ? active?.books.find((book) => book.bookmaker === focusedBookmaker)
    : undefined;

  function handlePointerMove(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left + margin.left;
    let nearest = 0;
    points.forEach((point, index) => {
      if (Math.abs(x(point.lineValue) - pointerX) < Math.abs(x(points[nearest].lineValue) - pointerX)) {
        nearest = index;
      }
    });
    setActiveIndex(nearest);
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setActiveIndex((current) =>
        Math.min(points.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : points.length)) + step)),
      );
    } else if (event.key === "Escape") {
      setActiveIndex(null);
    }
  }

  // Keep the tooltip inside the chart: flip to the left of the crosshair past the midpoint.
  // Beside the crosshair (right, else left), clamped so it never leaves the chart.
  const tooltipWidth = Math.min(250, width);
  const tooltipStyle = active
    ? (() => {
        const crosshair = x(active.lineValue);
        const left =
          crosshair + 10 + tooltipWidth <= width
            ? crosshair + 10
            : crosshair - 10 - tooltipWidth >= 0
              ? crosshair - 10 - tooltipWidth
              : width - tooltipWidth;
        return { left: Math.max(0, left), width: tooltipWidth };
      })()
    : undefined;

  return (
    <div className={isFocused ? "prob-chart focused" : "prob-chart"} ref={containerRef}>
      {focusedBookmaker && !isFocused && (
        <p className="prob-focus-note">{focusedBookmaker} doesn't offer this market. Showing all bookmakers.</p>
      )}
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          tabIndex={0}
          aria-label={`${label}: implied probability of the over at ${points.length} lines, from ${percent(
            points[0].averageImplied,
          )} at ${points[0].lineValue} to ${percent(points[points.length - 1].averageImplied)} at ${
            points[points.length - 1].lineValue
          }. Use the left and right arrow keys to read each line.`}
          onKeyDown={handleKeyDown}
          onBlur={() => setActiveIndex(null)}
        >
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                className={tick === 0 ? "prob-axis" : "prob-grid"}
                x1={margin.left}
                x2={margin.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="prob-tick" x={margin.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {percent(tick)}
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text
              key={tick}
              className="prob-tick"
              x={x(tick)}
              y={margin.top + plotHeight + 18}
              textAnchor="middle"
            >
              {tick}
            </text>
          ))}

          {showProjection && (
            <g>
              <line
                className="prob-projection"
                x1={x(projection)}
                x2={x(projection)}
                y1={margin.top}
                y2={margin.top + plotHeight}
              />
              <text
                className="prob-projection-label"
                x={x(projection)}
                y={margin.top - 8}
                textAnchor={x(projection) > width - 90 ? "end" : x(projection) < 90 ? "start" : "middle"}
              >
                Projected {projection.toFixed(1)}
              </text>
            </g>
          )}

          {active && (
            <line
              className="prob-crosshair"
              x1={x(active.lineValue)}
              x2={x(active.lineValue)}
              y1={margin.top}
              y2={margin.top + plotHeight}
            />
          )}

          {hasAverage && <path className="prob-average-line" d={averagePath} />}

          {visibleLadders.map(({ bookmaker, color, ladder }) => (
            <g key={bookmaker} className="prob-book">
              {ladder.length > 1 && (
                <path
                  className="prob-book-line"
                  style={{ stroke: color }}
                  d={ladder
                    .map((point, i) => `${i === 0 ? "M" : "L"}${x(point.lineValue)},${y(point.implied)}`)
                    .join(" ")}
                />
              )}
              {ladder.map((point) =>
                point.isMainLine ? (
                  // Main O/U line: larger dot with a dark ring, on the book's own curve.
                  <circle
                    key={point.lineValue}
                    className="prob-book-dot main-line"
                    style={{ fill: color }}
                    cx={x(point.lineValue)}
                    cy={y(point.implied)}
                    r={active?.lineValue === point.lineValue ? 6.5 : 5.5}
                  />
                ) : (
                  <circle
                    key={point.lineValue}
                    className="prob-book-dot"
                    style={{ fill: color }}
                    cx={x(point.lineValue)}
                    cy={y(point.implied)}
                    r={active?.lineValue === point.lineValue ? 5 : 3.5}
                  />
                ),
              )}
            </g>
          ))}

          {active && active.books.length > 1 && (
            <circle
              className="prob-average-dot"
              cx={x(active.lineValue)}
              cy={y(active.averageImplied)}
              r={4}
            />
          )}

          <rect
            className="prob-hit-area"
            x={margin.left}
            y={margin.top}
            width={plotWidth}
            height={plotHeight}
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerMove}
            onPointerLeave={() => setActiveIndex(null)}
          />
        </svg>
      )}

      {active && (
        <div className="prob-tooltip" style={{ ...tooltipStyle, top: margin.top }} role="status">
          <p className="prob-tooltip-title">Over {active.lineValue}</p>
          {active.books.length > 1 && (
            <p className="prob-tooltip-average">
              <span>Average implied</span>
              <span>{percent(active.averageImplied)}</span>
            </p>
          )}
          {isFocused ? (
            <p className="prob-tooltip-focus">
              <span className="prob-tooltip-book">
                <span className="legend-dot" style={{ background: bookmakerColor(focusedBookmaker!) }} />
                {focusedBookmaker}
              </span>
              <span>
                {focusedBook ? (
                  <>
                    {focusedBook.odds.toFixed(2)} · {percent(focusedBook.implied)}
                    {active.books.length > 1 && (
                      <span className="prob-tooltip-diff">
                        {" "}
                        ({formatDiff(focusedBook.implied - active.averageImplied)} vs avg)
                      </span>
                    )}
                  </>
                ) : (
                  "No line"
                )}
              </span>
            </p>
          ) : (
            <ul>
              {active.books.map((book) => (
                <li key={book.bookmaker}>
                  <span className="prob-tooltip-book">
                    <span className="legend-dot" style={{ background: bookmakerColor(book.bookmaker) }} />
                    {book.bookmaker}
                  </span>
                  <span>
                    {book.isMainLine && <span className="main-line-badge">main</span>}
                    {book.odds.toFixed(2)} · {percent(book.implied)}
                    {book.underOdds !== null && <span className="prob-tooltip-under"> · U {book.underOdds.toFixed(2)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
