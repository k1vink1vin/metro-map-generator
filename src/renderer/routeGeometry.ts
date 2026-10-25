import { edgeKey } from '../core/graph';
import type { GraphModel, LayoutResult, Point } from '../types';
import { buildGeometricBundleMap, offsetPathForLine } from './geometry';

export interface CircleGeometry { center: Point; radius: number }

// Recover the fitted circle, rather than averaging irregularly spaced stations.
export function circleThroughStations(points: Point[]): CircleGeometry | undefined {
  if (points.length < 3) return undefined;
  const a = points[0];
  const b = points.reduce((best, p) => distance(a, p) > distance(a, best) ? p : best);
  const c = points.reduce((best, p) => Math.abs(cross(a, b, p)) > Math.abs(cross(a, b, best)) ? p : best);
  const d = 2 * cross(a, b, c);
  if (Math.abs(d) < 1e-8) return undefined;
  const bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;
  const center = {
    x: a.x + (cy * (bx * bx + by * by) - by * (cx * cx + cy * cy)) / d,
    y: a.y + (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / d,
  };
  const radius = distance(a, center);
  if (points.some(p => Math.abs(distance(p, center) - radius) > radius * 1e-5)) return undefined;
  return { center, radius };
}

function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y); }
function cross(a: Point, b: Point, c: Point) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function intersects(a: Point, b: Point, c: Point, d: Point) {
  return cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8;
}
function unit(a: Point, b: Point): Point {
  const length = distance(a, b);
  return length > 1e-8 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : { x: 0, y: 0 };
}
function cubic(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const u = 1 - t;
  return { x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y };
}

export interface RouteGeometry { d: string; samples: Point[]; arcCount: number; fallbackCount: number }

export interface RenderedRoutePath extends RouteGeometry {
  lineId: string;
  lineColor: string;
  pathIndex: number;
  points: Point[];
}

const routeCache = new WeakMap<LayoutResult, { graph: GraphModel; paths: RenderedRoutePath[] }>();

export function buildRenderedRoutePaths(graph: GraphModel, layout: LayoutResult): RenderedRoutePath[] {
  const cached = routeCache.get(layout);
  if (cached?.graph === graph) return cached.paths;
  const bundles = buildGeometricBundleMap(graph, layout.positions);
  const ringNodes = new Set(layout.style === 'moscow' ? layout.moscowRings?.flatMap(r => r.nodes) ?? [] : []);
  const paths = graph.lines.flatMap(line => line.paths.map((path, pathIndex) => {
    const points = offsetPathForLine(graph, path, layout.positions, line.id, 12, bundles)
      .map((point, i) => ringNodes.has(path[i]) ? layout.positions[path[i]] : point);
    const geometry = stationAnchoredPath(graph, layout, path, points, line.id);
    return { ...geometry, lineId: line.id, lineColor: line.pathColors?.[pathIndex] ?? line.color,
      pathIndex, points: geometry.samples };
  }));
  routeCache.set(layout, { graph, paths });
  return paths;
}

export function sampledSelfCrossings(points: Point[]): number {
  let count = 0;
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 2; j < points.length - 1; j++) {
      if (intersects(points[i], points[i + 1], points[j], points[j + 1])) count++;
    }
  }
  return count;
}

/** Interpolate stations; never cut across an interchange to round its corner.
 * Curves are bounded by local station spacing. Reject smoothing that adds a
 * crossing against a nonincident topology edge. Ring edges use exact SVG arcs.
 */
export function stationAnchoredPath(
  graph: GraphModel, layout: LayoutResult, path: string[], points: Point[], lineId?: string,
): RouteGeometry {
  if (!points.length) return { d: '', samples: [], arcCount: 0, fallbackCount: 0 };
  const rings = new Map<string, CircleGeometry>();
  if (layout.style === 'moscow') {
    for (const ring of layout.moscowRings ?? []) {
      const circle = circleThroughStations(ring.nodes.map(id => layout.positions[id]));
      if (!circle) continue;
      for (let i = 0; i < ring.nodes.length; i++) rings.set(edgeKey(ring.nodes[i], ring.nodes[(i + 1) % ring.nodes.length]), circle);
    }
  }
  const closed = path.length > 2 && path[0] === path[path.length - 1];
  const tangent = (i: number): Point => {
    const last = points.length - 1;
    if (!closed && i === 0) return unit(points[0], points[1]);
    if (!closed && i === last) return unit(points[last - 1], points[last]);
    const before = points[i === 0 ? last - 1 : i - 1];
    const after = points[i === last ? 1 : i + 1];
    const incoming = unit(before, points[i]), outgoing = unit(points[i], after);
    return unit({ x: 0, y: 0 }, { x: incoming.x + outgoing.x, y: incoming.y + outgoing.y });
  };
  const commands = [`M ${points[0].x} ${points[0].y}`];
  const samples = [points[0]];
  let arcCount = 0, fallbackCount = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const circle = rings.get(edgeKey(path[i], path[i + 1]));
    // Ring geometry must remain exactly on its circle, including shared edges.
    if (circle) {
      const start = layout.positions[path[i]], end = layout.positions[path[i + 1]];
      const lanes = [...(graph.edgeByKey.get(edgeKey(path[i], path[i + 1]))?.lineIds ?? [])].sort();
      const offset = lineId && lanes.length > 1 ? (lanes.indexOf(lineId) - (lanes.length - 1) / 2) * 12 : 0;
      const radius = Math.max(1, circle.radius + offset);
      const onLane = (point: Point): Point => ({
        x: circle.center.x + (point.x - circle.center.x) * radius / circle.radius,
        y: circle.center.y + (point.y - circle.center.y) * radius / circle.radius,
      });
      const laneStart = onLane(start), laneEnd = onLane(end);
      let delta = Math.atan2(end.y - circle.center.y, end.x - circle.center.x) - Math.atan2(start.y - circle.center.y, start.x - circle.center.x);
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      if (distance(samples[samples.length - 1], laneStart) > 1e-6) {
        commands.push(`L ${laneStart.x} ${laneStart.y}`);
        samples.push(laneStart);
      }
      commands.push(`A ${radius} ${radius} 0 0 ${delta > 0 ? 1 : 0} ${laneEnd.x} ${laneEnd.y}`);
      const angle = Math.atan2(start.y - circle.center.y, start.x - circle.center.x);
      const steps = Math.max(8, Math.ceil(Math.abs(delta) * radius / 3));
      for (let step = 1; step <= steps; step++) {
        const theta = angle + delta * step / steps;
        samples.push({ x: circle.center.x + radius * Math.cos(theta), y: circle.center.y + radius * Math.sin(theta) });
      }
      if (offset) { commands.push(`L ${end.x} ${end.y}`); samples.push(end); }
      arcCount++;
      continue;
    }
    const length = distance(a, b);
    const ta = tangent(i), tb = tangent(i + 1);
    const strength = layout.style === 'moscow' ? 0.28 : layout.style === 'geographic' ? 0.08 : layout.style === 'london' || layout.style === 'hex' ? 0.38 : 0.18;
    const previousLength = i > 0 ? distance(points[i - 1], a) : length;
    const nextLength = i + 2 < points.length ? distance(b, points[i + 2]) : length;
    const obstacles = graph.edges.filter(e => ![e.a, e.b].some(id => id === path[i] || id === path[i + 1]));
    let accepted = false;
    for (const factor of [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125, 0.00390625]) {
      const h1 = Math.min(length, previousLength) * strength * factor;
      const h2 = Math.min(length, nextLength) * strength * factor;
      const c1 = { x: a.x + ta.x * h1, y: a.y + ta.y * h1 };
      const c2 = { x: b.x - tb.x * h2, y: b.y - tb.y * h2 };
      const schematic = layout.style === 'london' || layout.style === 'hex';
      const direction = unit(a, b);
      const startRadius = Math.min(length * 0.16, previousLength * 0.16, 18) * factor;
      const endRadius = Math.min(length * 0.16, nextLength * 0.16, 18) * factor;
      const along = (p: Point, amount: number): Point => ({x:p.x+direction.x*amount,y:p.y+direction.y*amount});
      const startEnd = along(a, 3 * startRadius), endStart = along(b, -3 * endRadius);
      const startControl = {x:a.x+ta.x*startRadius,y:a.y+ta.y*startRadius};
      const endControl = {x:b.x-tb.x*endRadius,y:b.y-tb.y*endRadius};
      // Straight station corridors, with short tangent-continuous transitions
      // at their ends. Do not turn the entire edge into a flowing spline.
      const curve = schematic ? [
        ...Array.from({length:13},(_,s)=>cubic(a,startControl,along(startEnd,-startRadius),startEnd,s/12)),
        endStart,
        ...Array.from({length:12},(_,s)=>cubic(endStart,along(endStart,endRadius),endControl,b,(s+1)/12)),
      ] : Array.from({ length: 25 }, (_, step) => cubic(a, c1, c2, b, step / 24));
      const safe = !curve.slice(1).some((p, j) =>
        samples.slice(1, -1).some((q, k) => intersects(curve[j], p, samples[k], q)),
      ) && obstacles.every(e => {
        const c = layout.positions[e.a], d = layout.positions[e.b];
        if (intersects(a, b, c, d)) return true;
        return !curve.slice(1).some((p, j) => intersects(curve[j], p, c, d));
      }) && graph.nodes.every(node => {
        if (node.id === path[i] || node.id === path[i + 1]) return true;
        const p = layout.positions[node.id];
        const clearance = Math.min(12, ...Array.from({ length: 25 }, (_, step) => distance(p, { x: a.x + (b.x - a.x) * step / 24, y: a.y + (b.y - a.y) * step / 24 })));
        return curve.every(q => distance(p, q) >= clearance - 0.1);
      });
      if (!safe) continue;
      if (schematic) {
        const sc = along(startEnd,-startRadius), ec = along(endStart,endRadius);
        commands.push(`C ${startControl.x} ${startControl.y} ${sc.x} ${sc.y} ${startEnd.x} ${startEnd.y} L ${endStart.x} ${endStart.y} C ${ec.x} ${ec.y} ${endControl.x} ${endControl.y} ${b.x} ${b.y}`);
      } else commands.push(`C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`);
      samples.push(...curve.slice(1));
      accepted = true;
      break;
    }
    if (!accepted) { commands.push(`L ${b.x} ${b.y}`); samples.push(b); fallbackCount++; }
  }
  return { d: commands.join(' '), samples, arcCount, fallbackCount };
}
