import { edgeKey, findSimpleCycles } from '../core/graph';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../core/projection';
import type { GraphModel, Point, RingCandidateDiagnostic, ValidatedMoscowRing } from '../types';

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

function cycleCandidateId(cycle: string[]): string {
  const variants: string[] = [];
  for (const candidate of [cycle, [...cycle].reverse()]) {
    for (let i = 0; i < candidate.length; i += 1) {
      variants.push([...candidate.slice(i), ...candidate.slice(0, i)].join('>'));
    }
  }
  return variants.sort()[0];
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
    id: cycleCandidateId(cycle),
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

function signedAngleDelta(from: number, to: number): number {
  const tau = Math.PI * 2;
  let diff = ((to - from + Math.PI) % tau + tau) % tau - Math.PI;
  if (diff <= -Math.PI) diff += tau;
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
  definedRings: ValidatedMoscowRing[] = [],
): {
  positions: Record<string, Point>;
  moscowRings: ValidatedMoscowRing[];
} {
  if (!definedRings.length) {
    return {
      positions: Object.fromEntries(
        Object.entries(geographic).map(([id, point]) => [id, { ...point }]),
      ),
      moscowRings: [],
    };
  }

  const center = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  const geoCenter = {
    x:
      graph.nodes.reduce((sum, node) => sum + geographic[node.id].x, 0) /
      graph.nodes.length,
    y:
      graph.nodes.reduce((sum, node) => sum + geographic[node.id].y, 0) /
      graph.nodes.length,
  };

  const radii =
    definedRings.length === 1
      ? [310]
      : definedRings.length === 2
        ? [220, 390]
        : [175, 315, 455];

  const positions: Record<string, Point> = {};
  const ringNodeSet = new Set<string>();

  const ringInfos = definedRings.map((definition, ringIndex) => {
    const ring = orientRing(definition.nodes, geographic, geoCenter);
    const radius = radii[ringIndex];

    const slot = (Math.PI * 2) / ring.length;
    ring.forEach((id, index) => {
      ringNodeSet.add(id);
      const equalAngle = -Math.PI / 2 + slot * index;
      const geoAngle = Math.atan2(
        geographic[id].y - geoCenter.y,
        geographic[id].x - geoCenter.x,
      );
      const geoAdjustment = clamp(
        signedAngleDelta(equalAngle, geoAngle),
        -slot * 0.32,
        slot * 0.32,
      );
      const angle = equalAngle + geoAdjustment;

      positions[id] = {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      };
    });

    const geoRadius =
      ring.reduce(
        (sum, id) =>
          sum +
          Math.hypot(
            geographic[id].x - geoCenter.x,
            geographic[id].y - geoCenter.y,
          ),
        0,
      ) / ring.length;

    return {
      definition: { ...definition, nodes: ring },
      radius,
      geoRadius,
    };
  });

  const orderedInfos = [...ringInfos].sort(
    (a, b) => a.geoRadius - b.geoRadius,
  );
  const allGeoRadii = graph.nodes.map((node) =>
    Math.hypot(
      geographic[node.id].x - geoCenter.x,
      geographic[node.id].y - geoCenter.y,
    ),
  );
  const maxGeoRadius = Math.max(1, ...allGeoRadii);
  const outerTargetRadius =
    orderedInfos[orderedInfos.length - 1].radius + 340;

  const mapRadius = (geoRadius: number): number => {
    const first = orderedInfos[0];
    if (geoRadius <= first.geoRadius) {
      const ratio = geoRadius / Math.max(1, first.geoRadius);
      return Math.pow(ratio, 0.82) * (first.radius - 54);
    }

    for (let index = 0; index < orderedInfos.length - 1; index += 1) {
      const inner = orderedInfos[index];
      const outer = orderedInfos[index + 1];
      if (geoRadius <= outer.geoRadius) {
        const t =
          (geoRadius - inner.geoRadius) /
          Math.max(1, outer.geoRadius - inner.geoRadius);
        return (
          inner.radius +
          54 +
          t * Math.max(1, outer.radius - inner.radius - 108)
        );
      }
    }

    const last = orderedInfos[orderedInfos.length - 1];
    const t =
      (geoRadius - last.geoRadius) /
      Math.max(1, maxGeoRadius - last.geoRadius);
    return last.radius + 54 + t * (outerTargetRadius - last.radius - 54);
  };

  for (const node of graph.nodes) {
    if (ringNodeSet.has(node.id)) continue;

    const geo = geographic[node.id];
    const dx = geo.x - geoCenter.x;
    const dy = geo.y - geoCenter.y;
    const geoRadius = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const radius = mapRadius(geoRadius);

    positions[node.id] = {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  }

  return {
    positions,
    moscowRings: ringInfos.map((info) => info.definition),
  };
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

  const geoRadii = graph.nodes.map((node) =>
    Math.hypot(
      geographic[node.id].x - geoCenter.x,
      geographic[node.id].y - geoCenter.y,
    ),
  );
  const maxGeoRadius = Math.max(1, ...geoRadii);
  const ringCount = clamp(
    Math.round(Math.sqrt(graph.nodes.length / 2)),
    4,
    8,
  );
  const maxLayoutRadius = 360;
  const ringSpacing = maxLayoutRadius / ringCount;
  const snapWeight = 0.34;

  return Object.fromEntries(
    graph.nodes.map((node) => {
      const geo = geographic[node.id];
      const angle = Math.atan2(
        geo.y - geoCenter.y,
        geo.x - geoCenter.x,
      );
      const geoRadius = Math.hypot(
        geo.x - geoCenter.x,
        geo.y - geoCenter.y,
      );
      const continuousRadius =
        (geoRadius / maxGeoRadius) * maxLayoutRadius;
      const snappedRadius =
        Math.max(
          ringSpacing,
          Math.round(continuousRadius / ringSpacing) * ringSpacing,
        );
      const layoutRadius =
        continuousRadius * (1 - snapWeight) +
        snappedRadius * snapWeight;

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
