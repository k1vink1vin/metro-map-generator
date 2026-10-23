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
