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


function normalizedAngle(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

function shortestSignedAngle(from: number, to: number): number {
  const tau = Math.PI * 2;
  let delta = ((to - from + Math.PI) % tau + tau) % tau - Math.PI;
  if (delta <= -Math.PI) delta += tau;
  return delta;
}

/**
 * Return a one- or two-segment path whose visible segments lie exactly on the
 * requested angular family. Unlike the layout relaxation this is a hard
 * rendering invariant: 45° styles only emit multiples of 45°, while the hex
 * style only emits multiples of 60°.
 */
function strictAxisPolyline(
  a: Point,
  b: Point,
  stepDegrees: 45 | 60,
): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-8) return [a, b];

  const step = (stepDegrees * Math.PI) / 180;
  const angle = normalizedAngle(Math.atan2(dy, dx));
  const nearest = Math.round(angle / step) * step;
  if (Math.abs(shortestSignedAngle(angle, nearest)) < 1e-7) {
    return [a, b];
  }

  const lower = Math.floor(angle / step) * step;
  const upper = lower + step;
  const u = { x: Math.cos(lower), y: Math.sin(lower) };
  const v = { x: Math.cos(upper), y: Math.sin(upper) };
  const det = u.x * v.y - u.y * v.x;

  if (Math.abs(det) < 1e-9) return [a, b];

  const alpha = (dx * v.y - dy * v.x) / det;
  const beta = (u.x * dy - u.y * dx) / det;
  if (alpha < -1e-6 || beta < -1e-6) return [a, b];

  // Put the small correction next to the station so long corridor segments
  // remain visually dominant instead of becoming a saw-tooth.
  const corner =
    alpha <= beta
      ? { x: a.x + u.x * alpha, y: a.y + u.y * alpha }
      : { x: a.x + v.x * beta, y: a.y + v.y * beta };

  const points = [a, corner, b];
  return points.filter(
    (point, index) =>
      index === 0 ||
      distance(point, points[index - 1]) > 1e-7,
  );
}

interface OrthoradialEdgeGeometry {
  commands: string[];
  samples: Point[];
  arcCount: number;
  length: number;
}

function circularArcSamples(
  center: Point,
  radius: number,
  startAngle: number,
  delta: number,
): Point[] {
  const steps = Math.max(
    4,
    Math.ceil((Math.abs(delta) * Math.max(1, radius)) / 16),
  );
  return Array.from({ length: steps }, (_, index) => {
    const angle = startAngle + (delta * (index + 1)) / steps;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  });
}

function arcCommand(
  radius: number,
  delta: number,
  end: Point,
): string {
  const largeArc = Math.abs(delta) > Math.PI + 1e-8 ? 1 : 0;
  const sweep = delta > 0 ? 1 : 0;
  return `A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`;
}

function arcDeltas(from: number, to: number): number[] {
  const shortest = shortestSignedAngle(from, to);
  if (Math.abs(shortest) < 1e-8) return [0];
  const alternate =
    shortest > 0
      ? shortest - Math.PI * 2
      : shortest + Math.PI * 2;
  return [shortest, alternate];
}

/**
 * Enumerate legal orthoradial connections for one station pair. Every
 * candidate consists exclusively of circular arcs around the common centre
 * and/or radial straight segments. Path-level selection below chooses among
 * them globally so local shortest-arc choices do not make a route fold over
 * itself.
 */
function orthoradialEdgeCandidates(
  a: Point,
  b: Point,
  center: Point,
): OrthoradialEdgeGeometry[] {
  const ax = a.x - center.x;
  const ay = a.y - center.y;
  const bx = b.x - center.x;
  const by = b.y - center.y;
  const ra = Math.hypot(ax, ay);
  const rb = Math.hypot(bx, by);

  if (ra < 1e-7 || rb < 1e-7) {
    return [{
      commands: [`L ${b.x} ${b.y}`],
      samples: [a, b],
      arcCount: 0,
      length: distance(a, b),
    }];
  }

  const aa = Math.atan2(ay, ax);
  const ab = Math.atan2(by, bx);
  const angleDelta = shortestSignedAngle(aa, ab);

  if (Math.abs(angleDelta) < 1e-7) {
    return [{
      commands: [`L ${b.x} ${b.y}`],
      samples: [a, b],
      arcCount: 0,
      length: Math.abs(rb - ra),
    }];
  }

  const candidates: OrthoradialEdgeGeometry[] = [];
  const deltas = arcDeltas(aa, ab);

  if (Math.abs(ra - rb) < 1e-6) {
    for (const delta of deltas) {
      candidates.push({
        commands: [arcCommand(ra, delta, b)],
        samples: [a, ...circularArcSamples(center, ra, aa, delta)],
        arcCount: 1,
        length: Math.abs(delta) * ra,
      });
    }
    return candidates;
  }

  // Option A: circular movement on the start shell, then radial movement.
  for (const delta of deltas) {
    const corner = {
      x: center.x + Math.cos(ab) * ra,
      y: center.y + Math.sin(ab) * ra,
    };
    candidates.push({
      commands: [
        arcCommand(ra, delta, corner),
        `L ${b.x} ${b.y}`,
      ],
      samples: [
        a,
        ...circularArcSamples(center, ra, aa, delta),
        b,
      ],
      arcCount: 1,
      length: Math.abs(delta) * ra + Math.abs(rb - ra),
    });
  }

  // Option B: radial movement first, then circular movement on the end shell.
  for (const delta of deltas) {
    const corner = {
      x: center.x + Math.cos(aa) * rb,
      y: center.y + Math.sin(aa) * rb,
    };
    candidates.push({
      commands: [
        `L ${corner.x} ${corner.y}`,
        arcCommand(rb, delta, b),
      ],
      samples: [
        a,
        corner,
        ...circularArcSamples(center, rb, aa, delta),
      ],
      arcCount: 1,
      length: Math.abs(rb - ra) + Math.abs(delta) * rb,
    });
  }

  return candidates;
}

function extensionCrossings(
  existing: Point[],
  extension: Point[],
): number {
  if (existing.length < 2 || extension.length < 2) return 0;
  let crossings = 0;
  for (let nextIndex = 0; nextIndex < extension.length - 1; nextIndex += 1) {
    const a = extension[nextIndex];
    const b = extension[nextIndex + 1];
    for (let previousIndex = 0; previousIndex < existing.length - 1; previousIndex += 1) {
      // The first new segment shares the current station with the last
      // existing segment; that legal adjacency is not a crossing.
      if (
        nextIndex === 0 &&
        previousIndex === existing.length - 2
      ) {
        continue;
      }
      if (
        intersects(
          existing[previousIndex],
          existing[previousIndex + 1],
          a,
          b,
        )
      ) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

function orthoradialPath(
  points: Point[],
  center: Point,
): RouteGeometry {
  if (!points.length) {
    return { d: '', samples: [], arcCount: 0, fallbackCount: 0 };
  }
  if (points.length === 1) {
    return {
      d: `M ${points[0].x} ${points[0].y}`,
      samples: [points[0]],
      arcCount: 0,
      fallbackCount: 0,
    };
  }

  type State = {
    commands: string[];
    samples: Point[];
    arcCount: number;
    length: number;
    crossings: number;
  };

  let states: State[] = [{
    commands: [`M ${points[0].x} ${points[0].y}`],
    samples: [points[0]],
    arcCount: 0,
    length: 0,
    crossings: 0,
  }];

  // A small beam is enough because every edge has at most four legal
  // orthoradial forms. Ranking is lexicographic: self-crossings first,
  // then geometric length. This preserves topology before aesthetics.
  const beamWidth = 12;

  for (let index = 0; index < points.length - 1; index += 1) {
    const candidates = orthoradialEdgeCandidates(
      points[index],
      points[index + 1],
      center,
    );
    const next: State[] = [];

    for (const state of states) {
      for (const candidate of candidates) {
        const addedCrossings = extensionCrossings(
          state.samples,
          candidate.samples,
        );
        const samples = [
          ...state.samples,
          ...candidate.samples.slice(1),
        ];
        next.push({
          commands: [...state.commands, ...candidate.commands],
          samples,
          arcCount: state.arcCount + candidate.arcCount,
          length: state.length + candidate.length,
          crossings: state.crossings + addedCrossings,
        });
      }
    }

    next.sort(
      (a, b) =>
        a.crossings - b.crossings ||
        a.length - b.length ||
        a.commands.length - b.commands.length,
    );
    states = next.slice(0, beamWidth);
  }

  const best = states[0];
  return {
    d: best.commands.join(' '),
    samples: best.samples,
    arcCount: best.arcCount,
    fallbackCount: 0,
  };
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
  const concentricCenter =
    layout.style === 'concentric'
      ? layout.radialCenter ?? (() => {
          const all = graph.nodes.map((node) => layout.positions[node.id]);
          return {
            x: all.reduce((sum, point) => sum + point.x, 0) / Math.max(1, all.length),
            y: all.reduce((sum, point) => sum + point.y, 0) / Math.max(1, all.length),
          };
        })()
      : undefined;
  if (layout.style === 'concentric' && concentricCenter) {
    return orthoradialPath(points, concentricCenter);
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

    const angularStep =
      layout.style === 'hex'
        ? 60
        : layout.style === 'taipei' ||
            layout.style === 'london' ||
            layout.style === 'moscow'
          ? 45
          : undefined;
    if (angularStep) {
      const polyline = strictAxisPolyline(
        a,
        b,
        angularStep as 45 | 60,
      );
      for (const point of polyline.slice(1)) {
        commands.push(`L ${point.x} ${point.y}`);
        samples.push(point);
      }
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
