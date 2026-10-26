import { edgeKey, findSimpleCycles } from '../core/graph';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../core/projection';
import type { GraphModel, Point, RingCandidateDiagnostic, ValidatedMoscowRing } from '../types';
import { relaxPathKinksSafely } from './common';

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

  // Straighten complete ordinary corridor runs between structural anchors.
  // Local smoothing alone can leave an alternating zig-zag on long lines
  // (notably the Wenhu/Brown corridor). Interpolating the ordinary stations
  // between protected anchors yields the clean Moscow-map corridor expected
  // by passengers while preserving rings, transfers, branches and terminals.
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const next = Object.fromEntries(
      Object.entries(current).map(([id, point]) => [id, { ...point }]),
    );

    for (const line of graph.lines) {
      for (const path of line.paths) {
        if (path.length < 3) continue;

        const anchors = new Set<number>([0, path.length - 1]);
        path.forEach((nodeId, index) => {
          if (protectedNodes.has(nodeId)) anchors.add(index);
        });
        const anchorIndices = [...anchors].sort((a, b) => a - b);

        for (let anchorIndex = 0; anchorIndex < anchorIndices.length - 1; anchorIndex += 1) {
          const startIndex = anchorIndices[anchorIndex];
          const endIndex = anchorIndices[anchorIndex + 1];
          if (endIndex - startIndex < 2) continue;

          const start = current[path[startIndex]];
          const end = current[path[endIndex]];
          if (!start || !end) continue;

          for (let index = startIndex + 1; index < endIndex; index += 1) {
            const nodeId = path[index];
            if (protectedNodes.has(nodeId)) continue;
            const point = current[nodeId];
            if (!point) continue;

            const t = (index - startIndex) / (endIndex - startIndex);
            const target = {
              x: start.x + (end.x - start.x) * t,
              y: start.y + (end.y - start.y) * t,
            };
            const blend = 0.88;
            next[nodeId] = {
              x: point.x * (1 - blend) + target.x * blend,
              y: point.y * (1 - blend) + target.y * blend,
            };
          }
        }
      }
    }

    current = next;
  }

  return current;
}

function moscowSegmentsCross(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) -
    (q.y - p.y) * (r.x - p.x);

  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  const eps = 1e-6;

  return (
    ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
    ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))
  );
}

function findCrossRegionMoscowPathNodes(
  graph: GraphModel,
  positions: Record<string, Point>,
  geographic: Record<string, Point>,
): Set<string> {
  const result = new Set<string>();

  const selfCrossings = (
    path: string[],
    source: Record<string, Point>,
  ): number => {
    let count = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      for (let j = i + 2; j < path.length - 1; j += 1) {
        if (
          moscowSegmentsCross(
            source[path[i]],
            source[path[i + 1]],
            source[path[j]],
            source[path[j + 1]],
          )
        ) {
          count += 1;
        }
      }
    }
    return count;
  };

  for (const line of graph.lines) {
    for (const path of line.paths) {
      if (
        path.length >= 5 &&
        selfCrossings(path, positions) >= 2 &&
        selfCrossings(path, geographic) === 0
      ) {
        for (const nodeId of path) result.add(nodeId);
      }
    }
  }

  return result;
}

function repairCrossRegionMoscowPaths(
  graph: GraphModel,
  positions: Record<string, Point>,
  geographic: Record<string, Point>,
  fixedNodes: Set<string>,
): Record<string, Point> {
  const result = Object.fromEntries(
    Object.entries(positions).map(([id, point]) => [
      id,
      { ...point },
    ]),
  );

  const selfCrossings = (
    path: string[],
    source: Record<string, Point>,
  ): number => {
    let count = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      for (let j = i + 2; j < path.length - 1; j += 1) {
        if (
          moscowSegmentsCross(
            source[path[i]],
            source[path[i + 1]],
            source[path[j]],
            source[path[j + 1]],
          )
        ) {
          count += 1;
        }
      }
    }
    return count;
  };

  for (const line of graph.lines) {
    for (const path of line.paths) {
      if (path.length < 5) continue;
      const currentCrossings = selfCrossings(path, result);
      if (currentCrossings < 2) continue;

      // Only use this repair when the source geography itself is clean.
      // That tells us the crossings were introduced by the schematic
      // regional transforms rather than by the real route topology.
      if (selfCrossings(path, geographic) !== 0) continue;

      const startId = path[0];
      const endId = path[path.length - 1];
      const startDelta = {
        x: result[startId].x - geographic[startId].x,
        y: result[startId].y - geographic[startId].y,
      };
      const endDelta = {
        x: result[endId].x - geographic[endId].x,
        y: result[endId].y - geographic[endId].y,
      };

      const candidate = Object.fromEntries(
        Object.entries(result).map(([id, point]) => [
          id,
          { ...point },
        ]),
      );

      for (let index = 1; index < path.length - 1; index += 1) {
        const nodeId = path[index];
        if (fixedNodes.has(nodeId)) continue;
        const t = index / (path.length - 1);
        candidate[nodeId] = {
          x:
            geographic[nodeId].x +
            startDelta.x * (1 - t) +
            endDelta.x * t,
          y:
            geographic[nodeId].y +
            startDelta.y * (1 - t) +
            endDelta.y * t,
        };
      }

      // If the repaired geographic corridor is still too short for all
      // station markers, lengthen it by amplifying only its lateral shape
      // relative to the fixed endpoint chord. This preserves endpoint
      // geography and route order while creating schematic breathing room.
      let polyline = path.map((nodeId) => candidate[nodeId]);
      const rawLength = polyline
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum +
            Math.hypot(
              point.x - polyline[index].x,
              point.y - polyline[index].y,
            ),
          0,
        );
      const desiredLength = (path.length - 1) * 38;

      if (rawLength < desiredLength) {
        const startPoint = polyline[0];
        const endPoint = polyline[polyline.length - 1];
        const chordDx = endPoint.x - startPoint.x;
        const chordDy = endPoint.y - startPoint.y;
        const chordLength = Math.max(
          1,
          Math.hypot(chordDx, chordDy),
        );
        const nx = -chordDy / chordLength;
        const ny = chordDx / chordLength;
        const shapeScale = clamp(
          desiredLength / Math.max(1, rawLength),
          1,
          3.8,
        );

        polyline = polyline.map((point, index) => {
          if (index === 0 || index === polyline.length - 1) {
            return point;
          }
          const t = index / (polyline.length - 1);
          const chordPoint = {
            x: startPoint.x + chordDx * t,
            y: startPoint.y + chordDy * t,
          };
          const deviationX = point.x - chordPoint.x;
          const deviationY = point.y - chordPoint.y;
          let lateral =
            deviationX * nx + deviationY * ny;

          if (Math.abs(lateral) < 4) {
            const side = index <= polyline.length / 2 ? 1 : -1;
            lateral += side * 10 * Math.sin(Math.PI * t);
          }

          const along =
            deviationX * (chordDx / chordLength) +
            deviationY * (chordDy / chordLength);

          return {
            x:
              chordPoint.x +
              (chordDx / chordLength) * along +
              nx * lateral * shapeScale,
            y:
              chordPoint.y +
              (chordDy / chordLength) * along +
              ny * lateral * shapeScale,
          };
        });

        path.forEach((nodeId, index) => {
          candidate[nodeId] = polyline[index];
        });
      }

      // Re-space stations uniformly along the repaired polyline. This keeps
      // both endpoints fixed and preserves the clean geographic corridor,
      // while preventing uneven real-world station spacing from collapsing
      // badges in a schematic map.
      const cumulative = [0];
      for (let index = 1; index < polyline.length; index += 1) {
        cumulative.push(
          cumulative[index - 1] +
            Math.hypot(
              polyline[index].x - polyline[index - 1].x,
              polyline[index].y - polyline[index - 1].y,
            ),
        );
      }
      const totalLength = cumulative[cumulative.length - 1];

      if (totalLength > 1) {
        for (let index = 1; index < path.length - 1; index += 1) {
          const targetDistance =
            (totalLength * index) / (path.length - 1);

          let segment = 0;
          while (
            segment < cumulative.length - 2 &&
            cumulative[segment + 1] < targetDistance
          ) {
            segment += 1;
          }

          const segmentStart = cumulative[segment];
          const segmentEnd = cumulative[segment + 1];
          const segmentLength = Math.max(
            1e-6,
            segmentEnd - segmentStart,
          );
          const localT =
            (targetDistance - segmentStart) / segmentLength;
          const a = polyline[segment];
          const b = polyline[segment + 1];

          candidate[path[index]] = {
            x: a.x + (b.x - a.x) * localT,
            y: a.y + (b.y - a.y) * localT,
          };
        }
      }

      // Never accept a repair that makes the route less orderly.
      if (
        selfCrossings(path, candidate) <
        currentCrossings
      ) {
        for (const nodeId of path.slice(1, -1)) {
          if (!fixedNodes.has(nodeId)) {
            result[nodeId] = candidate[nodeId];
          }
        }
      }
    }
  }

  return result;
}

function reduceMoscowCrossings(
  graph: GraphModel,
  positions: Record<string, Point>,
  fixedNodes: Set<string>,
): Record<string, Point> {
  const result = Object.fromEntries(
    Object.entries(positions).map(([id, point]) => [
      id,
      { ...point },
    ]),
  );

  const incidentEdges = new Map<
    string,
    typeof graph.edges
  >();
  for (const node of graph.nodes) {
    incidentEdges.set(
      node.id,
      graph.edges.filter(
        (edge) =>
          edge.a === node.id || edge.b === node.id,
      ),
    );
  }

  const localCrossings = (nodeId: string): number => {
    let count = 0;
    for (const first of incidentEdges.get(nodeId) ?? []) {
      for (const second of graph.edges) {
        if (first === second) continue;
        if (
          first.a === second.a ||
          first.a === second.b ||
          first.b === second.a ||
          first.b === second.b
        ) {
          continue;
        }
        if (
          moscowSegmentsCross(
            result[first.a],
            result[first.b],
            result[second.a],
            result[second.b],
          )
        ) {
          count += 1;
        }
      }
    }
    return count;
  };

  const safeDistance = (
    nodeId: string,
    candidate: Point,
  ): boolean => {
    for (const node of graph.nodes) {
      if (node.id === nodeId) continue;
      const other = result[node.id];
      if (
        Math.hypot(
          candidate.x - other.x,
          candidate.y - other.y,
        ) < 27
      ) {
        return false;
      }
    }
    return true;
  };

  for (let pass = 0; pass < 7; pass += 1) {
    const ranked = graph.nodes
      .filter(
        (node) =>
          !fixedNodes.has(node.id) &&
          (graph.adjacency.get(node.id)?.length ?? 0) <= 3,
      )
      .map((node) => ({
        id: node.id,
        crossings: localCrossings(node.id),
      }))
      .filter((item) => item.crossings > 0)
      .sort((a, b) => b.crossings - a.crossings)
      .slice(0, 36);

    let improved = false;

    for (const item of ranked) {
      const original = { ...result[item.id] };
      let best = original;
      let bestCrossings = localCrossings(item.id);

      const steps = [28, 18, 10];
      for (const step of steps) {
        for (let direction = 0; direction < 8; direction += 1) {
          const angle =
            (Math.PI * 2 * direction) / 8;
          const candidate = {
            x: original.x + Math.cos(angle) * step,
            y: original.y + Math.sin(angle) * step,
          };

          if (!safeDistance(item.id, candidate)) {
            continue;
          }

          result[item.id] = candidate;
          const candidateCrossings =
            localCrossings(item.id);
          if (candidateCrossings < bestCrossings) {
            bestCrossings = candidateCrossings;
            best = candidate;
          }
        }
      }

      result[item.id] = best;
      if (
        best.x !== original.x ||
        best.y !== original.y
      ) {
        improved = true;
      }
    }

    if (!improved) break;
  }

  return result;
}

export function layoutMoscow(
  graph: GraphModel,
  geographic: Record<string, Point>,
  definedRings: ValidatedMoscowRing[] = [],
  significantGeographicGap = 45,
): {
  positions: Record<string, Point>;
  moscowRings: ValidatedMoscowRing[];
} {
  if (!definedRings.length) {
    return {
      positions: Object.fromEntries(
        graph.nodes.map((node) => [
          node.id,
          { ...geographic[node.id] },
        ]),
      ),
      moscowRings: [],
    };
  }

  const positions: Record<string, Point> = {};
  const ringNodeSet = new Set<string>();

  const ringInfos = definedRings.map((definition) => {
    const rawPoints = definition.nodes.map((id) => geographic[id]);
    const geoCenter = {
      x:
        rawPoints.reduce((sum, point) => sum + point.x, 0) /
        Math.max(1, rawPoints.length),
      y:
        rawPoints.reduce((sum, point) => sum + point.y, 0) /
        Math.max(1, rawPoints.length),
    };

    const ring = orientRing(
      definition.nodes,
      geographic,
      geoCenter,
    );
    const slot = (Math.PI * 2) / ring.length;

    const rawRadii = ring.map((id) =>
      Math.hypot(
        geographic[id].x - geoCenter.x,
        geographic[id].y - geoCenter.y,
      ),
    );
    const geoRadius =
      rawRadii.reduce((sum, value) => sum + value, 0) /
      Math.max(1, rawRadii.length);

    const radiusForStationSpacing =
      36 / Math.max(
        0.01,
        2 * Math.sin(Math.PI / ring.length),
      );
    const targetRadius = Math.max(
      radiusForStationSpacing,
      165,
    );

    ring.forEach((id, index) => {
      ringNodeSet.add(id);
      const angle = -Math.PI / 2 + slot * index;

      positions[id] = {
        x: geoCenter.x + Math.cos(angle) * targetRadius,
        y: geoCenter.y + Math.sin(angle) * targetRadius,
      };
    });

    return {
      definition: { ...definition, nodes: ring },
      geoCenter,
      geoRadius,
      targetRadius,
      phase: 0,
      angles: ring.map((_, index) => -Math.PI / 2 + slot * index),
    };
  });

  // Fit ring rotation against significant pairwise geographic order. Equal
  // slots alone can place genuinely east/west stations on the same meridian.
  const setRing = (info: typeof ringInfos[number], phase: number) => {
    info.phase = phase;
    info.definition.nodes.forEach((id, index) => {
      const angle = -Math.PI / 2 + Math.PI * 2 * index / info.definition.nodes.length + phase;
      info.angles[index] = angle;
      positions[id] = { x: info.geoCenter.x + Math.cos(angle) * info.targetRadius,
        y: info.geoCenter.y + Math.sin(angle) * info.targetRadius };
    });
  };
  const ringOrderCost = () => {
    const ids = [...ringNodeSet]; let cost = 0;
    for (let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++) for(const axis of ['x','y'] as const) {
      const delta=geographic[ids[j]][axis]-geographic[ids[i]][axis];
      if(Math.abs(delta)>=significantGeographicGap && delta*(positions[ids[j]][axis]-positions[ids[i]][axis])<=1e-7) cost+=delta*delta;
    }
    return cost;
  };
  for(let pass=0;pass<3;pass++) for(const info of ringInfos){
    let bestPhase=info.phase, bestCost=ringOrderCost();
    for(let degree=-25;degree<=25;degree+=0.5){
      setRing(info,degree*Math.PI/180); const cost=ringOrderCost();
      if(cost<bestCost){bestCost=cost;bestPhase=info.phase;}
    }
    setRing(info,bestPhase);
  }

  for(let pass=0;pass<4;pass++) for(const info of ringInfos){
    const slot=Math.PI*2/info.definition.nodes.length;
    info.definition.nodes.forEach((id,index)=>{
      const original=info.angles[index]; let best=original,bestCost=ringOrderCost();
      const put=(angle:number)=>{positions[id]={x:info.geoCenter.x+Math.cos(angle)*info.targetRadius,y:info.geoCenter.y+Math.sin(angle)*info.targetRadius};};
      for(const shift of [-0.24,-0.16,-0.08,0.08,0.16,0.24]){
        const angle=original+shift*slot; put(angle);
        if(info.definition.nodes.some(other=>other!==id && Math.hypot(positions[other].x-positions[id].x,positions[other].y-positions[id].y)<28))continue;
        const cost=ringOrderCost();if(cost<bestCost){best=angle;bestCost=cost;}
      }
      info.angles[index]=best;put(best);
    });
  }

  // Every non-ring station is handled by the nearest logical ring system.
  // This preserves the clean radial organization of the original Moscow
  // algorithm without pretending that Taipei/New Taipei and Taoyuan share
  // one centre.
  for (const node of graph.nodes) {
    if (ringNodeSet.has(node.id)) continue;

    const geo = geographic[node.id];
    let nearest = ringInfos[0];
    let bestNormalizedDistance = Number.POSITIVE_INFINITY;

    for (const ring of ringInfos) {
      const radialDistance = Math.hypot(
        geo.x - ring.geoCenter.x,
        geo.y - ring.geoCenter.y,
      );
      const normalized =
        radialDistance / Math.max(1, ring.geoRadius);
      if (normalized < bestNormalizedDistance) {
        bestNormalizedDistance = normalized;
        nearest = ring;
      }
    }

    // Very remote stations keep their geographic position; otherwise the
    // local ring acts as the schematic frame for that regional cluster.
    if (bestNormalizedDistance > 2.35) {
      positions[node.id] = { ...geo };
      continue;
    }

    const dx = geo.x - nearest.geoCenter.x;
    const dy = geo.y - nearest.geoCenter.y;
    const geoRadius = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    let mappedRadius: number;

    if (geoRadius <= nearest.geoRadius) {
      const ratio =
        geoRadius / Math.max(1, nearest.geoRadius);
      mappedRadius =
        Math.pow(ratio, 0.84) *
        Math.max(70, nearest.targetRadius - 62);
    } else {
      const outside =
        geoRadius - nearest.geoRadius;
      const outsideScale = clamp(
        nearest.targetRadius /
          Math.max(1, nearest.geoRadius),
        0.72,
        1.28,
      );
      mappedRadius =
        nearest.targetRadius +
        62 +
        outside * outsideScale;
    }

    positions[node.id] = {
      x:
        nearest.geoCenter.x +
        Math.cos(angle) * mappedRadius,
      y:
        nearest.geoCenter.y +
        Math.sin(angle) * mappedRadius,
    };
  }

  const smoothed = smoothMoscowCorridors(
    graph,
    positions,
    ringNodeSet,
  );

  // Preserve exact circle nodes after corridor smoothing.
  for (const ring of ringInfos) {
    ring.definition.nodes.forEach((id, index) => {
      const angle = ring.angles[index];
      smoothed[id] = {
        x:
          ring.geoCenter.x +
          Math.cos(angle) * ring.targetRadius,
        y:
          ring.geoCenter.y +
          Math.sin(angle) * ring.targetRadius,
      };
    });
  }

  // Collision repair for non-ring stations only. Exact circle geometry is
  // fixed and cannot be pushed out of round.
  for (let iteration = 0; iteration < 12; iteration += 1) {
    let moved = false;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const aId = graph.nodes[i].id;
        const bId = graph.nodes[j].id;
        const a = smoothed[aId];
        const b = smoothed[bId];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        const minimumDistance = 29;
        if (distance >= minimumDistance) continue;

        const aFixed = ringNodeSet.has(aId);
        const bFixed = ringNodeSet.has(bId);
        if (aFixed && bFixed) continue;

        if (distance < 1e-6) {
          const angle =
            ((i * 43 + j * 101) % 360) *
            (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }

        const nx = dx / distance;
        const ny = dy / distance;
        const required = minimumDistance - distance;

        if (aFixed) {
          b.x += nx * required;
          b.y += ny * required;
        } else if (bFixed) {
          a.x -= nx * required;
          a.y -= ny * required;
        } else {
          const half = required / 2;
          a.x -= nx * half;
          a.y -= ny * half;
          b.x += nx * half;
          b.y += ny * half;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  const crossRegionPathNodes =
    findCrossRegionMoscowPathNodes(
      graph,
      smoothed,
      geographic,
    );
  const crossRegionRepaired =
    repairCrossRegionMoscowPaths(
      graph,
      smoothed,
      geographic,
      ringNodeSet,
    );

  // Cross-region connectors should approach a ring from the outside and
  // touch it only at their interchange endpoint. This prevents a connector
  // from grazing other stations on the ring before reaching its actual
  // transfer station.
  for (const line of graph.lines) {
    for (const path of line.paths) {
      if (
        !path.some((nodeId) =>
          crossRegionPathNodes.has(nodeId),
        )
      ) {
        continue;
      }

      const startRing = ringInfos.find((ring) =>
        ring.definition.nodes.includes(path[0]),
      );
      const endRing = ringInfos.find((ring) =>
        ring.definition.nodes.includes(
          path[path.length - 1],
        ),
      );
      const ring =
        startRing && !endRing
          ? startRing
          : endRing && !startRing
            ? endRing
            : undefined;
      if (!ring) continue;

      const ringAtStart = Boolean(startRing);
      const anchorIndex = ringAtStart
        ? 0
        : path.length - 1;

      for (let index = 1; index < path.length - 1; index += 1) {
        const nodeId = path[index];
        const point = crossRegionRepaired[nodeId];
        const dx = point.x - ring.geoCenter.x;
        const dy = point.y - ring.geoCenter.y;
        const radius = Math.max(1, Math.hypot(dx, dy));
        const stepsFromRing = Math.abs(index - anchorIndex);

        // The station immediately before the interchange still needs enough
        // space for two badges; stations farther away get progressively more
        // clearance from the ring.
        const minimumRadius =
          ring.targetRadius +
          42 +
          Math.min(90, Math.max(0, stepsFromRing - 1) * 8);

        if (radius < minimumRadius) {
          crossRegionRepaired[nodeId] = {
            x:
              ring.geoCenter.x +
              (dx / radius) * minimumRadius,
            y:
              ring.geoCenter.y +
              (dy / radius) * minimumRadius,
          };
        }
      }

      // The radial clearance pass above can stretch some sections more than
      // others. Re-sample this already-clean connector once more by arc
      // length so consecutive station badges remain evenly readable.
      const points = path.map(
        (nodeId) => crossRegionRepaired[nodeId],
      );
      const cumulative = [0];
      for (let index = 1; index < points.length; index += 1) {
        cumulative.push(
          cumulative[index - 1] +
            Math.hypot(
              points[index].x - points[index - 1].x,
              points[index].y - points[index - 1].y,
            ),
        );
      }
      const total = cumulative[cumulative.length - 1];

      if (total > 1) {
        const resampled = points.map((point) => ({ ...point }));
        for (let index = 1; index < path.length - 1; index += 1) {
          const target = (total * index) / (path.length - 1);
          let segment = 0;
          while (
            segment < cumulative.length - 2 &&
            cumulative[segment + 1] < target
          ) {
            segment += 1;
          }
          const startDistance = cumulative[segment];
          const endDistance = cumulative[segment + 1];
          const span = Math.max(
            1e-6,
            endDistance - startDistance,
          );
          const t = (target - startDistance) / span;
          const a = points[segment];
          const b = points[segment + 1];
          resampled[index] = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
          };
        }

        for (let index = 1; index < path.length - 1; index += 1) {
          crossRegionRepaired[path[index]] = resampled[index];
        }
      }
    }
  }

  // Keep the repaired connector and ring circles fixed. If another ordinary
  // station crowds this passenger-wayfinding backbone, move only that other
  // station. This preserves the connector's no-self-crossing geometry.
  const protectedAfterRepair = new Set([
    ...ringNodeSet,
    ...crossRegionPathNodes,
  ]);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    let moved = false;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const aId = graph.nodes[i].id;
        const bId = graph.nodes[j].id;
        const a = crossRegionRepaired[aId];
        const b = crossRegionRepaired[bId];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        const minimumDistance = 30;
        if (distance >= minimumDistance) continue;

        const aFixed = protectedAfterRepair.has(aId);
        const bFixed = protectedAfterRepair.has(bId);
        if (aFixed && bFixed) continue;

        if (distance < 1e-6) {
          const angle =
            ((i * 47 + j * 103) % 360) *
            (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }

        const nx = dx / distance;
        const ny = dy / distance;
        const required = minimumDistance - distance;

        if (aFixed) {
          b.x += nx * required;
          b.y += ny * required;
        } else if (bFixed) {
          a.x -= nx * required;
          a.y -= ny * required;
        } else {
          const half = required / 2;
          a.x -= nx * half;
          a.y -= ny * half;
          b.x += nx * half;
          b.y += ny * half;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  const smoothedForDisplay = relaxPathKinksSafely(
    graph,
    crossRegionRepaired,
    {
      passes: 10,
      thresholdDegrees: 66,
      minimumNodeDistance: 30,
      maxShift: 38,
      structuralMaxShift: 22,
    },
  );

  // Restore the protected Moscow backbone exactly after the local smoothing.
  for (const nodeId of protectedAfterRepair) {
    smoothedForDisplay[nodeId] = {
      ...crossRegionRepaired[nodeId],
    };
  }

  const optimized = reduceMoscowCrossings(
    graph,
    smoothedForDisplay,
    protectedAfterRepair,
  );

  return {
    positions: optimized,
    moscowRings: ringInfos.map((info) => info.definition),
  };
}

export function layoutConcentric(
  graph: GraphModel,
  geographic: Record<string, Point>,
): { positions: Record<string, Point>; center: Point } {
  const points = graph.nodes.map((node) => geographic[node.id]);
  const center = {
    x:
      points.reduce((sum, point) => sum + point.x, 0) /
      Math.max(1, points.length),
    y:
      points.reduce((sum, point) => sum + point.y, 0) /
      Math.max(1, points.length),
  };

  const polar = graph.nodes
    .map((node) => {
      const point = geographic[node.id];
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += Math.PI * 2;
      return {
        id: node.id,
        radius: Math.hypot(dx, dy),
        angle,
      };
    })
    .sort((a, b) => a.radius - b.radius);

  const maxRadius = Math.max(
    1,
    ...polar.map((item) => item.radius),
  );
  const shellCount = Math.max(
    5,
    Math.min(9, Math.round(Math.sqrt(graph.nodes.length) / 2)),
  );
  const shells: typeof polar[] = Array.from(
    { length: shellCount },
    () => [],
  );

  for (const item of polar) {
    const normalized = Math.pow(item.radius / maxRadius, 0.88);
    const shellIndex = Math.max(
      0,
      Math.min(
        shellCount - 1,
        Math.round(normalized * (shellCount - 1)),
      ),
    );
    shells[shellIndex].push(item);
  }

  const target: Record<string, Point> = {};
  const baseShellSpacing = Math.max(92, maxRadius / shellCount);

  // Occupancy can force an inner shell to be larger than its nominal radius.
  // Compute all radii cumulatively so a crowded inner shell can never overtake
  // the next shell. This makes the minimum distance between different shells a
  // hard geometric invariant instead of an accidental by-product.
  const shellRadii: number[] = [];
  let previousOccupiedRadius = 0;
  let previousOccupiedIndex = -1;
  for (let shellIndex = 0; shellIndex < shells.length; shellIndex += 1) {
    const shell = shells[shellIndex];
    if (!shell.length) {
      shellRadii[shellIndex] = Math.max(
        82 + shellIndex * baseShellSpacing,
        previousOccupiedRadius,
      );
      continue;
    }

    const occupancyRadius =
      (shell.length * 42) / (Math.PI * 2);
    const nominalRadius =
      82 + shellIndex * baseShellSpacing;
    const skippedShells =
      previousOccupiedIndex < 0
        ? 1
        : Math.max(1, shellIndex - previousOccupiedIndex);
    const clearanceRadius =
      previousOccupiedRadius +
      skippedShells * 44;

    const desiredRadius = Math.max(
      nominalRadius,
      occupancyRadius,
      previousOccupiedIndex < 0 ? 82 : clearanceRadius,
    );
    shellRadii[shellIndex] = desiredRadius;
    previousOccupiedRadius = desiredRadius;
    previousOccupiedIndex = shellIndex;
  }

  shells.forEach((shell, shellIndex) => {
    if (!shell.length) return;

    const desiredRadius = shellRadii[shellIndex];
    const minGap = Math.min(
      (Math.PI * 2) / Math.max(1, shell.length),
      42 / Math.max(1, desiredRadius),
    );

    const sorted = [...shell].sort((a, b) => a.angle - b.angle);
    if (sorted.length === 1) {
      const item = sorted[0];
      target[item.id] = {
        x: center.x + Math.cos(item.angle) * desiredRadius,
        y: center.y + Math.sin(item.angle) * desiredRadius,
      };
      return;
    }

    // Open the ring at its largest natural angular gap. This keeps station
    // order stable while giving the constraint solver room to distribute
    // crowded labels around the shell.
    let largestGapIndex = 0;
    let largestGap = -1;
    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index].angle;
      const next =
        index === sorted.length - 1
          ? sorted[0].angle + Math.PI * 2
          : sorted[index + 1].angle;
      const gap = next - current;
      if (gap > largestGap) {
        largestGap = gap;
        largestGapIndex = index;
      }
    }

    const ordered = [
      ...sorted.slice(largestGapIndex + 1),
      ...sorted.slice(0, largestGapIndex + 1),
    ];
    const unwrapped = ordered.map((item, index) => {
      let angle = item.angle;
      if (index > 0) {
        while (angle <= ordered[0].angle) angle += Math.PI * 2;
      }
      return angle;
    });

    const adjusted = [...unwrapped];
    for (let index = 1; index < adjusted.length; index += 1) {
      adjusted[index] = Math.max(
        adjusted[index],
        adjusted[index - 1] + minGap,
      );
    }

    const originalMean =
      unwrapped.reduce((sum, value) => sum + value, 0) /
      unwrapped.length;
    const adjustedMean =
      adjusted.reduce((sum, value) => sum + value, 0) /
      adjusted.length;
    const meanShift = originalMean - adjustedMean;

    ordered.forEach((item, index) => {
      const angle = adjusted[index] + meanShift;
      target[item.id] = {
        x: center.x + Math.cos(angle) * desiredRadius,
        y: center.y + Math.sin(angle) * desiredRadius,
      };
    });
  });

  // A full projection of every station onto a shell is visually pure but
  // introduces many artificial crossings on a regional network. Blend the
  // radial-shell solution with the north-up geography: the centre receives
  // stronger shell structure, while outer districts retain more of their
  // natural topology.
  // Orthoradial mode is intentionally strict: every station remains on one
  // of the common-centre shells. Geographic blending here used to move
  // stations off their circles and made the rendered style only "radial-ish".
  // Topology protection happens in the renderer/QA instead of deforming the
  // defining geometry of this style.
  return { positions: target, center };

}
