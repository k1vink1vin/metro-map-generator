import type { GraphModel, LayoutResult, Point } from '../types';
import { nodeDegree } from '../core/graph';
import {
  buildGeometricBundleMap,
  offsetPathForLine,
  roundedPath,
} from './geometry';

interface SvgMapProps {
  graph: GraphModel;
  layout: LayoutResult;
  zoom?: number;
}

interface RenderedRoutePath {
  lineId: string;
  lineColor: string;
  pathIndex: number;
  points: Point[];
  d: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LabelPlacement {
  nodeId: string;
  text: string;
  x: number;
  y: number;
  textAnchor: 'start' | 'middle' | 'end';
  rect: Rect;
}

function intersects(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function overlapArea(a: Rect, b: Rect): number {
  if (!intersects(a, b)) return 0;
  const width =
    Math.min(a.x + a.width, b.x + b.width) -
    Math.max(a.x, b.x);
  const height =
    Math.min(a.y + a.height, b.y + b.height) -
    Math.max(a.y, b.y);
  return Math.max(0, width) * Math.max(0, height);
}

function padded(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function estimateTextWidth(text: string): number {
  return Math.max(
    18,
    Array.from(text).reduce((sum, character) => {
      if (/^[\x00-\x7F]$/.test(character)) {
        return sum + 7;
      }
      return sum + 12.5;
    }, 0),
  );
}

function labelRect(
  x: number,
  y: number,
  width: number,
  textAnchor: LabelPlacement['textAnchor'],
  scale = 1,
): Rect {
  const left =
    textAnchor === 'start'
      ? x
      : textAnchor === 'end'
        ? x - width
        : x - width / 2;

  return {
    x: left,
    y: y - 13 * scale,
    width,
    height: 16 * scale,
  };
}

function buildLabelPlacements(
  graph: GraphModel,
  layout: LayoutResult,
  visualScale = 1,
): LabelPlacement[] {
  const nodeObstacles = graph.nodes.map((node) => {
    const point = layout.positions[node.id];
    const degree = nodeDegree(graph, node.id);
    const radius =
      (node.stationIds.length > 1 || degree > 2 ? 15 : 10) * visualScale;

    return {
      nodeId: node.id,
      rect: {
        x: point.x - radius,
        y: point.y - radius,
        width: radius * 2,
        height: radius * 2,
      },
    };
  });

  const orderedNodes = [...graph.nodes].sort((a, b) => {
    const aDegree = nodeDegree(graph, a.id);
    const bDegree = nodeDegree(graph, b.id);
    const aPriority =
      a.stationIds.length > 1 || aDegree > 2
        ? 3
        : aDegree <= 1
          ? 2
          : 1;
    const bPriority =
      b.stationIds.length > 1 || bDegree > 2
        ? 3
        : bDegree <= 1
          ? 2
          : 1;

    if (aPriority !== bPriority) return bPriority - aPriority;

    const aPoint = layout.positions[a.id];
    const bPoint = layout.positions[b.id];
    return aPoint.y - bPoint.y || aPoint.x - bPoint.x;
  });

  const placements: LabelPlacement[] = [];
  const occupied: Rect[] = [];

  for (const node of orderedNodes) {
    const point = layout.positions[node.id];
    const text = node.name || node.id;
    const width = estimateTextWidth(text) * visualScale;

    const s = visualScale;
    const candidates: Array<{
      x: number;
      y: number;
      anchor: LabelPlacement['textAnchor'];
      distancePenalty: number;
    }> = [
      { x: point.x + 14 * s, y: point.y - 10 * s, anchor: 'start', distancePenalty: 0 },
      { x: point.x + 14 * s, y: point.y + 21 * s, anchor: 'start', distancePenalty: 1 },
      { x: point.x - 14 * s, y: point.y - 10 * s, anchor: 'end', distancePenalty: 1 },
      { x: point.x - 14 * s, y: point.y + 21 * s, anchor: 'end', distancePenalty: 2 },
      { x: point.x, y: point.y - 20 * s, anchor: 'middle', distancePenalty: 2 },
      { x: point.x, y: point.y + 31 * s, anchor: 'middle', distancePenalty: 3 },
      { x: point.x + 25 * s, y: point.y - 22 * s, anchor: 'start', distancePenalty: 4 },
      { x: point.x - 25 * s, y: point.y - 22 * s, anchor: 'end', distancePenalty: 4 },
      { x: point.x + 25 * s, y: point.y + 31 * s, anchor: 'start', distancePenalty: 5 },
      { x: point.x - 25 * s, y: point.y + 31 * s, anchor: 'end', distancePenalty: 5 },
    ];

    let best:
      | {
          placement: LabelPlacement;
          score: number;
        }
      | undefined;

    for (const candidate of candidates) {
      const rect = labelRect(
        candidate.x,
        candidate.y,
        width,
        candidate.anchor,
        visualScale,
      );
      const paddedRect = padded(rect, 3 * visualScale);

      let labelOverlap = 0;
      for (const used of occupied) {
        labelOverlap += overlapArea(paddedRect, used);
      }

      let stationOverlap = 0;
      for (const obstacle of nodeObstacles) {
        if (obstacle.nodeId === node.id) continue;
        stationOverlap += overlapArea(
          paddedRect,
          padded(obstacle.rect, 2 * visualScale),
        );
      }

      const score =
        labelOverlap * 20 +
        stationOverlap * 8 +
        candidate.distancePenalty * 12;

      const placement: LabelPlacement = {
        nodeId: node.id,
        text,
        x: candidate.x,
        y: candidate.y,
        textAnchor: candidate.anchor,
        rect,
      };

      if (!best || score < best.score) {
        best = { placement, score };
      }

      if (score === candidate.distancePenalty * 12) {
        break;
      }
    }

    if (!best) continue;
    placements.push(best.placement);
    occupied.push(
      padded(best.placement.rect, 3 * visualScale),
    );
  }

  return placements;
}

function renderBounds(
  graph: GraphModel,
  layout: LayoutResult,
  routePaths: RenderedRoutePath[],
  labels: LabelPlacement[],
) {
  const points: Point[] = [
    ...graph.nodes.map((node) => layout.positions[node.id]),
    ...routePaths.flatMap((path) => path.points),
  ].filter(
    (point): point is Point =>
      Boolean(point) &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y),
  );

  if (!points.length) {
    return { x: 0, y: 0, width: 1000, height: 720 };
  }

  const padding = 76;
  const minPointX = Math.min(...points.map((point) => point.x));
  const maxPointX = Math.max(...points.map((point) => point.x));
  const minPointY = Math.min(...points.map((point) => point.y));
  const maxPointY = Math.max(...points.map((point) => point.y));

  const minLabelX = labels.length
    ? Math.min(...labels.map((label) => label.rect.x))
    : minPointX;
  const maxLabelX = labels.length
    ? Math.max(
        ...labels.map(
          (label) => label.rect.x + label.rect.width,
        ),
      )
    : maxPointX;
  const minLabelY = labels.length
    ? Math.min(...labels.map((label) => label.rect.y))
    : minPointY;
  const maxLabelY = labels.length
    ? Math.max(
        ...labels.map(
          (label) => label.rect.y + label.rect.height,
        ),
      )
    : maxPointY;

  const minX = Math.min(minPointX, minLabelX) - padding;
  const maxX = Math.max(maxPointX, maxLabelX) + padding;
  const minY = Math.min(minPointY, minLabelY) - padding;
  const maxY = Math.max(maxPointY, maxLabelY) + padding;

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function SvgMap({ graph, layout, zoom = 1 }: SvgMapProps) {
  const visualScale = zoom > 1 ? 1 / Math.sqrt(zoom) : 1;
  const definedRings = layout.moscowRings ?? [];
  const ringSet = new Set(
    definedRings.flatMap((ring) => ring.nodes),
  );
  const geometricBundles = buildGeometricBundleMap(
    graph,
    layout.positions,
  );

  const routePaths: RenderedRoutePath[] = graph.lines.flatMap((line) =>
    line.paths.map((path, pathIndex) => {
      const points = offsetPathForLine(
        graph,
        path,
        layout.positions,
        line.id,
        12,
        geometricBundles,
      );

      return {
        lineId: line.id,
        lineColor: line.color,
        pathIndex,
        points,
        d: roundedPath(points, 16),
      };
    }),
  );

  const labelPlacements = buildLabelPlacements(
    graph,
    layout,
    visualScale,
  );
  const bounds = renderBounds(
    graph,
    layout,
    routePaths,
    labelPlacements,
  );

  return (
    <svg
      id="metro-map-svg"
      className="map-svg"
      viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
      data-layout-valid={layout.integrity.valid ? 'true' : 'false'}
      data-layout-route-count={layout.integrity.routeCount}
      data-layout-path-count={layout.integrity.pathCount}
      data-layout-segment-count={layout.integrity.segmentCount}
      data-detail-zoom={zoom}
      role="img"
      aria-label="Generated schematic metro map"
    >
      <rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        className="map-background"
      />

      {definedRings.length ? (
        <g className="ring-guide" aria-hidden="true">
          {definedRings.flatMap((ring) =>
            ring.nodes.map((nodeId, index) => {
              const nextId =
                ring.nodes[(index + 1) % ring.nodes.length];
              const a = layout.positions[nodeId];
              const b = layout.positions[nextId];
              return (
                <line
                  key={`${ring.id}-${nodeId}-${nextId}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                />
              );
            }),
          )}
        </g>
      ) : null}

      <g id="lines" data-route-count={graph.lines.length}>
        {graph.lines.map((line) => {
          const paths = routePaths.filter(
            (routePath) => routePath.lineId === line.id,
          );

          return (
            <g
              key={line.id}
              id={`route-${line.id}`}
              data-line-id={line.id}
              data-path-count={line.paths.length}
            >
              {paths.map((routePath) => (
                <path
                  key={`${line.id}-${routePath.pathIndex}`}
                  data-line-id={line.id}
                  data-path-index={routePath.pathIndex}
                  d={routePath.d}
                  fill="none"
                  stroke={routePath.lineColor}
                  strokeWidth={8 * visualScale}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>
          );
        })}
      </g>

      <g id="stations">
        {graph.nodes.map((node) => {
          const point = layout.positions[node.id];
          const isInterchange =
            node.stationIds.length > 1 ||
            nodeDegree(graph, node.id) > 2;

          return (
            <g
              key={node.id}
              transform={`translate(${point.x} ${point.y})`}
            >
              {isInterchange ? (
                <>
                  <circle
                    r={11 * visualScale}
                    className="station interchange-outer"
                  />
                  <circle
                    r={5 * visualScale}
                    className="station interchange-inner"
                  />
                </>
              ) : (
                <circle r={6 * visualScale} className="station station-normal" />
              )}
              {ringSet.has(node.id) ? (
                <circle r={15 * visualScale} className="ring-node-marker" />
              ) : null}
            </g>
          );
        })}
      </g>

      <g id="labels">
        {labelPlacements.map((label) => (
          <text
            key={label.nodeId}
            x={label.x}
            y={label.y}
            textAnchor={label.textAnchor}
            className="station-label"
            style={{
              fontSize: `${11.5 * visualScale}px`,
              strokeWidth: 3.5 * visualScale,
            }}
          >
            {label.text}
          </text>
        ))}
      </g>
    </svg>
  );
}
