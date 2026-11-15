import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { niceTicks, useWidth } from "./chartUtils";

type CurvePoint = {
  lineValue: number;
  /** Fair (vig-removed) probability the stat lands Over this line. */
  probability: number;
};

/** Charts are portrait: taller than they are wide. */
const aspectRatio = 1.8;
const minHeight = 400;
const margin = { top: 22, right: 16, bottom: 32, left: 42 };
const yTicks = [0, 0.25, 0.5, 0.75, 1];

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function ImpliedProbabilityChart({
  label,
  lineValues,
  probabilities,
  projection,
}: {
  label: string;
  lineValues: number[];
  probabilities: number[];
  /** The projected stat, drawn as a vertical line when it falls inside the chart. */
  projection?: number;
}) {
  const points = useMemo<CurvePoint[]>(
    () =>
      lineValues
        .map((lineValue, index) => ({ lineValue, probability: probabilities[index] }))
        .sort((a, b) => a.lineValue - b.lineValue),
    [lineValues, probabilities],
  );
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

  const curvePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.lineValue)},${y(point.probability)}`).join(" ");

  const showProjection =
    projection !== undefined && projection >= domain[0] && projection <= domain[1];

  const active = activeIndex === null ? null : points[activeIndex];

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
    <div className="prob-chart" ref={containerRef}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          tabIndex={0}
          aria-label={`${label}: fair probability of the over at ${points.length} lines, from ${percent(
            points[0].probability,
          )} at ${points[0].lineValue} to ${percent(points[points.length - 1].probability)} at ${
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
                x1={x(projection!)}
                x2={x(projection!)}
                y1={margin.top}
                y2={margin.top + plotHeight}
              />
              <text
                className="prob-projection-label"
                x={x(projection!)}
                y={margin.top - 8}
                textAnchor={x(projection!) > width - 90 ? "end" : x(projection!) < 90 ? "start" : "middle"}
              >
                Projected {projection!.toFixed(1)}
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

          <path className="prob-curve" d={curvePath} />

          {points.map((point) => (
            <circle
              key={point.lineValue}
              className={active?.lineValue === point.lineValue ? "prob-curve-dot active" : "prob-curve-dot"}
              cx={x(point.lineValue)}
              cy={y(point.probability)}
              r={active?.lineValue === point.lineValue ? 5 : 3.5}
            />
          ))}

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
          <p className="prob-tooltip-average">
            <span>Fair over probability</span>
            <span>{percent(active.probability)}</span>
          </p>
        </div>
      )}
    </div>
  );
}
