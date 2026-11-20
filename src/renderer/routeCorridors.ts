import type { Point } from '../types';
import type { RenderedRoutePath } from './routeGeometry';

interface Interval {
  start: number;
  end: number;
  route: number;
}

type Corridor = {
  intervals: Interval[];
  unitLength: number;
  path: (start: number, end: number, offset: number) => string;
};

export interface RouteBand {
  casing: string;
  stripes: { d: string; color: string }[];
  width: number;
}

const TAU = Math.PI * 2;
const normalizeAngle = (angle: number) => (angle + TAU) % TAU;
const coordinateKey = (value: number) => Math.round(value * 1000);

export function routeCorridorBands(routes: RenderedRoutePath[], routeWidth: number): RouteBand[][] {
  const groups = new Map<string, Corridor>();
  for (const [route, path] of routes.entries()) {
    let from: Point | undefined;
    for (const part of path.d.matchAll(/([MLA])\s*([^MLA]*)/g)) {
      const values = part[2].trim().split(/\s+/).map(Number);
      const [x, y] = values.slice(-2);
      const to = { x, y };
      const chord = from ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
      if (!from || chord < 1e-7 || part[1] === 'M') {
        from = to;
        continue;
      }
      if (part[1] === 'L') {
        const direction = ((Math.atan2(to.y - from.y, to.x - from.x) % Math.PI) + Math.PI) % Math.PI;
        // Resolve the seam where floating-point noise yields directions a
        // fraction below pi instead of zero.
        const angle = Math.PI - direction < 1e-7 ? 0 : direction;
        const along = { x: Math.cos(angle), y: Math.sin(angle) };
        const normal = { x: -along.y, y: along.x };
        const intercept = from.x * normal.x + from.y * normal.y;
        const positions = [from, to].map(point => point.x * along.x + point.y * along.y).sort((a, b) => a - b);
        const key = `L/${coordinateKey(angle)}/${coordinateKey(intercept)}`;
        const corridor = groups.get(key) ?? {
          intervals: [], unitLength: 1,
          path: (start: number, end: number, offset: number) => {
            const xy = (t: number) => `${along.x * t + normal.x * (intercept + offset)} ${along.y * t + normal.y * (intercept + offset)}`;
            return `M ${xy(start)} L ${xy(end)}`;
          },
        };
        corridor.intervals.push({ start: positions[0], end: positions[1], route });
        groups.set(key, corridor);
      } else {
        const [radius, , , large, sweep] = values;
        const h = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, radius ** 2 - chord ** 2 / 4));
        const center = {
          x: (from.x + to.x) / 2 - h * (to.y - from.y) / chord,
          y: (from.y + to.y) / 2 + h * (to.x - from.x) / chord,
        };
        const angleAt = (point: Point) => normalizeAngle(Math.atan2(point.y - center.y, point.x - center.x));
        const start = angleAt(sweep ? from : to);
        const end = angleAt(sweep ? to : from);
        const key = `A/${[center.x, center.y, radius].map(coordinateKey).join('/')}`;
        const corridor = groups.get(key) ?? {
          intervals: [], unitLength: radius,
          path: (a: number, b: number, offset: number) => {
            const r = Math.max(1, radius + offset);
            const xy = (t: number) => `${center.x + Math.cos(t) * r} ${center.y + Math.sin(t) * r}`;
            return `M ${xy(a)} A ${r} ${r} 0 ${b - a > Math.PI ? 1 : 0} 1 ${xy(b)}`;
          },
        };
        if (end < start) {
          corridor.intervals.push({ start, end: TAU, route }, { start: 0, end, route });
        } else {
          corridor.intervals.push({ start, end, route });
        }
        groups.set(key, corridor);
      }
      from = to;
    }
  }

  const bands: RouteBand[][] = routes.map(() => []);
  for (const { intervals, unitLength, path } of groups.values()) {
    if (new Set(intervals.map(({ route }) => routes[route].lineColor)).size < 2) continue;
    const ends = [...new Set(intervals.flatMap(({ start, end }) => [start, end]))].sort((a, b) => a - b);
    for (let i = 1; i < ends.length; i++) {
      const [a, b] = [ends[i - 1], ends[i]];
      if ((b - a) * unitLength < 0.05) continue;
      const midpoint = (a + b) / 2;
      const owners = intervals.filter(interval => interval.start <= midpoint && midpoint < interval.end)
        .map(({ route }) => route).sort((x, y) => x - y);
      const colors = [...new Set(owners.map(route => routes[route].lineColor))];
      if (colors.length < 2 || (b - a) * unitLength < 2.5) continue;
      const casing = path(a, b, 0);
      const width = Math.max(routeWidth + 2, colors.length * 3.2) / colors.length;
      bands[owners[owners.length - 1]].push({
        width,
        casing,
        stripes: colors.map((color, index) => ({
          color,
          d: path(a, b, (index - (colors.length - 1) / 2) * width),
        })),
      });
    }
  }
  return bands;
}
