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

function fanOutSelfCrossingMoscowPaths(
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

  const selfCrossingCount = (path: string[]): number => {
    let count = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      for (let j = i + 2; j < path.length - 1; j += 1) {
        if (i === 0 && j === path.length - 2) continue;
        if (
          moscowSegmentsCross(
            result[path[i]],
            result[path[i + 1]],
            result[path[j]],
            result[path[j + 1]],
          )
        ) {
          count += 1;
        }
      }
    }
    return count;
  };

  const networkCenter = {
    x:
      graph.nodes.reduce(
        (sum, node) => sum + result[node.id].x,
        0,
      ) / Math.max(1, graph.nodes.length),
    y:
      graph.nodes.reduce(
        (sum, node) => sum + result[node.id].y,
        0,
      ) / Math.max(1, graph.nodes.length),
  };

  for (const line of graph.lines) {
    line.paths.forEach((path) => {
      if (path.length < 5) return;
      if (selfCrossingCount(path) < 2) return;

      const inner = path.slice(1, -1);
      if (inner.some((id) => fixedNodes.has(id))) return;

      const start = result[path[0]];
      const end = result[path[path.length - 1]];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const chord = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / chord;
      const ny = dx / chord;
      const midpoint = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      };

      // Bow away from the network centre, and make the arc large enough for
      // all intermediate stations to retain passenger-readable spacing.
      const toCenter = {
        x: networkCenter.x - midpoint.x,
        y: networkCenter.y - midpoint.y,
      };
      const side =
        nx * toCenter.x + ny * toCenter.y > 0 ? -1 : 1;
      const amplitude = Math.max(
        95,
        inner.length * 24,
        chord * 0.38,
      );

      const control = {
        x: midpoint.x + nx * amplitude * side,
        y: midpoint.y + ny * amplitude * side,
      };

      for (let index = 1; index < path.length - 1; index += 1) {
        const t = index / (path.length - 1);
        const oneMinusT = 1 - t;
        result[path[index]] = {
          x:
            oneMinusT * oneMinusT * start.x +
            2 * oneMinusT * t * control.x +
            t * t * end.x,
          y:
            oneMinusT * oneMinusT * start.y +
            2 * oneMinusT * t * control.y +
            t * t * end.y,
        };
      }
    });
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
    };
  });

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
    const slot =
      (Math.PI * 2) / ring.definition.nodes.length;
    ring.definition.nodes.forEach((id, index) => {
      const angle = -Math.PI / 2 + slot * index;
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

  const fannedOut = fanOutSelfCrossingMoscowPaths(
    graph,
    smoothed,
    ringNodeSet,
  );
  const optimized = reduceMoscowCrossings(
    graph,
    fannedOut,
    ringNodeSet,
  );

  return {
    positions: optimized,
    moscowRings: ringInfos.map((info) => info.definition),
  };
}

export function layoutConcentric(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  // On a regional network, forcing hundreds of stations onto quantized
  // radii creates artificial crossings. Keep the north-up geographic
  // topology intact; the renderer supplies concentric guide rings to
  // communicate this visual style without corrupting passenger wayfinding.
  return Object.fromEntries(
    graph.nodes.map((node) => [
      node.id,
      { ...geographic[node.id] },
    ]),
  );
}
