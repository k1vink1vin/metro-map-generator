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
}

interface RenderedRoutePath {
  lineId: string;
  lineColor: string;
  pathIndex: number;
  points: Point[];
  d: string;
}

function renderBounds(
  graph: GraphModel,
  layout: LayoutResult,
  routePaths: RenderedRoutePath[],
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
  const minX = Math.min(...points.map((point) => point.x)) - padding;
  const maxX = Math.max(...points.map((point) => point.x)) + padding;
  const minY = Math.min(...points.map((point) => point.y)) - padding;
  const maxY = Math.max(...points.map((point) => point.y)) + padding;

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function SvgMap({ graph, layout }: SvgMapProps) {
  const ringSet = new Set(layout.primaryRing ?? []);
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

  const bounds = renderBounds(graph, layout, routePaths);

  return (
    <svg
      id="metro-map-svg"
      className="map-svg"
      viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
      data-layout-valid={layout.integrity.valid ? 'true' : 'false'}
      data-layout-route-count={layout.integrity.routeCount}
      data-layout-path-count={layout.integrity.pathCount}
      data-layout-segment-count={layout.integrity.segmentCount}
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

      {layout.primaryRing?.length ? (
        <g className="ring-guide" aria-hidden="true">
          {layout.primaryRing.map((nodeId, index) => {
            const nextId =
              layout.primaryRing![(index + 1) % layout.primaryRing!.length];
            const a = layout.positions[nodeId];
            const b = layout.positions[nextId];
            return (
              <line
                key={`${nodeId}-${nextId}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}
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
                  strokeWidth={10}
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
                    r={11}
                    className="station interchange-outer"
                  />
                  <circle
                    r={5}
                    className="station interchange-inner"
                  />
                </>
              ) : (
                <circle r={6} className="station station-normal" />
              )}
              {ringSet.has(node.id) ? (
                <circle r={15} className="ring-node-marker" />
              ) : null}
            </g>
          );
        })}
      </g>

      <g id="labels">
        {graph.nodes.map((node) => {
          const point = layout.positions[node.id];
          return (
            <text
              key={node.id}
              x={point.x + 13}
              y={point.y - 11}
              className="station-label"
            >
              {node.name}
            </text>
          );
        })}
      </g>
    </svg>
  );
}
