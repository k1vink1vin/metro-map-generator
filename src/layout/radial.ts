import { edgeKey, findSimpleCycles } from '../core/graph';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../core/projection';
import type { GraphModel, Point, RingCandidateDiagnostic } from '../types';

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function networkBoundingArea(
  graph: GraphModel,
  geographic: Record<string, Point>,
): number {
  const points = graph.nodes.map((node) => geographic[node.id]);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return Math.max(1, (maxX - minX) * (maxY - minY));
}

function minimumLineSwitches(graph: GraphModel, cycle: string[]): number {
  const edgeOptions = cycle.map((a, index) => {
    const b = cycle[(index + 1) % cycle.length];
    return graph.edgeByKey.get(edgeKey(a, b))?.lineIds ?? [];
  });

  if (edgeOptions.some((options) => options.length === 0)) {
    return Number.POSITIVE_INFINITY;
  }

  let best = Number.POSITIVE_INFINITY;

  for (const startLine of edgeOptions[0]) {
    let costs = new Map<string, number>([[startLine, 0]]);

    for (let edgeIndex = 1; edgeIndex < edgeOptions.length; edgeIndex += 1) {
      const nextCosts = new Map<string, number>();

      for (const nextLine of edgeOptions[edgeIndex]) {
        let nextBest = Number.POSITIVE_INFINITY;
        for (const [previousLine, previousCost] of costs) {
          const cost = previousCost + (previousLine === nextLine ? 0 : 1);
          nextBest = Math.min(nextBest, cost);
        }
        nextCosts.set(nextLine, nextBest);
      }

      costs = nextCosts;
    }

    for (const [endLine, cost] of costs) {
      best = Math.min(best, cost + (endLine === startLine ? 0 : 1));
    }
  }

  return Number.isFinite(best) ? best : 0;
}

function radialConsistency(points: Point[]): number {
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  const radii = points.map((point) => Math.hypot(point.x - center.x, point.y - center.y));
  const mean = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  if (mean <= 1e-9) return 0;
  const variance =
    radii.reduce((sum, radius) => sum + (radius - mean) ** 2, 0) / radii.length;
  const deviation = Math.sqrt(variance);
  return clamp(1 - deviation / mean, 0, 1);
}

function scoreCycle(
  graph: GraphModel,
  geographic: Record<string, Point>,
  cycle: string[],
  networkArea: number,
): RingCandidateDiagnostic {
  const points = cycle.map((id) => geographic[id]);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const cycleArea = polygonArea(points);
  const shapeFill = clamp(cycleArea / (width * height), 0, 1);
  const aspectScore = Math.min(width, height) / Math.max(width, height);
  const areaCoverage = clamp(cycleArea / networkArea, 0, 1);
  const radial = radialConsistency(points);

  const routeIds = new Set<string>();
  let outwardConnections = 0;
  const cycleSet = new Set(cycle);

  for (let i = 0; i < cycle.length; i += 1) {
    const a = cycle[i];
    const b = cycle[(i + 1) % cycle.length];
    for (const lineId of graph.edgeByKey.get(edgeKey(a, b))?.lineIds ?? []) {
      routeIds.add(lineId);
    }
    outwardConnections += (graph.adjacency.get(a) ?? []).filter(
      (neighbor) => !cycleSet.has(neighbor),
    ).length;
  }

  const transferCount = minimumLineSwitches(graph, cycle);
  const nodeCoverage = cycle.length / Math.max(1, graph.nodes.length);
  const spokeScore = clamp(outwardConnections / Math.max(2, cycle.length / 2), 0, 1);
  const tinyLoopPenalty = areaCoverage < 0.025 ? (0.025 - areaCoverage) * 240 : 0;

  const score =
    Math.sqrt(areaCoverage) * 38 +
    shapeFill * 14 +
    aspectScore * 8 +
    radial * 12 +
    spokeScore * 18 +
    Math.min(nodeCoverage, 0.65) * 12 -
    transferCount * 2.5 -
    tinyLoopPenalty;

  return {
    nodes: cycle,
    score,
    routeIds: [...routeIds].sort(),
    transferCount,
    outwardConnections,
    areaCoverage,
    shapeFill,
    aspectScore,
    radialConsistency: radial,
  };
}

export function findRingCandidates(
  graph: GraphModel,
  geographic: Record<string, Point>,
): RingCandidateDiagnostic[] {
  const maxLength = Math.min(graph.nodes.length, 60);
  const cycles = findSimpleCycles(graph, maxLength, 1200);
  const networkArea = networkBoundingArea(graph, geographic);

  return cycles
    .map((cycle) => scoreCycle(graph, geographic, cycle, networkArea))
    .filter((candidate) => candidate.nodes.length >= 3)
    .sort((a, b) => b.score - a.score);
}

export function findPrimaryRing(
  graph: GraphModel,
  geographic: Record<string, Point>,
): RingCandidateDiagnostic | undefined {
  return findRingCandidates(graph, geographic)[0];
}

function angleDistance(a: number, b: number): number {
  const tau = Math.PI * 2;
  let diff = ((a - b) % tau + tau) % tau;
  if (diff > Math.PI) diff = tau - diff;
  return diff;
}

function orientRing(
  ring: string[],
  geographic: Record<string, Point>,
  center: Point,
): string[] {
  if (ring.length < 2) return ring;
  const targetAngles = Object.fromEntries(
    ring.map((id) => [
      id,
      Math.atan2(geographic[id].y - center.y, geographic[id].x - center.x),
    ]),
  );

  let best = ring;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidateBase of [ring, [...ring].reverse()]) {
    for (let shift = 0; shift < ring.length; shift += 1) {
      const candidate = [
        ...candidateBase.slice(shift),
        ...candidateBase.slice(0, shift),
      ];
      let score = 0;
      for (let i = 0; i < candidate.length; i += 1) {
        const layoutAngle = -Math.PI / 2 + (Math.PI * 2 * i) / candidate.length;
        score += angleDistance(layoutAngle, targetAngles[candidate[i]]);
      }
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  return best;
}

function multiSourceHopDistance(graph: GraphModel, sources: string[]): Map<string, number> {
  const result = new Map<string, number>();
  const queue = [...sources];
  for (const source of sources) result.set(source, 0);

  while (queue.length) {
    const current = queue.shift()!;
    const nextDistance = (result.get(current) ?? 0) + 1;
    for (const neighbor of graph.adjacency.get(current) ?? []) {
      if (result.has(neighbor)) continue;
      result.set(neighbor, nextDistance);
      queue.push(neighbor);
    }
  }
  return result;
}

export function layoutMoscow(
  graph: GraphModel,
  geographic: Record<string, Point>,
): {
  positions: Record<string, Point>;
  primaryRing?: string[];
  ringCandidates: RingCandidateDiagnostic[];
} {
  const candidates = findRingCandidates(graph, geographic);
  const detected = candidates[0];

  if (!detected?.nodes.length) {
    return {
      positions: layoutConcentric(graph, geographic),
      ringCandidates: candidates,
    };
  }

  const center = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  const ringGeoCenter = {
    x:
      detected.nodes.reduce((sum, id) => sum + geographic[id].x, 0) /
      detected.nodes.length,
    y:
      detected.nodes.reduce((sum, id) => sum + geographic[id].y, 0) /
      detected.nodes.length,
  };
  const ring = orientRing(detected.nodes, geographic, ringGeoCenter);
  const ringPoints = ring.map((id) => geographic[id]);
  const width =
    Math.max(...ringPoints.map((point) => point.x)) -
    Math.min(...ringPoints.map((point) => point.x));
  const height =
    Math.max(...ringPoints.map((point) => point.y)) -
    Math.min(...ringPoints.map((point) => point.y));
  const aspect = clamp(width / Math.max(1, height), 0.72, 1.65);
  const rx = aspect >= 1 ? 305 : 305 * aspect;
  const ry = aspect >= 1 ? 305 / aspect : 305;

  const positions: Record<string, Point> = {};
  ring.forEach((id, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / ring.length;
    positions[id] = {
      x: center.x + Math.cos(angle) * rx,
      y: center.y + Math.sin(angle) * ry,
    };
  });

  const hopDistance = multiSourceHopDistance(graph, ring);
  const ringGeoRadius =
    ring.reduce(
      (sum, id) =>
        sum +
        Math.hypot(
          geographic[id].x - ringGeoCenter.x,
          geographic[id].y - ringGeoCenter.y,
        ),
      0,
    ) / ring.length;
  const baseRadius = (rx + ry) / 2;

  for (const node of graph.nodes) {
    if (positions[node.id]) continue;
    const geo = geographic[node.id];
    const angle = Math.atan2(geo.y - ringGeoCenter.y, geo.x - ringGeoCenter.x);
    const geoRadius = Math.hypot(
      geo.x - ringGeoCenter.x,
      geo.y - ringGeoCenter.y,
    );
    const hop = hopDistance.get(node.id);

    if (hop == null) {
      positions[node.id] = { ...geo };
      continue;
    }

    const outside = geoRadius >= ringGeoRadius * 0.88;
    const radius = clamp(
      baseRadius + (outside ? 1 : -1) * hop * 68,
      58,
      455,
    );
    const ellipseX = rx / baseRadius;
    const ellipseY = ry / baseRadius;

    positions[node.id] = {
      x: center.x + Math.cos(angle) * radius * ellipseX,
      y: center.y + Math.sin(angle) * radius * ellipseY,
    };
  }

  return { positions, primaryRing: ring, ringCandidates: candidates };
}

export function layoutConcentric(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  const center = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  const geoCenter = {
    x:
      graph.nodes.reduce((sum, node) => sum + geographic[node.id].x, 0) /
      graph.nodes.length,
    y:
      graph.nodes.reduce((sum, node) => sum + geographic[node.id].y, 0) /
      graph.nodes.length,
  };

  const radii = graph.nodes.map((node) =>
    Math.hypot(
      geographic[node.id].x - geoCenter.x,
      geographic[node.id].y - geoCenter.y,
    ),
  );
  const maxRadius = Math.max(1, ...radii);
  const ringCount = clamp(Math.round(Math.sqrt(graph.nodes.length)), 3, 6);
  const maxLayoutRadius = 300;

  return Object.fromEntries(
    graph.nodes.map((node) => {
      const geo = geographic[node.id];
      const angle = Math.atan2(geo.y - geoCenter.y, geo.x - geoCenter.x);
      const radius = Math.hypot(geo.x - geoCenter.x, geo.y - geoCenter.y);
      const ringIndex = clamp(
        Math.max(1, Math.round((radius / maxRadius) * ringCount)),
        1,
        ringCount,
      );
      const layoutRadius = (ringIndex / ringCount) * maxLayoutRadius;
      return [
        node.id,
        {
          x: center.x + Math.cos(angle) * layoutRadius,
          y: center.y + Math.sin(angle) * layoutRadius,
        },
      ];
    }),
  );
}
