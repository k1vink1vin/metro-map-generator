import { edgeKey } from '../core/graph';
import type { GraphModel, Point } from '../types';

export type GeometricBundleMap = Map<string, string[]>;

function pointToken(point: Point, tolerance = 1): string {
  return `${Math.round(point.x / tolerance)},${Math.round(point.y / tolerance)}`;
}

function geometricSegmentKey(a: Point, b: Point): string {
  const aToken = pointToken(a);
  const bToken = pointToken(b);
  return aToken < bToken ? `${aToken}::${bToken}` : `${bToken}::${aToken}`;
}

/**
 * Finds segments that land on the same geometry even when they are not the
 * same topology edge. This prevents unrelated routes from visually erasing
 * each other after a schematic layout happens to align them.
 */
export function buildGeometricBundleMap(
  graph: GraphModel,
  positions: Record<string, Point>,
): GeometricBundleMap {
  const buckets = new Map<string, Set<string>>();

  for (const line of graph.lines) {
    for (const path of line.paths) {
      for (let index = 0; index < path.length - 1; index += 1) {
        const a = positions[path[index]];
        const b = positions[path[index + 1]];
        if (!a || !b) continue;

        const key = geometricSegmentKey(a, b);
        const bucket = buckets.get(key) ?? new Set<string>();
        bucket.add(line.id);
        buckets.set(key, bucket);
      }
    }
  }

  return new Map(
    [...buckets.entries()].map(([key, lineIds]) => [
      key,
      [...lineIds].sort(),
    ]),
  );
}

function segmentOffset(
  graph: GraphModel,
  aId: string,
  bId: string,
  a: Point,
  b: Point,
  lineId: string,
  gap: number,
  geometricBundles?: GeometricBundleMap,
): number {
  const edge = graph.edgeByKey.get(edgeKey(aId, bId));
  const topologyOrder = edge?.lineIds ?? [];
  const geometricOrder =
    geometricBundles?.get(geometricSegmentKey(a, b)) ?? [];

  const order =
    geometricOrder.length > topologyOrder.length
      ? geometricOrder
      : [...topologyOrder].sort();

  if (order.length <= 1) return 0;

  const index = Math.max(0, order.indexOf(lineId));
  const centered = index - (order.length - 1) / 2;

  // Tie the side to a stable geometric direction so a segment keeps the same
  // lane ordering even when one route traverses it in reverse.
  const aToken = pointToken(a);
  const bToken = pointToken(b);
  const directionSign = aToken < bToken ? 1 : -1;

  return centered * gap * directionSign;
}

export function offsetPathForLine(
  graph: GraphModel,
  path: string[],
  positions: Record<string, Point>,
  lineId: string,
  gap = 12,
  geometricBundles?: GeometricBundleMap,
): Point[] {
  if (path.length <= 1) {
    return path.map((id) => ({ ...positions[id] }));
  }

  type OffsetSegment = {
    a: Point;
    b: Point;
    direction: Point;
    normal: Point;
    offset: number;
  };

  const segments: OffsetSegment[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const aId = path[index];
    const bId = path[index + 1];
    const a = positions[aId];
    const b = positions[bId];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    const direction = { x: dx / length, y: dy / length };
    const normal = { x: -direction.y, y: direction.x };
    const offset = segmentOffset(
      graph,
      aId,
      bId,
      a,
      b,
      lineId,
      gap,
      geometricBundles,
    );
    const shift = {
      x: normal.x * offset,
      y: normal.y * offset,
    };
    segments.push({
      a: { x: a.x + shift.x, y: a.y + shift.y },
      b: { x: b.x + shift.x, y: b.y + shift.y },
      direction,
      normal,
      offset,
    });
  }

  const lineIntersection = (
    p: Point,
    d: Point,
    q: Point,
    e: Point,
  ): Point | undefined => {
    const det = d.x * e.y - d.y * e.x;
    if (Math.abs(det) < 1e-8) return undefined;
    const qpx = q.x - p.x;
    const qpy = q.y - p.y;
    const t = (qpx * e.y - qpy * e.x) / det;
    return {
      x: p.x + d.x * t,
      y: p.y + d.y * t,
    };
  };

  const result: Point[] = [];
  result.push({ ...segments[0].a });

  for (let index = 1; index < path.length - 1; index += 1) {
    const previous = segments[index - 1];
    const next = segments[index];
    const vertex = positions[path[index]];
    const intersection = lineIntersection(
      previous.b,
      previous.direction,
      next.a,
      next.direction,
    );

    if (intersection) {
      // A true miter keeps this vertex on BOTH constant-offset lines, so the
      // lane gap remains exactly parallel through a 45°/60° bend.
      const miterDistance = Math.hypot(
        intersection.x - vertex.x,
        intersection.y - vertex.y,
      );
      const expected =
        Math.max(
          Math.abs(previous.offset),
          Math.abs(next.offset),
          gap,
        );
      // Extremely shallow reversals can send the mathematical intersection
      // far away. In that degenerate case prefer a bounded bevel transition.
      if (miterDistance <= expected * 5 + 12) {
        result.push(intersection);
        continue;
      }
    }

    // Collinear bundle starts/ends cannot share one exact offset point.
    // Average only for that split/merge transition; the interior of every
    // genuinely parallel segment remains at its exact lane offset.
    result.push({
      x: (previous.b.x + next.a.x) / 2,
      y: (previous.b.y + next.a.y) / 2,
    });
  }

  result.push({ ...segments[segments.length - 1].b });
  return result;
}

export function roundedPath(
  points: Point[],
  radius = 14,
  maxTrimRatio = 0.32,
): string {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  const commands = [`M ${points[0].x} ${points[0].y}`];

  for (let i = 1; i < points.length - 1; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const next = points[i + 1];

    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outLength = Math.hypot(next.x - current.x, next.y - current.y);
    const trim = Math.min(
      radius,
      inLength * maxTrimRatio,
      outLength * maxTrimRatio,
    );

    const start = {
      x: current.x + ((previous.x - current.x) / Math.max(1, inLength)) * trim,
      y: current.y + ((previous.y - current.y) / Math.max(1, inLength)) * trim,
    };
    const end = {
      x: current.x + ((next.x - current.x) / Math.max(1, outLength)) * trim,
      y: current.y + ((next.y - current.y) / Math.max(1, outLength)) * trim,
    };

    commands.push(`L ${start.x} ${start.y}`);
    commands.push(`Q ${current.x} ${current.y} ${end.x} ${end.y}`);
  }

  const last = points[points.length - 1];
  commands.push(`L ${last.x} ${last.y}`);
  return commands.join(' ');
}
