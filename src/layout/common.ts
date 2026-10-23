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
    const snapped = snappedVector(start, end, angleStep, length);
    return [start, add(start, snapped)];
  }

  if (
    lowerLength < length * 0.08 ||
    upperLength < length * 0.08
  ) {
    const snapped = snappedVector(start, end, angleStep, length);
    return [start, add(start, snapped)];
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
        path.forEach((nodeId, index) => {
          if (structuralNode(graph, nodeId)) anchorIndices.add(index);
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
