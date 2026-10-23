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

  const contributions = new Map<string, Point[]>();
  for (const id of path) contributions.set(id, []);

  for (let i = 0; i < path.length - 1; i += 1) {
    const aId = path[i];
    const bId = path[i + 1];
    const a = positions[aId];
    const b = positions[bId];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const normal = { x: -dy / length, y: dx / length };
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
    const shift = { x: normal.x * offset, y: normal.y * offset };

    contributions.get(aId)?.push({ x: a.x + shift.x, y: a.y + shift.y });
    contributions.get(bId)?.push({ x: b.x + shift.x, y: b.y + shift.y });
  }

  return path.map((id) => {
    const points = contributions.get(id) ?? [];
    if (!points.length) return { ...positions[id] };
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
  });
}

export function roundedPath(points: Point[], radius = 14): string {
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
    const trim = Math.min(radius, inLength * 0.32, outLength * 0.32);

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
