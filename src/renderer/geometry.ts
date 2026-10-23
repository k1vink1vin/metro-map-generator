import { edgeKey } from '../core/graph';
import type { GraphModel, Point } from '../types';

function segmentOffset(
  graph: GraphModel,
  a: string,
  b: string,
  lineId: string,
  gap: number,
): number {
  const edge = graph.edgeByKey.get(edgeKey(a, b));
  if (!edge || edge.lineIds.length <= 1) return 0;

  const order = [...edge.lineIds].sort();
  const index = Math.max(0, order.indexOf(lineId));
  const centered = index - (order.length - 1) / 2;
  // The sign is tied to canonical node ordering so the physical side remains
  // stable even when a route traverses the same edge in reverse.
  const directionSign = a < b ? 1 : -1;
  return centered * gap * directionSign;
}

export function offsetPathForLine(
  graph: GraphModel,
  path: string[],
  positions: Record<string, Point>,
  lineId: string,
  gap = 8,
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
    const offset = segmentOffset(graph, aId, bId, lineId, gap);
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
