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

function smoothMoscowCorridors(
  graph: GraphModel,
  positions: Record<string, Point>,
  ringNodes: Set<string>,
): Record<string, Point> {
  let current = Object.fromEntries(
    Object.entries(positions).map(([id, point]) => [id, { ...point }]),
  );

  const protectedNodes = new Set<string>(ringNodes);
  for (const node of graph.nodes) {
    const incidentLines = new Set<string>();
    for (const neighbor of graph.adjacency.get(node.id) ?? []) {
      const edge = graph.edgeByKey.get(edgeKey(node.id, neighbor));
      for (const lineId of edge?.lineIds ?? []) {
        incidentLines.add(lineId);
      }
    }

    if (
      (graph.adjacency.get(node.id)?.length ?? 0) !== 2 ||
      node.stationIds.length > 1 ||
      incidentLines.size > 1
    ) {
      protectedNodes.add(node.id);
    }
  }

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const next = Object.fromEntries(
      Object.entries(current).map(([id, point]) => [id, { ...point }]),
    );

    for (const node of graph.nodes) {
      if (protectedNodes.has(node.id)) continue;

      const neighbors = graph.adjacency.get(node.id) ?? [];
      if (neighbors.length !== 2) continue;

      const previous = current[neighbors[0]];
      const point = current[node.id];
      const following = current[neighbors[1]];
      if (!previous || !point || !following) continue;

      const inVector = {
        x: point.x - previous.x,
        y: point.y - previous.y,
      };
      const outVector = {
        x: following.x - point.x,
        y: following.y - point.y,
      };
      const inLength = Math.hypot(inVector.x, inVector.y);
      const outLength = Math.hypot(outVector.x, outVector.y);
      if (inLength < 1 || outLength < 1) continue;

      const cosine = clamp(
        (inVector.x * outVector.x + inVector.y * outVector.y) /
          (inLength * outLength),
        -1,
        1,
      );
      const turn = Math.acos(cosine);

      // Do not disturb already-straight corridors. Only remove visible
      // doglegs / alternating bends on ordinary intermediate stations.
      if (turn < (22 * Math.PI) / 180) continue;

      const midpoint = {
        x: (previous.x + following.x) / 2,
        y: (previous.y + following.y) / 2,
      };
      const dx = midpoint.x - point.x;
      const dy = midpoint.y - point.y;
      const shiftLength = Math.hypot(dx, dy);
      if (shiftLength < 1) continue;

      const maxShift = Math.min(inLength, outLength) * 0.26;
      const applied = Math.min(shiftLength * 0.66, maxShift);
      const scale = applied / shiftLength;

      next[node.id] = {
        x: point.x + dx * scale,
        y: point.y + dy * scale,
      };
    }

    current = next;
  }

  // A second pass specifically removes S-shaped A-B-C-D doglegs. These are
  // visually distracting on passenger maps because the line changes side
  // twice within only a few stations.
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const next = Object.fromEntries(
      Object.entries(current).map(([id, point]) => [id, { ...point }]),
    );

    for (const line of graph.lines) {
      for (const path of line.paths) {
        for (let index = 0; index < path.length - 3; index += 1) {
          const ids = path.slice(index, index + 4);
          const [aId, bId, cId, dId] = ids;
          if (
            protectedNodes.has(bId) ||
            protectedNodes.has(cId)
          ) {
            continue;
          }

          const a = current[aId];
          const b = current[bId];
          const c = current[cId];
          const d = current[dId];
          if (!a || !b || !c || !d) continue;

          const signedTurn = (p0: Point, p1: Point, p2: Point) => {
            const first = Math.atan2(p1.y - p0.y, p1.x - p0.x);
            const second = Math.atan2(p2.y - p1.y, p2.x - p1.x);
            let delta = second - first;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            return delta;
          };

          const firstTurn = signedTurn(a, b, c);
          const secondTurn = signedTurn(b, c, d);
          const strong =
            Math.abs(firstTurn) > (24 * Math.PI) / 180 &&
            Math.abs(secondTurn) > (24 * Math.PI) / 180;
          const alternating =
            Math.sign(firstTurn) !== Math.sign(secondTurn);

          if (!strong || !alternating) continue;

          const targetB = {
            x: a.x + (d.x - a.x) / 3,
            y: a.y + (d.y - a.y) / 3,
          };
          const targetC = {
            x: a.x + ((d.x - a.x) * 2) / 3,
            y: a.y + ((d.y - a.y) * 2) / 3,
          };

          const moveToward = (
            point: Point,
            target: Point,
            localLength: number,
          ): Point => {
            const dx = target.x - point.x;
            const dy = target.y - point.y;
            const length = Math.hypot(dx, dy);
            if (length < 1) return { ...point };
            const applied = Math.min(length * 0.78, localLength * 0.3);
            return {
              x: point.x + (dx / length) * applied,
              y: point.y + (dy / length) * applied,
            };
          };

          const bLocal = Math.min(
            Math.hypot(b.x - a.x, b.y - a.y),
            Math.hypot(c.x - b.x, c.y - b.y),
          );
          const cLocal = Math.min(
            Math.hypot(c.x - b.x, c.y - b.y),
            Math.hypot(d.x - c.x, d.y - c.y),
          );

          next[bId] = moveToward(b, targetB, bLocal);
          next[cId] = moveToward(c, targetC, cLocal);
        }
      }
    }

    current = next;
  }

  // Terminal A-B-C hooks need a separate rule: they do not form an
  // alternating four-station dogleg, so the previous pass cannot see them.
  // Keep the terminal and all protected topology nodes fixed; only pull the
  // ordinary middle station toward the terminal chord.
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const next = Object.fromEntries(
      Object.entries(current).map(([id, point]) => [id, { ...point }]),
    );

    const relaxTerminalTriplet = (
      aId: string,
      bId: string,
      cId: string,
    ) => {
      if ((graph.adjacency.get(cId)?.length ?? 0) > 1) return;

      const a = current[aId];
      const b = current[bId];
      const c = current[cId];
      if (!a || !b || !c) return;

      const first = Math.atan2(b.y - a.y, b.x - a.x);
      const second = Math.atan2(c.y - b.y, c.x - b.x);
      let turn = second - first;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;

      if (Math.abs(turn) < (20 * Math.PI) / 180) return;

      const bDegree = graph.adjacency.get(bId)?.length ?? 0;
      const bIsFixedHub =
        ringNodes.has(bId) ||
        bDegree > 2;

      if (bIsFixedHub) {
        // A Moscow ring / transfer node is structural and must stay fixed.
        // Instead, make the terminal extension leave the hub as a clean
        // continuation of the incoming corridor.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const incomingLength = Math.hypot(dx, dy);
        const terminalLength = Math.hypot(c.x - b.x, c.y - b.y);
        if (incomingLength < 1 || terminalLength < 1) return;

        const targetC = {
          x: b.x + (dx / incomingLength) * terminalLength,
          y: b.y + (dy / incomingLength) * terminalLength,
        };
        const blend = 0.88;
        next[cId] = {
          x: c.x * (1 - blend) + targetC.x * blend,
          y: c.y * (1 - blend) + targetC.y * blend,
        };
        return;
      }

      if (bDegree !== 2) return;

      const target = {
        x: (a.x + c.x) / 2,
        y: (a.y + c.y) / 2,
      };

      const blend = 0.84;
      next[bId] = {
        x: b.x * (1 - blend) + target.x * blend,
        y: b.y * (1 - blend) + target.y * blend,
      };
    };

    for (const line of graph.lines) {
      for (const path of line.paths) {
        if (path.length < 3) continue;

        relaxTerminalTriplet(path[2], path[1], path[0]);
        const last = path.length - 1;
        relaxTerminalTriplet(
          path[last - 2],
          path[last - 1],
          path[last],
        );
      }
    }

    current = next;
  }

  // Final corridor pass: Moscow-style maps look cleaner when an ordinary
  // degree-2 station does not create a one-off kink between two otherwise
  // coherent segments. This is intentionally stronger than the general
  // smoother above, but it still leaves rings, transfers and branch hubs
  // untouched.
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const next = Object.fromEntries(
      Object.entries(current).map(([id, point]) => [id, { ...point }]),
    );

    for (const line of graph.lines) {
      for (const path of line.paths) {
        for (let index = 1; index < path.length - 1; index += 1) {
          const aId = path[index - 1];
          const bId = path[index];
          const cId = path[index + 1];
          if (protectedNodes.has(bId)) continue;

          const a = current[aId];
          const b = current[bId];
          const c = current[cId];
          if (!a || !b || !c) continue;

          const first = Math.atan2(b.y - a.y, b.x - a.x);
          const second = Math.atan2(c.y - b.y, c.x - b.x);
          let turn = second - first;
          while (turn > Math.PI) turn -= Math.PI * 2;
          while (turn < -Math.PI) turn += Math.PI * 2;

          if (Math.abs(turn) < (18 * Math.PI) / 180) continue;

          const chord = {
            x: (a.x + c.x) / 2,
            y: (a.y + c.y) / 2,
          };
          const dx = chord.x - b.x;
          const dy = chord.y - b.y;
          const shift = Math.hypot(dx, dy);
          if (shift < 1) continue;

          const localLength = Math.min(
            Math.hypot(b.x - a.x, b.y - a.y),
            Math.hypot(c.x - b.x, c.y - b.y),
          );
          const applied = Math.min(shift * 0.86, localLength * 0.44);
          next[bId] = {
            x: b.x + (dx / shift) * applied,
            y: b.y + (dy / shift) * applied,
          };
        }
      }
    }

    current = next;
  }

  return current;
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
        -slot * 0.45,
        slot * 0.45,
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

  const smoothedPositions = smoothMoscowCorridors(
    graph,
    positions,
    ringNodeSet,
  );

  return {
    positions: smoothedPositions,
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
