import type { GraphModel, LayoutResult } from '../types';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../core/projection';
import { nodeDegree } from '../core/graph';
import { offsetPathForLine, roundedPath } from './geometry';

interface SvgMapProps {
  graph: GraphModel;
  layout: LayoutResult;
}

export function SvgMap({ graph, layout }: SvgMapProps) {
  const ringSet = new Set(layout.primaryRing ?? []);

  return (
    <svg
      id="metro-map-svg"
      className="map-svg"
      viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
      role="img"
      aria-label="Generated schematic metro map"
    >
      <rect width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="map-background" />

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
        {graph.lines.map((line) => (
          <g
            key={line.id}
            id={`route-${line.id}`}
            data-line-id={line.id}
            data-path-count={line.paths.length}
          >
            {line.paths.map((path, pathIndex) => {
              const points = offsetPathForLine(
                graph,
                path,
                layout.positions,
                line.id,
                9,
              );
              return (
                <path
                  key={`${line.id}-${pathIndex}`}
                  data-line-id={line.id}
                  data-path-index={pathIndex}
                  d={roundedPath(points, 16)}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={10}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}
          </g>
        ))}
      </g>

      <g id="stations">
        {graph.nodes.map((node) => {
          const point = layout.positions[node.id];
          const isInterchange = node.stationIds.length > 1 || nodeDegree(graph, node.id) > 2;
          return (
            <g key={node.id} transform={`translate(${point.x} ${point.y})`}>
              {isInterchange ? (
                <>
                  <circle r={11} className="station interchange-outer" />
                  <circle r={5} className="station interchange-inner" />
                </>
              ) : (
                <circle r={6} className="station station-normal" />
              )}
              {ringSet.has(node.id) ? <circle r={15} className="ring-node-marker" /> : null}
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
