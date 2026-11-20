import type { GraphModel, Point } from '../types';
import type { RenderedRoutePath } from './routeGeometry';

interface Segment {
  route: number;
  from: Point;
  to: Point;
}

export interface CrossingGap extends Point {
  radius: number;
}

function intersection(a: Segment, b: Segment) {
  const ax = a.to.x - a.from.x;
  const ay = a.to.y - a.from.y;
  const bx = b.to.x - b.from.x;
  const by = b.to.y - b.from.y;
  const determinant = ax * by - ay * bx;
  const sine = Math.abs(determinant) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
  if (sine < 0.12 || !Number.isFinite(sine)) return undefined;
  const dx = b.from.x - a.from.x;
  const dy = b.from.y - a.from.y;
  const t = (dx * by - dy * bx) / determinant;
  const u = (dx * ay - dy * ax) / determinant;
  const epsilon = 1e-7;
  if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) return undefined;
  return { x: a.from.x + ax * t, y: a.from.y + ay * t, sine };
}

/** Leave a break under the later-drawn route at crossings away from stations. */
export function routeCrossingGaps(
  graph: GraphModel,
  positions: Record<string, Point>,
  routes: RenderedRoutePath[],
  routeWidth: number,
): CrossingGap[][] {
  const stationPoints = routes.map(path =>
    graph.lines.find(line => line.id === path.lineId)!.paths[path.pathIndex].map(id => positions[id]),
  );
  const gaps: CrossingGap[][] = routes.map(() => []);
  const grid = new Map<string, Segment[]>();
  const step = 48;

  for (let route = 0; route < routes.length; route++) {
    const path = routes[route];
    for (let index = 1; index < path.samples.length; index++) {
      const from = path.samples[index - 1];
      const to = path.samples[index];
      const keys: string[] = [];
      for (let x = Math.floor(Math.min(from.x, to.x) / step); x <= Math.floor(Math.max(from.x, to.x) / step); x++) {
        for (let y = Math.floor(Math.min(from.y, to.y) / step); y <= Math.floor(Math.max(from.y, to.y) / step); y++) {
          keys.push(`${x},${y}`);
        }
      }
      const segment = { route, from, to };
      const candidates = new Set(keys.flatMap(key => grid.get(key) ?? []));
      for (const earlier of candidates) {
        if (earlier.route === route || routes[earlier.route].lineId === path.lineId) continue;
        const cross = intersection(segment, earlier);
        if (!cross) continue;
        const radius = Math.min(routeWidth * 2, (routeWidth / 2 + 3.5) / cross.sine);
        const nearbyStation = [...stationPoints[route], ...stationPoints[earlier.route]]
          .some(point => Math.hypot(cross.x - point.x, cross.y - point.y) < radius + 3);
        if (nearbyStation || gaps[earlier.route].some(gap => Math.hypot(cross.x - gap.x, cross.y - gap.y) < 2)) continue;
        gaps[earlier.route].push({ x: cross.x, y: cross.y, radius });
      }
      for (const key of keys) {
        const bucket = grid.get(key) ?? [];
        bucket.push(segment);
        grid.set(key, bucket);
      }
    }
  }
  return gaps;
}


// A compound even-odd clipping path needs non-overlapping holes. Where
// breaks overlap, intersect separate clip paths so the shared area stays cut.
export function disjointGapGroups(gaps: CrossingGap[]): CrossingGap[][] {
  const groups: CrossingGap[][] = [];
  for (const gap of gaps) {
    const group = groups.find(items => items.every(other =>
      Math.hypot(gap.x - other.x, gap.y - other.y) >= gap.radius + other.radius,
    ));
    if (group) group.push(gap);
    else groups.push([gap]);
  }
  return groups;
}
