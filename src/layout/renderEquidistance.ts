import { edgeKey } from '../core/graph';
import type { GraphModel, LayoutResult, Point } from '../types';
import {
  buildRenderedRoutePaths,
  sampledSelfCrossings,
} from '../renderer/routeGeometry';
import {
  buildGeometricBundleMap,
  offsetPathForLine,
} from '../renderer/geometry';

const distance = (a: Point, b: Point) =>
  Math.hypot(b.x - a.x, b.y - a.y);

function isOrdinaryNode(
  graph: GraphModel,
  layout: LayoutResult,
  nodeId: string,
  ringNodes: ReadonlySet<string>,
): boolean {
  if (ringNodes.has(nodeId)) return false;
  const node = graph.nodeById.get(nodeId);
  if (!node) return false;
  if ((graph.adjacency.get(nodeId)?.length ?? 0) !== 2) return false;
  if (node.stationIds.length !== 1) return false;

  if (
    layout.style === 'concentric' &&
    layout.radialCenter &&
    distance(layout.positions[nodeId], layout.radialCenter) < 1e-6
  ) {
    return false;
  }

  const incidentLines = new Set<string>();
  for (const neighbor of graph.adjacency.get(nodeId) ?? []) {
    const edge = graph.edgeByKey.get(edgeKey(nodeId, neighbor));
    for (const lineId of edge?.lineIds ?? []) incidentLines.add(lineId);
  }
  return incidentLines.size === 1;
}

function cumulativeLengths(points: Point[]): number[] {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        distance(points[index - 1], points[index]),
    );
  }
  return cumulative;
}

function pointAtDistance(
  points: Point[],
  cumulative: number[],
  target: number,
): Point {
  if (!points.length) return { x: 0, y: 0 };
  if (points.length === 1 || target <= 0) return { ...points[0] };
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (target >= total) return { ...points[points.length - 1] };

  for (let index = 0; index < cumulative.length - 1; index += 1) {
    if (target > cumulative[index + 1]) continue;
    const span = cumulative[index + 1] - cumulative[index];
    const t = span < 1e-9
      ? 0
      : (target - cumulative[index]) / span;
    return {
      x:
        points[index].x +
        (points[index + 1].x - points[index].x) * t,
      y:
        points[index].y +
        (points[index + 1].y - points[index].y) * t,
    };
  }
  return { ...points[points.length - 1] };
}

function findSequentialSampleIndices(
  samples: Point[],
  anchors: Point[],
): number[] | undefined {
  const result: number[] = [];
  let cursor = 0;

  for (const anchor of anchors) {
    let found = -1;
    for (let index = cursor; index < samples.length; index += 1) {
      if (distance(samples[index], anchor) < 1e-5) {
        found = index;
        break;
      }
    }
    if (found < 0) return undefined;
    result.push(found);
    cursor = found;
  }
  return result;
}

function totalRenderedSelfCrossings(
  graph: GraphModel,
  layout: LayoutResult,
): number {
  return buildRenderedRoutePaths(graph, layout).reduce(
    (sum, route) => sum + sampledSelfCrossings(route.samples),
    0,
  );
}

/**
 * Repositions only ordinary, single-line stations at equal cumulative
 * distances along the route geometry that is actually rendered.
 *
 * This is intentionally a final display-space invariant. Earlier layout
 * solvers can preserve topology and angular grammar yet still cause the hard
 * renderer to insert unequal 45°/60° detours. Sampling the already-legal
 * rendered corridor removes that last source of uneven station rhythm without
 * moving transfers, branch nodes, Moscow ring stations or the concentric
 * centre.
 */
export function equalizeRenderedStationRhythm(
  graph: GraphModel,
  layout: LayoutResult,
): LayoutResult {
  if (layout.style === 'geographic') return layout;

  const ringNodes = new Set(
    layout.style === 'moscow'
      ? layout.moscowRings?.flatMap((ring) => ring.nodes) ?? []
      : [],
  );
  const bundles = buildGeometricBundleMap(graph, layout.positions);
  const rendered = buildRenderedRoutePaths(graph, layout);
  const proposals = new Map<string, Point[]>();

  for (const route of rendered) {
    const line = graph.lines.find((candidate) => candidate.id === route.lineId);
    const path = line?.paths[route.pathIndex];
    if (!line || !path || path.length < 3) continue;

    const routeAnchors = offsetPathForLine(
      graph,
      path,
      layout.positions,
      line.id,
      12,
      bundles,
    ).map((point, index) =>
      ringNodes.has(path[index])
        ? layout.positions[path[index]]
        : point,
    );

    const occurrenceIndices = findSequentialSampleIndices(
      route.samples,
      routeAnchors,
    );
    if (!occurrenceIndices) continue;

    const structural = new Set<number>([0, path.length - 1]);
    path.forEach((nodeId, index) => {
      if (!isOrdinaryNode(graph, layout, nodeId, ringNodes)) {
        structural.add(index);
      }
    });
    const sorted = [...structural].sort((a, b) => a - b);

    for (let section = 0; section < sorted.length - 1; section += 1) {
      const startIndex = sorted[section];
      const endIndex = sorted[section + 1];
      const segmentCount = endIndex - startIndex;
      if (segmentCount < 2) continue;

      const movingIds = path.slice(startIndex + 1, endIndex);
      if (
        !movingIds.every(
          (id) => isOrdinaryNode(graph, layout, id, ringNodes),
        )
      ) {
        continue;
      }

      // Do not move a marker into a visual lane offset. Multi-line topology
      // nodes are already structural; this additionally protects accidental
      // geometric bundles of unrelated routes.
      if (
        movingIds.some((id, localIndex) => {
          const pathIndex = startIndex + localIndex + 1;
          return (
            distance(
              routeAnchors[pathIndex],
              layout.positions[id],
            ) > 1e-5
          );
        })
      ) {
        continue;
      }

      const sampleStart = occurrenceIndices[startIndex];
      const sampleEnd = occurrenceIndices[endIndex];
      if (sampleEnd <= sampleStart) continue;
      const sectionSamples = route.samples.slice(
        sampleStart,
        sampleEnd + 1,
      );
      const cumulative = cumulativeLengths(sectionSamples);
      const total = cumulative[cumulative.length - 1] ?? 0;
      if (total < 1e-6) continue;

      movingIds.forEach((nodeId, localIndex) => {
        const target = pointAtDistance(
          sectionSamples,
          cumulative,
          (total * (localIndex + 1)) / segmentCount,
        );
        const list = proposals.get(nodeId) ?? [];
        list.push(target);
        proposals.set(nodeId, list);
      });
    }
  }

  const nextPositions = Object.fromEntries(
    Object.entries(layout.positions).map(([id, point]) => [
      id,
      { ...point },
    ]),
  );

  let moved = 0;
  for (const [nodeId, candidates] of proposals) {
    if (!candidates.length) continue;
    const first = candidates[0];
    // Repeated trunk occurrences should propose the same visual point. When
    // route occurrences disagree, keep the shared station fixed.
    if (
      !candidates.every(
        (point) => distance(point, first) < 0.5,
      )
    ) {
      continue;
    }
    nextPositions[nodeId] = {
      x:
        candidates.reduce((sum, point) => sum + point.x, 0) /
        candidates.length,
      y:
        candidates.reduce((sum, point) => sum + point.y, 0) /
        candidates.length,
    };
    if (distance(nextPositions[nodeId], layout.positions[nodeId]) > 1e-5) {
      moved += 1;
    }
  }

  if (!moved) return layout;

  const candidate: LayoutResult = {
    ...layout,
    positions: nextPositions,
  };
  const beforeCrossings = totalRenderedSelfCrossings(graph, layout);
  const afterCrossings = totalRenderedSelfCrossings(graph, candidate);

  // Never pay for equal spacing by folding a route over itself.
  if (afterCrossings > beforeCrossings) return layout;
  return candidate;
}
