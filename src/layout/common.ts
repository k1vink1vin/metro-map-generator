import type { GraphModel, Point } from '../types';

export interface SnapOptions {
  angleStep: number;
  geographyWeight: number;
  equalSpacingWeight: number;
  iterations?: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function median(values: number[]): number {
  if (!values.length) return 70;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function snappedVector(a: Point, b: Point, angleStep: number, length: number): Point {
  const step = (angleStep * Math.PI) / 180;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const snapped = Math.round(angle / step) * step;
  return {
    x: Math.cos(snapped) * length,
    y: Math.sin(snapped) * length,
  };
}

export function schematizeOnAngularGrid(
  graph: GraphModel,
  geographic: Record<string, Point>,
  options: SnapOptions,
): Record<string, Point> {
  const positions: Record<string, Point> = Object.fromEntries(
    Object.entries(geographic).map(([id, point]) => [id, { ...point }]),
  );

  const edgeLengths = graph.edges.map((edge) =>
    distance(geographic[edge.a], geographic[edge.b]),
  );
  const targetSpacing = Math.max(54, Math.min(104, median(edgeLengths)));
  const iterations = options.iterations ?? 90;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const predictions = new Map<string, Point[]>();
    for (const node of graph.nodes) predictions.set(node.id, []);

    for (const edge of graph.edges) {
      const a = positions[edge.a];
      const b = positions[edge.b];
      const currentLength = Math.max(1, distance(a, b));
      const desiredLength =
        currentLength * (1 - options.equalSpacingWeight) +
        targetSpacing * options.equalSpacingWeight;
      const vector = snappedVector(a, b, options.angleStep, desiredLength);

      predictions.get(edge.b)?.push({ x: a.x + vector.x, y: a.y + vector.y });
      predictions.get(edge.a)?.push({ x: b.x - vector.x, y: b.y - vector.y });
    }

    const cooling = 0.55 * (1 - iteration / iterations) + 0.12;

    for (const node of graph.nodes) {
      const candidates = predictions.get(node.id) ?? [];
      if (!candidates.length) continue;

      const average = candidates.reduce(
        (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
        { x: 0, y: 0 },
      );
      average.x /= candidates.length;
      average.y /= candidates.length;

      const anchored = {
        x:
          average.x * (1 - options.geographyWeight) +
          geographic[node.id].x * options.geographyWeight,
        y:
          average.y * (1 - options.geographyWeight) +
          geographic[node.id].y * options.geographyWeight,
      };

      positions[node.id] = {
        x: positions[node.id].x + (anchored.x - positions[node.id].x) * cooling,
        y: positions[node.id].y + (anchored.y - positions[node.id].y) * cooling,
      };
    }
  }

  return positions;
}


export interface RouteAwareOptions {
  angleStep: number;
  passes: number;
  runBlend: number;
  geographyTether: number;
  equalSpacingWeight: number;
  bendAnchorDegrees?: number;
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(point: Point, factor: number): Point {
  return { x: point.x * factor, y: point.y * factor };
}

function samplePolyline(
  points: Point[],
  fraction: number,
): Point {
  if (points.length === 1) return { ...points[0] };

  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const value = distance(points[index], points[index + 1]);
    lengths.push(value);
    total += value;
  }

  if (total < 1e-6) return { ...points[0] };
  const target = Math.max(0, Math.min(1, fraction)) * total;
  let travelled = 0;

  for (let index = 0; index < lengths.length; index += 1) {
    const next = travelled + lengths[index];
    if (target <= next || index === lengths.length - 1) {
      const local =
        lengths[index] < 1e-6
          ? 0
          : (target - travelled) / lengths[index];
      return {
        x:
          points[index].x +
          (points[index + 1].x - points[index].x) * local,
        y:
          points[index].y +
          (points[index + 1].y - points[index].y) * local,
      };
    }
    travelled = next;
  }

  return { ...points[points.length - 1] };
}

function angularTwoSegmentPath(
  start: Point,
  end: Point,
  angleStep: number,
  references: Point[],
): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return [start, end];

  const step = (angleStep * Math.PI) / 180;
  let angle = Math.atan2(dy, dx);
  while (angle < 0) angle += Math.PI * 2;

  const lowerAngle = Math.floor(angle / step) * step;
  const upperAngle = lowerAngle + step;
  const lower = { x: Math.cos(lowerAngle), y: Math.sin(lowerAngle) };
  const upper = { x: Math.cos(upperAngle), y: Math.sin(upperAngle) };
  const delta = { x: dx, y: dy };
  const determinant = cross(lower, upper);

  if (Math.abs(determinant) < 1e-6) {
    return [start, end];
  }

  const lowerLength = cross(delta, upper) / determinant;
  const upperLength = cross(lower, delta) / determinant;

  if (lowerLength < -1e-6 || upperLength < -1e-6) {
    // Never return a corridor that misses its real endpoint.  The previous
    // fallback projected a full-length snapped vector from `start`, which
    // left `end` off the corridor and forced the last route segment to form
    // an artificial hook / saw-tooth.  Keeping the real endpoint is a harder
    // passenger-map invariant than forcing one nearly-axis-aligned segment
    // onto the angular grid.
    return [start, end];
  }

  if (
    lowerLength < length * 0.08 ||
    upperLength < length * 0.08
  ) {
    // When one component is tiny the direct segment is already close to an
    // allowed axis.  Using the true endpoint avoids concentrating the tiny
    // angular correction into a sharp terminal kink.
    return [start, end];
  }

  const bendA = add(start, scale(lower, lowerLength));
  const bendB = add(start, scale(upper, upperLength));
  const candidateA = [start, bendA, end];
  const candidateB = [start, bendB, end];

  const score = (candidate: Point[]) =>
    references.reduce((sum, reference, index) => {
      const fraction = (index + 1) / (references.length + 1);
      const sampled = samplePolyline(candidate, fraction);
      return (
        sum +
        (sampled.x - reference.x) ** 2 +
        (sampled.y - reference.y) ** 2
      );
    }, 0);

  return score(candidateA) <= score(candidateB)
    ? candidateA
    : candidateB;
}

function structuralNode(graph: GraphModel, nodeId: string): boolean {
  const node = graph.nodeById.get(nodeId);
  return (
    (graph.adjacency.get(nodeId)?.length ?? 0) !== 2 ||
    (node?.stationIds.length ?? 0) > 1
  );
}

function cumulativeFractions(
  ids: string[],
  reference: Record<string, Point>,
  equalSpacingWeight: number,
): number[] {
  if (ids.length <= 2) return [];

  const cumulative = [0];
  for (let index = 1; index < ids.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        distance(reference[ids[index - 1]], reference[ids[index]]),
    );
  }

  const total = Math.max(1e-6, cumulative[cumulative.length - 1]);
  return ids.slice(1, -1).map((_, innerIndex) => {
    const index = innerIndex + 1;
    const geographicFraction = cumulative[index] / total;
    const equalFraction = index / (ids.length - 1);
    return (
      geographicFraction * (1 - equalSpacingWeight) +
      equalFraction * equalSpacingWeight
    );
  });
}

/**
 * Path-aware regularization for schematic transit maps.
 *
 * Rather than snapping every edge independently (which creates saw-tooth
 * zig-zags), this treats the ordinary degree-2 stations between structural
 * nodes as one corridor. Each corridor is represented by either one allowed
 * axis or one two-axis bend, then its stations are re-spaced along that
 * corridor. Interchanges and branch junctions remain anchors.
 */
export function regularizeRouteCorridors(
  graph: GraphModel,
  input: Record<string, Point>,
  geographicReference: Record<string, Point>,
  options: RouteAwareOptions,
): Record<string, Point> {
  let positions = Object.fromEntries(
    Object.entries(input).map(([id, point]) => [id, { ...point }]),
  );

  for (let pass = 0; pass < options.passes; pass += 1) {
    const predictions = new Map<string, Point[]>();
    for (const node of graph.nodes) predictions.set(node.id, []);

    for (const line of graph.lines) {
      for (const path of line.paths) {
        const anchorIndices = new Set<number>([0, path.length - 1]);
        const bendThreshold =
          ((options.bendAnchorDegrees ?? 52) * Math.PI) / 180;

        path.forEach((nodeId, index) => {
          if (structuralNode(graph, nodeId)) {
            anchorIndices.add(index);
            return;
          }
          if (index <= 0 || index >= path.length - 1) return;

          const geoTurn = Math.abs(
            signedHeadingChange(
              geographicReference[path[index - 1]],
              geographicReference[nodeId],
              geographicReference[path[index + 1]],
            ),
          );
          if (geoTurn >= bendThreshold) {
            anchorIndices.add(index);
          }
        });
        const anchors = [...anchorIndices].sort((a, b) => a - b);

        for (let anchor = 0; anchor < anchors.length - 1; anchor += 1) {
          const startIndex = anchors[anchor];
          const endIndex = anchors[anchor + 1];
          if (endIndex - startIndex < 2) continue;

          const ids = path.slice(startIndex, endIndex + 1);
          const start = positions[ids[0]];
          const end = positions[ids[ids.length - 1]];
          const references = ids
            .slice(1, -1)
            .map((id) => geographicReference[id]);
          const corridor = angularTwoSegmentPath(
            start,
            end,
            options.angleStep,
            references,
          );
          const fractions = cumulativeFractions(
            ids,
            geographicReference,
            options.equalSpacingWeight,
          );

          ids.slice(1, -1).forEach((nodeId, index) => {
            predictions
              .get(nodeId)
              ?.push(samplePolyline(corridor, fractions[index]));
          });
        }
      }
    }

    const next = Object.fromEntries(
      Object.entries(positions).map(([id, point]) => [id, { ...point }]),
    );

    for (const node of graph.nodes) {
      const candidates = predictions.get(node.id) ?? [];
      if (!candidates.length || structuralNode(graph, node.id)) continue;

      const average = candidates.reduce(
        (sum, point) => ({
          x: sum.x + point.x,
          y: sum.y + point.y,
        }),
        { x: 0, y: 0 },
      );
      average.x /= candidates.length;
      average.y /= candidates.length;

      const corridorPoint = {
        x:
          positions[node.id].x * (1 - options.runBlend) +
          average.x * options.runBlend,
        y:
          positions[node.id].y * (1 - options.runBlend) +
          average.y * options.runBlend,
      };

      next[node.id] = {
        x:
          corridorPoint.x * (1 - options.geographyTether) +
          geographicReference[node.id].x * options.geographyTether,
        y:
          corridorPoint.y * (1 - options.geographyTether) +
          geographicReference[node.id].y * options.geographyTether,
      };
    }

    positions = next;
  }

  return positions;
}

export function inflateCentralArea(
  geographic: Record<string, Point>,
  strength = 0.38,
): Record<string, Point> {
  const points = Object.values(geographic);
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / Math.max(1, points.length),
    y: points.reduce((sum, point) => sum + point.y, 0) / Math.max(1, points.length),
  };
  const radii = points
    .map((point) => distance(point, center))
    .sort((a, b) => a - b);
  const referenceRadius =
    radii[Math.floor(radii.length * 0.65)] ?? 1;

  return Object.fromEntries(
    Object.entries(geographic).map(([id, point]) => {
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      const radius = Math.hypot(dx, dy);
      if (radius < 1e-6) return [id, { ...point }];

      const normalized = radius / Math.max(1, referenceRadius);
      const expansion =
        1 +
        strength *
          Math.exp(-Math.pow(normalized / 0.82, 2));

      return [
        id,
        {
          x: center.x + dx * expansion,
          y: center.y + dy * expansion,
        },
      ];
    }),
  );
}


export interface KinkRelaxOptions {
  passes: number;
  ordinaryBlend: number;
  structuralBlend: number;
  geographyTether: number;
  maxShift: number;
  thresholdDegrees?: number;
  protectedNodes?: Set<string>;
}

function signedHeadingChange(
  a: Point,
  b: Point,
  c: Point,
): number {
  const first = Math.atan2(b.y - a.y, b.x - a.x);
  const second = Math.atan2(c.y - b.y, c.x - b.x);
  let turn = second - first;
  while (turn > Math.PI) turn -= Math.PI * 2;
  while (turn < -Math.PI) turn += Math.PI * 2;
  return turn;
}

/**
 * Relaxes visually sharp route kinks after the main style solver.
 *
 * It does not blindly Laplacian-smooth the graph: only path occurrences whose
 * heading change exceeds the threshold contribute a midpoint prediction.
 * Ordinary corridor stations can move strongly; transfers/branches can move
 * only a little, which prevents all of the remaining bend energy from being
 * concentrated at structural anchors.
 */
export function relaxPathKinks(
  graph: GraphModel,
  input: Record<string, Point>,
  geographicReference: Record<string, Point>,
  options: KinkRelaxOptions,
): Record<string, Point> {
  let positions = Object.fromEntries(
    Object.entries(input).map(([id, point]) => [id, { ...point }]),
  );
  const threshold =
    ((options.thresholdDegrees ?? 72) * Math.PI) / 180;

  for (let pass = 0; pass < options.passes; pass += 1) {
    const predictions = new Map<
      string,
      Array<{ point: Point; weight: number }>
    >();
    for (const node of graph.nodes) predictions.set(node.id, []);

    for (const line of graph.lines) {
      for (const path of line.paths) {
        for (let index = 1; index < path.length - 1; index += 1) {
          const nodeId = path[index];
          if (options.protectedNodes?.has(nodeId)) continue;

          const previous = positions[path[index - 1]];
          const current = positions[nodeId];
          const next = positions[path[index + 1]];
          const turn = Math.abs(
            signedHeadingChange(previous, current, next),
          );
          if (turn < threshold) continue;

          const severity = Math.min(
            1,
            (turn - threshold) /
              Math.max(1e-6, Math.PI - threshold),
          );
          predictions.get(nodeId)?.push({
            point: {
              x: (previous.x + next.x) / 2,
              y: (previous.y + next.y) / 2,
            },
            weight: 0.35 + severity * 0.65,
          });
        }
      }
    }

    const nextPositions = Object.fromEntries(
      Object.entries(positions).map(([id, point]) => [id, { ...point }]),
    );
    let moved = false;

    for (const node of graph.nodes) {
      const items = predictions.get(node.id) ?? [];
      if (!items.length) continue;

      const totalWeight = items.reduce(
        (sum, item) => sum + item.weight,
        0,
      );
      const target = items.reduce(
        (sum, item) => ({
          x: sum.x + item.point.x * item.weight,
          y: sum.y + item.point.y * item.weight,
        }),
        { x: 0, y: 0 },
      );
      target.x /= Math.max(1e-6, totalWeight);
      target.y /= Math.max(1e-6, totalWeight);

      const structural = structuralNode(graph, node.id);
      const blend = structural
        ? options.structuralBlend
        : options.ordinaryBlend;

      const tethered = {
        x:
          target.x * (1 - options.geographyTether) +
          geographicReference[node.id].x * options.geographyTether,
        y:
          target.y * (1 - options.geographyTether) +
          geographicReference[node.id].y * options.geographyTether,
      };

      let dx =
        (tethered.x - positions[node.id].x) * blend;
      let dy =
        (tethered.y - positions[node.id].y) * blend;
      const shift = Math.hypot(dx, dy);
      if (shift > options.maxShift) {
        dx = (dx / shift) * options.maxShift;
        dy = (dy / shift) * options.maxShift;
      }

      if (Math.hypot(dx, dy) > 0.05) {
        nextPositions[node.id] = {
          x: positions[node.id].x + dx,
          y: positions[node.id].y + dy,
        };
        moved = true;
      }
    }

    positions = nextPositions;
    if (!moved) break;
  }

  return positions;
}


export interface SafeKinkRelaxOptions {
  passes: number;
  thresholdDegrees: number;
  minimumNodeDistance: number;
  maxShift: number;
  structuralMaxShift: number;
}

function properSegmentIntersection(
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

function localPathOccurrences(
  graph: GraphModel,
  nodeId: string,
): Array<{ previous: string; next: string }> {
  const result: Array<{ previous: string; next: string }> = [];
  for (const line of graph.lines) {
    for (const path of line.paths) {
      for (let index = 1; index < path.length - 1; index += 1) {
        if (path[index] === nodeId) {
          result.push({
            previous: path[index - 1],
            next: path[index + 1],
          });
        }
      }
    }
  }
  return result;
}

function localBendPenalty(
  nodeId: string,
  positions: Record<string, Point>,
  occurrences: Array<{ previous: string; next: string }>,
  threshold: number,
): number {
  return occurrences.reduce((sum, occurrence) => {
    const turn = Math.abs(
      signedHeadingChange(
        positions[occurrence.previous],
        positions[nodeId],
        positions[occurrence.next],
      ),
    );
    const excess = Math.max(0, turn - threshold);
    return sum + excess * excess;
  }, 0);
}

function incidentCrossingCount(
  graph: GraphModel,
  nodeId: string,
  positions: Record<string, Point>,
): number {
  const incident = graph.edges.filter(
    (edge) => edge.a === nodeId || edge.b === nodeId,
  );
  let count = 0;

  for (const first of incident) {
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
        properSegmentIntersection(
          positions[first.a],
          positions[first.b],
          positions[second.a],
          positions[second.b],
        )
      ) {
        count += 1;
      }
    }
  }

  return count;
}

/**
 * Conservative kink optimizer.
 *
 * A station only moves if a candidate reduces the local route-bend penalty,
 * keeps passenger spacing, and does not add crossings to any incident edge.
 * This is slower than the free relaxation above but appropriate for the final
 * map-quality pass where topology regressions are unacceptable.
 */
export function relaxPathKinksSafely(
  graph: GraphModel,
  input: Record<string, Point>,
  options: SafeKinkRelaxOptions,
): Record<string, Point> {
  const positions = Object.fromEntries(
    Object.entries(input).map(([id, point]) => [id, { ...point }]),
  );
  const threshold = (options.thresholdDegrees * Math.PI) / 180;

  const occurrenceMap = new Map(
    graph.nodes.map((node) => [
      node.id,
      localPathOccurrences(graph, node.id),
    ]),
  );

  for (let pass = 0; pass < options.passes; pass += 1) {
    let changed = false;

    const ranked = graph.nodes
      .map((node) => {
        const occurrences = occurrenceMap.get(node.id) ?? [];
        return {
          node,
          occurrences,
          penalty: localBendPenalty(
            node.id,
            positions,
            occurrences,
            threshold,
          ),
        };
      })
      .filter((item) => item.penalty > 1e-6)
      .sort((a, b) => b.penalty - a.penalty);

    for (const item of ranked) {
      const nodeId = item.node.id;
      const occurrences = item.occurrences;
      if (!occurrences.length) continue;

      const midpoint = occurrences.reduce(
        (sum, occurrence) => ({
          x:
            sum.x +
            (positions[occurrence.previous].x +
              positions[occurrence.next].x) /
              2,
          y:
            sum.y +
            (positions[occurrence.previous].y +
              positions[occurrence.next].y) /
              2,
        }),
        { x: 0, y: 0 },
      );
      midpoint.x /= occurrences.length;
      midpoint.y /= occurrences.length;

      const original = { ...positions[nodeId] };
      const originalPenalty = localBendPenalty(
        nodeId,
        positions,
        occurrences,
        threshold,
      );
      const originalCrossings = incidentCrossingCount(
        graph,
        nodeId,
        positions,
      );

      let best = original;
      let bestPenalty = originalPenalty;
      const maximumShift = structuralNode(graph, nodeId)
        ? options.structuralMaxShift
        : options.maxShift;

      for (const factor of [0.18, 0.32, 0.5, 0.68, 0.82]) {
        let dx = (midpoint.x - original.x) * factor;
        let dy = (midpoint.y - original.y) * factor;
        const shift = Math.hypot(dx, dy);
        if (shift > maximumShift) {
          dx = (dx / shift) * maximumShift;
          dy = (dy / shift) * maximumShift;
        }

        const candidate = {
          x: original.x + dx,
          y: original.y + dy,
        };

        let spacingSafe = true;
        for (const other of graph.nodes) {
          if (other.id === nodeId) continue;
          if (
            distance(candidate, positions[other.id]) <
            options.minimumNodeDistance
          ) {
            spacingSafe = false;
            break;
          }
        }
        if (!spacingSafe) continue;

        positions[nodeId] = candidate;
        const penalty = localBendPenalty(
          nodeId,
          positions,
          occurrences,
          threshold,
        );
        const crossings = incidentCrossingCount(
          graph,
          nodeId,
          positions,
        );

        if (
          crossings <= originalCrossings &&
          penalty < bestPenalty * 0.94
        ) {
          best = candidate;
          bestPenalty = penalty;
        }
      }

      positions[nodeId] = best;
      if (best.x !== original.x || best.y !== original.y) {
        changed = true;
      }
    }

    if (!changed) break;
  }

  return positions;
}


export interface SafeZigzagCollapseOptions {
  angleStep: number;
  passes: number;
  minimumTurnDegrees?: number;
  minimumNodeDistance: number;
  maxShift: number;
  structuralMaxShift: number;
}

function angularDeviationDegrees(
  a: Point,
  b: Point,
  angleStep: number,
): number {
  const step = (angleStep * Math.PI) / 180;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const snapped = Math.round(angle / step) * step;
  let diff = Math.abs(angle - snapped);
  while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
  return (diff * 180) / Math.PI;
}

function fourPointZigzagPenalty(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  minimumTurn: number,
): number {
  const first = signedHeadingChange(a, b, c);
  const second = signedHeadingChange(b, c, d);
  if (
    Math.abs(first) < minimumTurn ||
    Math.abs(second) < minimumTurn ||
    Math.sign(first) === Math.sign(second)
  ) {
    return 0;
  }

  return Math.abs(first) + Math.abs(second);
}

function candidateSpacingIsSafe(
  graph: GraphModel,
  positions: Record<string, Point>,
  candidateIds: string[],
  candidates: Record<string, Point>,
  minimumDistance: number,
): boolean {
  const moving = new Set(candidateIds);

  for (let index = 0; index < candidateIds.length; index += 1) {
    const id = candidateIds[index];
    const point = candidates[id];

    for (let otherIndex = index + 1; otherIndex < candidateIds.length; otherIndex += 1) {
      const otherId = candidateIds[otherIndex];
      if (distance(point, candidates[otherId]) < minimumDistance) {
        return false;
      }
    }

    for (const other of graph.nodes) {
      if (moving.has(other.id)) continue;
      if (distance(point, positions[other.id]) < minimumDistance) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Removes short alternating S-bends without changing route topology.
 *
 * The old solver only attacked very sharp single corners (> ~80°), so a
 * sequence of +45° / -45° bends could survive all the way to rendering and
 * appear as a saw-tooth. This pass works on four-station windows, replaces
 * the two middle points with one angular-grid corridor, and accepts the move
 * only when the zig-zag penalty falls while spacing, self-crossings and
 * external crossings do not regress.
 */
export function collapseRouteZigzagsSafely(
  graph: GraphModel,
  input: Record<string, Point>,
  options: SafeZigzagCollapseOptions,
): Record<string, Point> {
  const positions = Object.fromEntries(
    Object.entries(input).map(([id, point]) => [id, { ...point }]),
  );
  const minimumTurn =
    ((options.minimumTurnDegrees ?? 24) * Math.PI) / 180;

  for (let pass = 0; pass < options.passes; pass += 1) {
    let changed = false;

    for (const line of graph.lines) {
      for (const path of line.paths) {
        if (path.length < 4) continue;

        for (let index = 0; index < path.length - 3; index += 1) {
          const ids = path.slice(index, index + 4);
          const [aId, bId, cId, dId] = ids;
          if (new Set(ids).size < 4) continue;

          const beforePenalty = fourPointZigzagPenalty(
            positions[aId],
            positions[bId],
            positions[cId],
            positions[dId],
            minimumTurn,
          );
          if (beforePenalty <= 1e-9) continue;

          const corridor = angularTwoSegmentPath(
            positions[aId],
            positions[dId],
            options.angleStep,
            [positions[bId], positions[cId]],
          );
          const fractions = cumulativeFractions(ids, positions, 0.68);
          if (fractions.length !== 2) continue;

          const rawTargets = {
            [bId]: samplePolyline(corridor, fractions[0]),
            [cId]: samplePolyline(corridor, fractions[1]),
          };

          const movingIds = [bId, cId];
          const targets: Record<string, Point> = {};
          for (const nodeId of movingIds) {
            const original = positions[nodeId];
            const rawTarget = rawTargets[nodeId];
            const limit = structuralNode(graph, nodeId)
              ? options.structuralMaxShift
              : options.maxShift;
            const dx = rawTarget.x - original.x;
            const dy = rawTarget.y - original.y;
            const shift = Math.hypot(dx, dy);
            const ratio =
              shift <= limit || shift < 1e-9
                ? 1
                : limit / shift;
            targets[nodeId] = {
              x: original.x + dx * ratio,
              y: original.y + dy * ratio,
            };
          }

          if (
            !candidateSpacingIsSafe(
              graph,
              positions,
              movingIds,
              targets,
              options.minimumNodeDistance,
            )
          ) {
            continue;
          }

          const affected = new Set(movingIds);
          const beforeSelf = nodePathSelfCrossingCount(
            graph,
            affected,
            positions,
          );
          const beforeCrossing =
            incidentCrossingCount(graph, bId, positions) +
            incidentCrossingCount(graph, cId, positions);
          const beforeAxis =
            angularDeviationDegrees(positions[aId], positions[bId], options.angleStep) +
            angularDeviationDegrees(positions[bId], positions[cId], options.angleStep) +
            angularDeviationDegrees(positions[cId], positions[dId], options.angleStep);

          const oldB = positions[bId];
          const oldC = positions[cId];
          positions[bId] = targets[bId];
          positions[cId] = targets[cId];

          const afterPenalty = fourPointZigzagPenalty(
            positions[aId],
            positions[bId],
            positions[cId],
            positions[dId],
            minimumTurn,
          );
          const afterSelf = nodePathSelfCrossingCount(
            graph,
            affected,
            positions,
          );
          const afterCrossing =
            incidentCrossingCount(graph, bId, positions) +
            incidentCrossingCount(graph, cId, positions);
          const afterAxis =
            angularDeviationDegrees(positions[aId], positions[bId], options.angleStep) +
            angularDeviationDegrees(positions[bId], positions[cId], options.angleStep) +
            angularDeviationDegrees(positions[cId], positions[dId], options.angleStep);

          const accepted =
            afterPenalty <= beforePenalty * 0.9 &&
            afterSelf <= beforeSelf &&
            afterCrossing <= beforeCrossing &&
            afterAxis <= beforeAxis + 2.5;

          if (accepted) {
            changed = true;
          } else {
            positions[bId] = oldB;
            positions[cId] = oldC;
          }
        }
      }
    }

    if (!changed) break;
  }

  return positions;
}


function pathSelfCrossings(
  path: string[],
  positions: Record<string, Point>,
): number {
  let count = 0;
  for (let first = 0; first < path.length - 1; first += 1) {
    for (
      let second = first + 2;
      second < path.length - 1;
      second += 1
    ) {
      if (
        properSegmentIntersection(
          positions[path[first]],
          positions[path[first + 1]],
          positions[path[second]],
          positions[path[second + 1]],
        )
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function pathExternalCrossings(
  graph: GraphModel,
  path: string[],
  positions: Record<string, Point>,
): number {
  const pathEdges = new Set<string>();
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    pathEdges.add(a < b ? `${a}::${b}` : `${b}::${a}`);
  }

  let count = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const aId = path[index];
    const bId = path[index + 1];

    for (const edge of graph.edges) {
      if (pathEdges.has(edge.key)) continue;
      if (
        edge.a === aId ||
        edge.b === aId ||
        edge.a === bId ||
        edge.b === bId
      ) {
        continue;
      }
      if (
        properSegmentIntersection(
          positions[aId],
          positions[bId],
          positions[edge.a],
          positions[edge.b],
        )
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Repairs route self-crossings introduced by a schematic transform.
 *
 * If the reference path has no self-crossing, interpolate the schematic
 * endpoint displacements across the clean reference shape. The candidate is
 * accepted only when it reduces self-crossings, keeps station spacing, and
 * does not increase crossings against the rest of the network.
 */
export function repairIntroducedPathSelfCrossings(
  graph: GraphModel,
  input: Record<string, Point>,
  reference: Record<string, Point>,
  minimumNodeDistance = 28,
): Record<string, Point> {
  const positions = Object.fromEntries(
    Object.entries(input).map(([id, point]) => [id, { ...point }]),
  );

  for (const line of graph.lines) {
    for (const path of line.paths) {
      if (path.length < 4) continue;

      const currentSelf = pathSelfCrossings(path, positions);
      if (currentSelf === 0) continue;
      if (pathSelfCrossings(path, reference) !== 0) continue;

      const currentExternal = pathExternalCrossings(
        graph,
        path,
        positions,
      );
      const startId = path[0];
      const endId = path[path.length - 1];
      const referenceStart = reference[startId];
      const referenceEnd = reference[endId];
      const targetStart = positions[startId];
      const targetEnd = positions[endId];

      const referenceDx = referenceEnd.x - referenceStart.x;
      const referenceDy = referenceEnd.y - referenceStart.y;
      const targetDx = targetEnd.x - targetStart.x;
      const targetDy = targetEnd.y - targetStart.y;
      const referenceLength = Math.hypot(referenceDx, referenceDy);
      const targetLength = Math.hypot(targetDx, targetDy);

      // Closed rings need their own circular solver; this repair is for open
      // paths whose two endpoints define a stable similarity transform.
      if (referenceLength < 1e-6 || targetLength < 1e-6) continue;

      const scaleFactor = targetLength / referenceLength;
      const referenceAngle = Math.atan2(referenceDy, referenceDx);
      const targetAngle = Math.atan2(targetDy, targetDx);
      const rotation = targetAngle - referenceAngle;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);

      const referenceTarget: Record<string, Point> = {};
      for (let index = 1; index < path.length - 1; index += 1) {
        const nodeId = path[index];
        const rx = reference[nodeId].x - referenceStart.x;
        const ry = reference[nodeId].y - referenceStart.y;
        referenceTarget[nodeId] = {
          x:
            targetStart.x +
            (rx * cos - ry * sin) * scaleFactor,
          y:
            targetStart.y +
            (rx * sin + ry * cos) * scaleFactor,
        };
      }

      const interiorIds = path.slice(1, -1);
      const affected = new Set(interiorIds);
      const affectedPaths = graph.lines.flatMap((affectedLine) =>
        affectedLine.paths
          .filter((affectedPath) =>
            affectedPath.some((nodeId) => affected.has(nodeId)),
          )
          .map((affectedPath) => ({
            path: affectedPath,
            before: pathSelfCrossings(affectedPath, positions),
          })),
      );

      type RepairCandidate = {
        positions: Record<string, Point>;
        selfCrossings: number;
        externalCrossings: number;
      };
      let bestExternalSafe: RepairCandidate | undefined;
      let bestTopologyFallback: RepairCandidate | undefined;

      // A full similarity restore is sometimes too aggressive: it can fix
      // the target route while creating a new crossing against another line.
      // Search progressively smaller blends toward the clean reference shape
      // and keep the strongest move that improves the self-crossing without
      // sacrificing any other route touching the moved stations.
      for (const blend of [1, 0.82, 0.66, 0.5, 0.36, 0.24, 0.14]) {
        const candidate = Object.fromEntries(
          Object.entries(positions).map(([id, point]) => [
            id,
            { ...point },
          ]),
        );

        for (const nodeId of interiorIds) {
          candidate[nodeId] = {
            x:
              positions[nodeId].x * (1 - blend) +
              referenceTarget[nodeId].x * blend,
            y:
              positions[nodeId].y * (1 - blend) +
              referenceTarget[nodeId].y * blend,
          };
        }

        const candidatePoints = Object.fromEntries(
          interiorIds.map((nodeId) => [nodeId, candidate[nodeId]]),
        );
        if (
          !candidateSpacingIsSafe(
            graph,
            positions,
            interiorIds,
            candidatePoints,
            minimumNodeDistance,
          )
        ) {
          continue;
        }

        const candidateSelf = pathSelfCrossings(path, candidate);
        const candidateExternal = pathExternalCrossings(
          graph,
          path,
          candidate,
        );
        const affectedPathsSafe = affectedPaths.every(
          ({ path: affectedPath, before }) =>
            pathSelfCrossings(affectedPath, candidate) <= before,
        );

        if (
          candidateSelf >= currentSelf ||
          !affectedPathsSafe
        ) {
          continue;
        }

        const repairCandidate: RepairCandidate = {
          positions: candidate,
          selfCrossings: candidateSelf,
          externalCrossings: candidateExternal,
        };

        if (candidateExternal <= currentExternal) {
          if (
            !bestExternalSafe ||
            candidateSelf < bestExternalSafe.selfCrossings ||
            (candidateSelf === bestExternalSafe.selfCrossings &&
              candidateExternal < bestExternalSafe.externalCrossings)
          ) {
            bestExternalSafe = repairCandidate;
          }
        }

        // Self-crossings are the hardest topology failure. If no candidate can
        // also preserve the external-crossing count, retain a zero-self-cross
        // fallback rather than leaving a route folded over itself.
        if (candidateSelf === 0) {
          if (
            !bestTopologyFallback ||
            candidateExternal < bestTopologyFallback.externalCrossings
          ) {
            bestTopologyFallback = repairCandidate;
          }
        }
      }

      // Route self-crossing is the hard topology failure. Prefer a candidate
      // that fully unfolds the path; among those, the search already keeps
      // the one with the smallest external-crossing cost. Only fall back to a
      // partial but external-safe repair when no zero-self-cross solution is
      // available within the bounded search.
      const best = bestTopologyFallback ?? bestExternalSafe;
      if (best) {
        for (const nodeId of interiorIds) {
          positions[nodeId] = best.positions[nodeId];
        }
      }
    }
  }

  return positions;
}


function nodePathSelfCrossingCount(
  graph: GraphModel,
  nodeIds: Set<string>,
  positions: Record<string, Point>,
): number {
  let total = 0;
  for (const line of graph.lines) {
    for (const path of line.paths) {
      if (!path.some((id) => nodeIds.has(id))) continue;
      total += pathSelfCrossings(path, positions);
    }
  }
  return total;
}

/**
 * Topology-aware station separation.
 *
 * Unlike the generic finalizer repulsion, a proposed move is accepted only
 * when it does not add an incident edge crossing and does not increase
 * self-crossings on any route path touching the moved stations.
 */
export function separateNodesSafely(
  graph: GraphModel,
  input: Record<string, Point>,
  minimumDistance = 24,
  iterations = 16,
): Record<string, Point> {
  const positions = Object.fromEntries(
    Object.entries(input).map(([id, point]) => [id, { ...point }]),
  );

  const tryMove = (
    aId: string,
    bId: string,
    aCandidate: Point,
    bCandidate: Point,
  ): boolean => {
    const affected = new Set([aId, bId]);
    const beforeSelf = nodePathSelfCrossingCount(
      graph,
      affected,
      positions,
    );
    const beforeCrossing =
      incidentCrossingCount(graph, aId, positions) +
      incidentCrossingCount(graph, bId, positions);

    const oldA = positions[aId];
    const oldB = positions[bId];
    positions[aId] = aCandidate;
    positions[bId] = bCandidate;

    const afterSelf = nodePathSelfCrossingCount(
      graph,
      affected,
      positions,
    );
    const afterCrossing =
      incidentCrossingCount(graph, aId, positions) +
      incidentCrossingCount(graph, bId, positions);

    if (
      afterSelf <= beforeSelf &&
      afterCrossing <= beforeCrossing
    ) {
      return true;
    }

    positions[aId] = oldA;
    positions[bId] = oldB;
    return false;
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let moved = false;

    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const aId = graph.nodes[i].id;
        const bId = graph.nodes[j].id;
        const a = positions[aId];
        const b = positions[bId];

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let currentDistance = Math.hypot(dx, dy);
        if (currentDistance >= minimumDistance) continue;

        if (currentDistance < 1e-6) {
          const angle =
            ((i * 47 + j * 103) % 360) * (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          currentDistance = 1;
        }

        const nx = dx / currentDistance;
        const ny = dy / currentDistance;
        const required = minimumDistance - currentDistance;

        const trials = [
          [0.5, 0.5],
          [0.35, 0.35],
          [0.7, 0],
          [0, 0.7],
          [0.45, 0],
          [0, 0.45],
        ] as const;

        for (const [aShare, bShare] of trials) {
          const aCandidate = {
            x: a.x - nx * required * aShare,
            y: a.y - ny * required * aShare,
          };
          const bCandidate = {
            x: b.x + nx * required * bShare,
            y: b.y + ny * required * bShare,
          };

          if (
            tryMove(
              aId,
              bId,
              aCandidate,
              bCandidate,
            )
          ) {
            moved = true;
            break;
          }
        }
      }
    }

    if (!moved) break;
  }

  return positions;
}
