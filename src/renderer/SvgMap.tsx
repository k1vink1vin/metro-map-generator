import type {
  GraphModel,
  GraphNode,
  LayoutResult,
  Point,
  StationVisualStyle,
} from '../types';
import {
  buildGeometricBundleMap,
  offsetPathForLine,
  roundedPath,
} from './geometry';

interface SvgMapProps {
  graph: GraphModel;
  layout: LayoutResult;
  zoom?: number;
  stationStyle?: StationVisualStyle;
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

function parseStationCode(stationId: string) {
  const match = stationId.trim().match(/^([A-Za-z]+)[-_ ]?(\d+[A-Za-z]?)$/);
  if (!match) {
    return { prefix: stationId.trim().toUpperCase(), number: '' };
  }
  return {
    prefix: match[1].toUpperCase(),
    number: match[2],
  };
}

function nodeLineColors(graph: GraphModel, nodeId: string): string[] {
  const colors: string[] = [];
  for (const line of graph.lines) {
    line.paths.forEach((path, pathIndex) => {
      if (!path.includes(nodeId)) return;
      const color = line.pathColors?.[pathIndex] ?? line.color;
      if (!colors.includes(color)) colors.push(color);
    });
  }
  return colors.length ? colors : ['#111827'];
}

function isInterchangeNode(
  graph: GraphModel,
  node: GraphNode,
): boolean {
  if (node.stationIds.length > 1) return true;

  const incidentLineIds = new Set<string>();
  for (const line of graph.lines) {
    if (line.paths.some((path) => path.includes(node.id))) {
      incidentLineIds.add(line.id);
    }
  }

  return incidentLineIds.size > 1;
}

function stationCodeColor(
  graph: GraphModel,
  nodeId: string,
  stationId: string,
): string {
  const { prefix } = parseStationCode(stationId);
  const candidates: Array<{ score: number; color: string }> = [];

  for (const line of graph.lines) {
    line.paths.forEach((path, pathIndex) => {
      if (!path.includes(nodeId)) return;
      const lineToken = line.id.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const nameToken = line.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
      let score = 0;
      if (lineToken.endsWith(prefix)) score += 6;
      if (lineToken.includes(prefix)) score += 3;
      if (nameToken.includes(prefix)) score += 1;

      candidates.push({
        score,
        color: line.pathColors?.[pathIndex] ?? line.color,
      });
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.color ?? '#111827';
}

function stationMarkerRadius(
  node: GraphNode,
  graph: GraphModel,
  stationStyle: StationVisualStyle,
): number {
  const isInterchange = isInterchangeNode(graph, node);

  if (stationStyle === 'tokyo') {
    const count = Math.max(1, node.stationIds.length);
    return Math.max(16, (count * 22 + (count - 1) * 2) / 2);
  }

  if (stationStyle === 'taipei') {
    const count = Math.max(1, node.stationIds.length);
    return isInterchange
      ? Math.max(14, (count * 16 + (count - 1) * 2) / 2)
      : 12;
  }

  return isInterchange ? 12 : 7;
}

function renderTokyoStation(
  graph: GraphModel,
  node: GraphNode,
  visualScale: number,
) {
  const ids = node.stationIds.length ? node.stationIds : [node.id];
  const width = 22 * visualScale;
  const height = 31 * visualScale;
  const gap = 2 * visualScale;
  const totalWidth = ids.length * width + (ids.length - 1) * gap;
  const startX = -totalWidth / 2;

  return (
    <g className="station-style-tokyo">
      {ids.map((stationId, index) => {
        const color = stationCodeColor(graph, node.id, stationId);
        const code = parseStationCode(stationId);
        const x = startX + index * (width + gap);

        return (
          <g key={stationId}>
            <rect
              x={x}
              y={-height / 2}
              width={width}
              height={height}
              rx={5.5 * visualScale}
              className="tokyo-badge-shell"
              style={{ strokeWidth: 1.9 * visualScale }}
            />
            <rect
              x={x + 2.5 * visualScale}
              y={-height / 2 + 2.5 * visualScale}
              width={width - 5 * visualScale}
              height={height - 5 * visualScale}
              rx={3.8 * visualScale}
              className="tokyo-badge-inner"
              style={{
                stroke: color,
                strokeWidth: 2.5 * visualScale,
              }}
            />
            <text
              x={x + width / 2}
              y={-2.5 * visualScale}
              textAnchor="middle"
              className="station-code-prefix"
              style={{ fontSize: 7.2 * visualScale }}
            >
              {code.prefix}
            </text>
            <text
              x={x + width / 2}
              y={8.8 * visualScale}
              textAnchor="middle"
              className="station-code-number"
              style={{ fontSize: 9.8 * visualScale }}
            >
              {code.number}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function renderTaipeiStation(
  graph: GraphModel,
  node: GraphNode,
  visualScale: number,
) {
  const ids = node.stationIds.length ? node.stationIds : [node.id];
  const badgeWidth = 16 * visualScale;
  const badgeHeight = 24 * visualScale;
  const gap = 2 * visualScale;
  const totalWidth =
    ids.length * badgeWidth + (ids.length - 1) * gap;
  const startX = -totalWidth / 2;
  const isInterchange = isInterchangeNode(graph, node);

  return (
    <g className="station-style-taipei">
      {isInterchange ? (
        <rect
          x={startX - 4 * visualScale}
          y={-badgeHeight / 2 - 4 * visualScale}
          width={totalWidth + 8 * visualScale}
          height={badgeHeight + 8 * visualScale}
          rx={7 * visualScale}
          className="taipei-transfer-shell"
          style={{ strokeWidth: 2.2 * visualScale }}
        />
      ) : null}
      {ids.map((stationId, index) => {
        const color = stationCodeColor(graph, node.id, stationId);
        const code = parseStationCode(stationId);
        const x = startX + index * (badgeWidth + gap);

        return (
          <g key={stationId}>
            <rect
              x={x}
              y={-badgeHeight / 2}
              width={badgeWidth}
              height={badgeHeight}
              rx={4 * visualScale}
              className="taipei-code-badge"
              style={{
                stroke: color,
                strokeWidth: 2.2 * visualScale,
              }}
            />
            <text
              x={x + badgeWidth / 2}
              y={-2.5 * visualScale}
              textAnchor="middle"
              className="station-code-prefix"
              style={{ fontSize: 6.4 * visualScale }}
            >
              {code.prefix}
            </text>
            <text
              x={x + badgeWidth / 2}
              y={8.5 * visualScale}
              textAnchor="middle"
              className="station-code-number"
              style={{ fontSize: 7.8 * visualScale }}
            >
              {code.number}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function renderMoscowStation(
  graph: GraphModel,
  node: GraphNode,
  visualScale: number,
) {
  const colors = nodeLineColors(graph, node.id).slice(0, 3);
  const isInterchange = isInterchangeNode(graph, node);

  if (!isInterchange) {
    return (
      <circle
        r={5.5 * visualScale}
        className="moscow-station"
        style={{
          stroke: colors[0],
          strokeWidth: 2.6 * visualScale,
        }}
      />
    );
  }

  const radii = [10.5, 7.4, 4.5];
  return (
    <g className="station-style-moscow">
      <circle
        r={11.5 * visualScale}
        className="moscow-transfer-base"
        style={{ strokeWidth: 1.8 * visualScale }}
      />
      {colors.map((color, index) => (
        <circle
          key={color}
          r={radii[index] * visualScale}
          className="moscow-transfer-ring"
          style={{
            stroke: color,
            strokeWidth: 2.3 * visualScale,
          }}
        />
      ))}
    </g>
  );
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
  stationStyle: StationVisualStyle,
  visualScale = 1,
): LabelPlacement[] {
  const nodeObstacles = graph.nodes.map((node) => {
    const point = layout.positions[node.id];
    const radius =
      stationMarkerRadius(node, graph, stationStyle) * visualScale;

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
    const markerRadius =
      stationMarkerRadius(node, graph, stationStyle) * visualScale;
    const near = markerRadius + 6 * s;
    const far = markerRadius + 18 * s;
    const candidates: Array<{
      x: number;
      y: number;
      anchor: LabelPlacement['textAnchor'];
      distancePenalty: number;
    }> = [
      { x: point.x + near, y: point.y - 8 * s, anchor: 'start', distancePenalty: 0 },
      { x: point.x + near, y: point.y + 18 * s, anchor: 'start', distancePenalty: 1 },
      { x: point.x - near, y: point.y - 8 * s, anchor: 'end', distancePenalty: 1 },
      { x: point.x - near, y: point.y + 18 * s, anchor: 'end', distancePenalty: 2 },
      { x: point.x, y: point.y - near, anchor: 'middle', distancePenalty: 2 },
      { x: point.x, y: point.y + near + 11 * s, anchor: 'middle', distancePenalty: 3 },
      { x: point.x + far, y: point.y - 18 * s, anchor: 'start', distancePenalty: 4 },
      { x: point.x - far, y: point.y - 18 * s, anchor: 'end', distancePenalty: 4 },
      { x: point.x + far, y: point.y + 28 * s, anchor: 'start', distancePenalty: 5 },
      { x: point.x - far, y: point.y + 28 * s, anchor: 'end', distancePenalty: 5 },
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

export function SvgMap({
  graph,
  layout,
  zoom = 1,
  stationStyle = 'taipei',
}: SvgMapProps) {
  const visualScale = zoom > 1 ? 1 / Math.sqrt(zoom) : 1;
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
        lineColor:
          line.pathColors?.[pathIndex] ??
          line.color,
        pathIndex,
        points,
        d: roundedPath(points, layout.style === 'moscow' ? 22 : 16),
      };
    }),
  );

  const labelPlacements = buildLabelPlacements(
    graph,
    layout,
    stationStyle,
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
      data-station-style={stationStyle}
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
                  data-path-id={line.pathIds?.[routePath.pathIndex] ?? routePath.pathIndex}
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

      <g id="stations" data-station-style={stationStyle}>
        {graph.nodes.map((node) => {
          const point = layout.positions[node.id];

          return (
            <g
              key={node.id}
              transform={`translate(${point.x} ${point.y})`}
              data-node-id={node.id}
            >
              {stationStyle === 'tokyo'
                ? renderTokyoStation(graph, node, visualScale)
                : stationStyle === 'moscow'
                  ? renderMoscowStation(graph, node, visualScale)
                  : renderTaipeiStation(graph, node, visualScale)}
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
              fontSize: `${
                (stationStyle === 'moscow'
                  ? 12.4
                  : stationStyle === 'tokyo'
                    ? 12
                    : 11.5) * visualScale
              }px`,
              strokeWidth:
                (stationStyle === 'moscow' ? 3 : 3.5) * visualScale,
            }}
          >
            {label.text}
          </text>
        ))}
      </g>
    </svg>
  );
}
