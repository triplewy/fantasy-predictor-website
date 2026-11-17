import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { niceTicks, useWidth } from "./chartUtils";

export type OverlaySeries = {
  id: string;
  name: string;
  color: string;
  lineValues: number[];
  probabilities: number[];
  /** The projected stat, drawn as a dashed vertical line when it falls inside the chart. */
  projection?: number;
};

const aspectRatio = 1.05;
const minHeight = 230;
const margin = { top: 18, right: 12, bottom: 30, left: 38 };
const yTicks = [0, 0.25, 0.5, 0.75, 1];

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** One market's fair Over-probability curves, one line per compared player. */
export function MarketOverlayChart({
  label,
  series,
  dulledIds,
}: {
  label: string;
  series: OverlaySeries[];
  /** Players whose curves are dimmed. */
  dulledIds?: ReadonlySet<string>;
}) {
  const [containerRef, width] = useWidth<HTMLDivElement>();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [view, setView] = useState<[number, number] | null>(null);
  const dragStart = useRef<number | null>(null);
  const [dragX, setDragX] = useState<number | null>(null);
  const hitAreaRef = useRef<SVGRectElement>(null);

  const height = Math.max(Math.round(width * aspectRatio), minHeight);
  const plotWidth = Math.max(width - margin.left - margin.right, 0);
  const plotHeight = height - margin.top - margin.bottom;

  const prepared = useMemo(
    () =>
      series
        .map((entry) => ({
          ...entry,
          points: entry.lineValues
            .map((lineValue, index) => ({ lineValue, probability: entry.probabilities[index] }))
            .sort((a, b) => a.lineValue - b.lineValue),
        })),
    [series],
  );
  const isDimmed = (id: string) => dulledIds?.has(id) ?? false;

  const allLines = prepared.flatMap((entry) => entry.points.map((point) => point.lineValue));
  const minLine = allLines.length > 0 ? Math.min(...allLines) : 0;
  const maxLine = allLines.length > 0 ? Math.max(...allLines) : 1;
  const pad = (maxLine - minLine) * 0.03 || 0.5;
  const fullDomain = [minLine - pad, maxLine + pad] as const;

  const domain = view ?? fullDomain;

  const x = (value: number) => margin.left + ((value - domain[0]) / (domain[1] - domain[0])) * plotWidth;
  const y = (probability: number) => margin.top + (1 - probability) * plotHeight;

  // Snap to the nearest line value across all series so every curve is read at the same line.
  const snapLines = useMemo(() => {
    const lines = [...new Set(prepared.flatMap((entry) => entry.points.map((point) => point.lineValue)))].sort(
      (a, b) => a - b,
    );
    return lines;
  }, [prepared]);

  const activeLine = activeIndex === null ? null : snapLines[activeIndex] ?? null;

  const xTicks = niceTicks(domain[0], domain[1], Math.max(2, Math.floor(plotWidth / 70)));

  function handlePointerMove(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left + margin.left;
    if (dragStart.current !== null) {
      setDragX(pointerX);
      return;
    }
    let nearest = 0;
    snapLines.forEach((line, index) => {
      if (Math.abs(x(line) - pointerX) < Math.abs(x(snapLines[nearest]) - pointerX)) {
        nearest = index;
      }
    });
    setActiveIndex(nearest);
  }

  function handlePointerDown(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    dragStart.current = event.clientX - bounds.left + margin.left;
    setDragX(dragStart.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerUp() {
    if (dragStart.current !== null && dragX !== null) {
      const from = Math.min(dragStart.current, dragX);
      const to = Math.max(dragStart.current, dragX);
      const toValue = (pixel: number) => domain[0] + ((pixel - margin.left) / plotWidth) * (domain[1] - domain[0]);
      const start = toValue(from);
      const end = toValue(to);
      // Only zoom when the drag spans a meaningful range.
      if (end - start > (fullDomain[1] - fullDomain[0]) * 0.02) {
        setView([start, end]);
      }
    }
    dragStart.current = null;
    setDragX(null);
  }

  // Native non-passive listener so preventDefault stops the page from scrolling while zooming.
  const domainRef = useRef(domain);
  domainRef.current = domain;
  const fullDomainRef = useRef(fullDomain);
  fullDomainRef.current = fullDomain;
  const plotWidthRef = useRef(plotWidth);
  plotWidthRef.current = plotWidth;

  useEffect(() => {
    const element = hitAreaRef.current;
    if (!element) return;
    function onWheel(event: globalThis.WheelEvent) {
      event.preventDefault();
      const bounds = element!.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left + margin.left;
      const [lo, hi] = domainRef.current;
      const [fullLo, fullHi] = fullDomainRef.current;
      const widthPx = plotWidthRef.current;
      const pointerValue = lo + ((pointerX - margin.left) / widthPx) * (hi - lo);
      const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2;
      const fullSpan = fullHi - fullLo;
      const nextSpan = Math.min(Math.max((hi - lo) * factor, fullSpan * 0.05), fullSpan);
      const ratio = hi === lo ? 0.5 : (pointerValue - lo) / (hi - lo);
      let nextLo = pointerValue - nextSpan * ratio;
      let nextHi = nextLo + nextSpan;
      if (nextLo < fullLo) {
        nextLo = fullLo;
        nextHi = nextLo + nextSpan;
      }
      if (nextHi > fullHi) {
        nextHi = fullHi;
        nextLo = nextHi - nextSpan;
      }
      setView([nextLo, nextHi]);
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [width]);

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setActiveIndex((current) =>
        Math.min(snapLines.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : snapLines.length)) + step)),
      );
    } else if (event.key === "Escape") {
      setActiveIndex(null);
    }
  }

  // Keep the tooltip inside the chart: flip to the left of the crosshair past the midpoint.
  const tooltipWidth = Math.min(250, width);
  const tooltipStyle = activeLine !== null
    ? (() => {
        const crosshair = x(activeLine);
        const left =
          crosshair + 10 + tooltipWidth <= width
            ? crosshair + 10
            : crosshair - 10 - tooltipWidth >= 0
              ? crosshair - 10 - tooltipWidth
              : width - tooltipWidth;
        return { left: Math.max(0, left), width: tooltipWidth };
      })()
    : undefined;

  const isZoomed = view !== null;

  return (
    <div className="prob-chart overlay-chart" ref={containerRef}>
      {width > 0 && prepared.length > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          tabIndex={0}
          aria-label={`${label}: fair probability of the over, comparing ${prepared
            .map((entry) => entry.name)
            .join(", ")}. Scroll or drag to zoom; use the left and right arrow keys to read each line.`}
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

          {prepared.map(
            (entry) =>
              entry.projection !== undefined &&
              entry.projection >= domain[0] &&
              entry.projection <= domain[1] && (
                <line
                  key={`projection-${entry.id}`}
                  className={`overlay-projection${isDimmed(entry.id) ? " dimmed" : ""}`}
                  stroke={entry.color}
                  x1={x(entry.projection)}
                  x2={x(entry.projection)}
                  y1={margin.top}
                  y2={margin.top + plotHeight}
                />
              ),
          )}

          {prepared.map((entry) => (
            <path
              key={entry.id}
              className={`overlay-curve${isDimmed(entry.id) ? " dimmed" : ""}`}
              stroke={entry.color}
              d={entry.points
                .filter((point) => point.lineValue >= domain[0] && point.lineValue <= domain[1])
                .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.lineValue)},${y(point.probability)}`)
                .join(" ")}
            />
          ))}

          {prepared.map((entry) =>
            entry.points
              .filter((point) => point.lineValue >= domain[0] && point.lineValue <= domain[1])
              .map((point) => (
                <circle
                  key={`${entry.id}-${point.lineValue}`}
                  className={`overlay-dot${isDimmed(entry.id) ? " dimmed" : ""}`}
                  fill={entry.color}
                  cx={x(point.lineValue)}
                  cy={y(point.probability)}
                  r={activeLine === point.lineValue ? 5 : 3.5}
                >
                  <title>{`${entry.name}: Over ${point.lineValue} — ${percent(point.probability)}`}</title>
                </circle>
              )),
          )}

          {activeLine !== null && (
            <line
              className="prob-crosshair"
              x1={x(activeLine)}
              x2={x(activeLine)}
              y1={margin.top}
              y2={margin.top + plotHeight}
            />
          )}

          {dragStart.current !== null && dragX !== null && (
            <rect
              className="overlay-zoom-selection"
              x={Math.min(dragStart.current, dragX)}
              y={margin.top}
              width={Math.abs(dragX - dragStart.current)}
              height={plotHeight}
            />
          )}

          <rect
            ref={hitAreaRef}
            className="prob-hit-area"
            x={margin.left}
            y={margin.top}
            width={plotWidth}
            height={plotHeight}
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerLeave={() => {
              setActiveIndex(null);
              handlePointerUp();
            }}
          />
        </svg>
      )}

      {activeLine !== null && (
        <div className="prob-tooltip" style={{ ...tooltipStyle, top: margin.top }} role="status">
          <p className="prob-tooltip-title">Line {activeLine}</p>
          {prepared
            .map((entry) => ({
              entry,
              point: entry.points.find((candidate) => candidate.lineValue === activeLine),
            }))
            .filter((item): item is { entry: (typeof prepared)[number]; point: { lineValue: number; probability: number } } =>
              item.point !== undefined,
            )
            .sort((a, b) => b.point.probability - a.point.probability)
            .map(({ entry, point }) => (
              <p key={entry.id} className="prob-tooltip-average">
                <span>
                  <span className="compare-series-dot" style={{ background: entry.color }} aria-hidden="true" />
                  {entry.name}
                </span>
                <span>{percent(point.probability)}</span>
              </p>
            ))}
        </div>
      )}

      {isZoomed && (
        <button
          type="button"
          className="overlay-reset-zoom"
          onClick={() => setView(null)}
          aria-label={`Reset ${label} zoom`}
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}
