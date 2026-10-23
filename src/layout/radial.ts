import { edgeKey, findSimpleCycles } from '../core/graph';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../core/projection';
import type { GraphModel, Point } from '../types';

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

function cycleScore(
  graph: GraphModel,
  geographic: Record<string, Point>,
  cycle: string[],
): number {
  const points = cycle.map((id) => geographic[id]);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const bboxArea = width * height;
  const fill = polygonArea(points) / bboxArea;
  const aspect = Math.min(width, height) / Math.max(width, height);

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

  const compositeBonus = routeIds.size > 1 ? Math.min(18, (routeIds.size - 1) * 8) : 0;

  return (
    cycle.length * 3.2 +
    fill * 18 +
    aspect * 14 +
    outwardConnections * 2.5 +
    compositeBonus
  );
}

export function findPrimaryRing(
  graph: GraphModel,
  geographic: Record<string, Point>,
): string[] | undefined {
  const cycles = findSimpleCycles(graph);
  return cycles
    .map((cycle) => ({ cycle, score: cycleScore(graph, geographic, cycle) }))
    .sort((a, b) => b.score - a.score)[0]?.cycle;
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
): { positions: Record<string, Point>; primaryRing?: string[] } {
  const detected = findPrimaryRing(graph, geographic);
  if (!detected?.length) {
    return { positions: layoutConcentric(graph, geographic) };
  }

  const center = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  const ringGeoCenter = {
    x: detected.reduce((sum, id) => sum + geographic[id].x, 0) / detected.length,
    y: detected.reduce((sum, id) => sum + geographic[id].y, 0) / detected.length,
  };
  const ring = orientRing(detected, geographic, ringGeoCenter);
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

  return { positions, primaryRing: ring };
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
