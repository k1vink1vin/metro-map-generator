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
interface AxisPolylineCandidate {
  points: Point[];
  length: number;
  bends: number;
}

function strictAxisCandidates(
  a: Point,
  b: Point,
  stepDegrees: 45 | 60,
): AxisPolylineCandidate[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const directLength = Math.hypot(dx, dy);
  if (directLength < 1e-8) {
    return [{ points: [a, b], length: 0, bends: 0 }];
  }

  const step = (stepDegrees * Math.PI) / 180;
  const angle = normalizedAngle(Math.atan2(dy, dx));
  const nearest = Math.round(angle / step) * step;
  if (Math.abs(shortestSignedAngle(angle, nearest)) < 1e-7) {
    return [{
      points: [a, b],
      length: directLength,
      bends: 0,
    }];
  }

  const lower = Math.floor(angle / step) * step;
  const upper = lower + step;
  const u = { x: Math.cos(lower), y: Math.sin(lower) };
  const v = { x: Math.cos(upper), y: Math.sin(upper) };
  const det = u.x * v.y - u.y * v.x;

  if (Math.abs(det) < 1e-9) {
    return [{
      points: [a, b],
      length: directLength,
      bends: 0,
    }];
  }

  const alpha = (dx * v.y - dy * v.x) / det;
  const beta = (u.x * dy - u.y * dx) / det;
  if (alpha < -1e-6 || beta < -1e-6) {
    return [{
      points: [a, b],
      length: directLength,
      bends: 0,
    }];
  }

  const corners = [
    { x: a.x + u.x * alpha, y: a.y + u.y * alpha },
    { x: a.x + v.x * beta, y: a.y + v.y * beta },
  ];

  return corners.map((corner) => {
    const points = [a, corner, b].filter(
      (point, index, all) =>
        index === 0 ||
        distance(point, all[index - 1]) > 1e-7,
    );
    return {
      points,
      length: points
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum + distance(points[index], point),
          0,
        ),
      bends: Math.max(0, points.length - 2),
    };
  });
}

function strictAxisPath(
  points: Point[],
  stepDegrees: 45 | 60,
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
    crossings: number;
    length: number;
    bends: number;
  };

  let states: State[] = [{
    commands: [`M ${points[0].x} ${points[0].y}`],
    samples: [points[0]],
    crossings: 0,
    length: 0,
    bends: 0,
  }];

  const beamWidth = 16;

  for (let index = 0; index < points.length - 1; index += 1) {
    const candidates = strictAxisCandidates(
      points[index],
      points[index + 1],
      stepDegrees,
    );
    const next: State[] = [];

    for (const state of states) {
      for (const candidate of candidates) {
        const addedCrossings = extensionCrossings(
          state.samples,
          candidate.points,
        );
        const samples = [
          ...state.samples,
          ...candidate.points.slice(1),
        ];
        next.push({
          commands: [
            ...state.commands,
            ...candidate.points
              .slice(1)
              .map((point) => `L ${point.x} ${point.y}`),
          ],
          samples,
          crossings: state.crossings + addedCrossings,
          length: state.length + candidate.length,
          bends: state.bends + candidate.bends,
        });
      }
    }

    next.sort(
      (a, b) =>
        a.crossings - b.crossings ||
        a.bends - b.bends ||
        a.length - b.length,
    );
    states = next.slice(0, beamWidth);
  }

  const best = states[0];
  return {
    d: best.commands.join(' '),
    samples: best.samples,
    arcCount: 0,
    fallbackCount: 0,
  };
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

function circularArcTopologySamples(
  center: Point,
  radius: number,
  startAngle: number,
  delta: number,
): Point[] {
  const steps = Math.max(
    4,
    Math.ceil(Math.abs(delta) / (Math.PI / 24)),
  );
  return Array.from({ length: steps }, (_, index) => {
    const angle =
      startAngle + (delta * (index + 1)) / steps;
    return pointOnPolar(center, radius, angle);
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

  // If both one-bend L-routes collide with an earlier part of the same line,
  // allow a temporary routing shell. It is still strictly orthoradial:
  // radial -> circular arc -> radial. These extra candidates are essential for
  // long regional lines whose station sequence visits the same angular sector
  // repeatedly.
  const detourRadii = [
    Math.max(24, Math.min(ra, rb) - 48),
    (ra + rb) / 2,
    Math.max(ra, rb) + 48,
  ].filter(
    (radius, index, all) =>
      radius > 1 &&
      Math.abs(radius - ra) > 1e-5 &&
      Math.abs(radius - rb) > 1e-5 &&
      all.findIndex((value) => Math.abs(value - radius) < 1e-5) === index,
  );

  for (const routeRadius of detourRadii) {
    const startCorner = {
      x: center.x + Math.cos(aa) * routeRadius,
      y: center.y + Math.sin(aa) * routeRadius,
    };
    const endCorner = {
      x: center.x + Math.cos(ab) * routeRadius,
      y: center.y + Math.sin(ab) * routeRadius,
    };
    for (const delta of deltas) {
      candidates.push({
        commands: [
          `L ${startCorner.x} ${startCorner.y}`,
          arcCommand(routeRadius, delta, endCorner),
          `L ${b.x} ${b.y}`,
        ],
        samples: [
          a,
          startCorner,
          ...circularArcSamples(
            center,
            routeRadius,
            aa,
            delta,
          ),
          b,
        ],
        arcCount: 1,
        length:
          Math.abs(routeRadius - ra) +
          Math.abs(delta) * routeRadius +
          Math.abs(rb - routeRadius),
      });
    }
  }

  return candidates;
}

function pointOnPolar(
  center: Point,
  radius: number,
  angle: number,
): Point {
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  };
}

/**
 * Escape candidates are used only when the compact beam solution still folds
 * over itself. They remain 100% orthoradial, but briefly sidestep around the
 * station angle before using a routing circle outside the station shells.
 *
 * This is the polar-grid equivalent of taking a free outer corridor in an
 * orthogonal router: it preserves the arc/spoke grammar while giving a long
 * line enough topological freedom to avoid crossing its own earlier pieces.
 */
function orthoradialEscapeCandidates(
  a: Point,
  b: Point,
  center: Point,
  outerBase: number,
): OrthoradialEdgeGeometry[] {
  const ax = a.x - center.x;
  const ay = a.y - center.y;
  const bx = b.x - center.x;
  const by = b.y - center.y;
  const ra = Math.hypot(ax, ay);
  const rb = Math.hypot(bx, by);
  if (ra < 1e-7 || rb < 1e-7) return [];

  const aa = Math.atan2(ay, ax);
  const ab = Math.atan2(by, bx);
  const offsets = [
    0,
    -Math.PI / 9,
    Math.PI / 9,
    -2 * Math.PI / 9,
    2 * Math.PI / 9,
  ];
  const radii = [outerBase + 256];
  const candidates: OrthoradialEdgeGeometry[] = [];

  for (const routeRadius of radii) {
    for (const startOffset of offsets) {
      for (const endOffset of offsets) {
        const alpha = aa + startOffset;
        const beta = ab + endOffset;
        const startDelta = shortestSignedAngle(aa, alpha);
        const endDelta = shortestSignedAngle(beta, ab);

        for (const middleDelta of [shortestSignedAngle(alpha, beta)]) {
          const startShell = pointOnPolar(center, ra, alpha);
          const outerStart = pointOnPolar(
            center,
            routeRadius,
            alpha,
          );
          const outerEnd = pointOnPolar(
            center,
            routeRadius,
            beta,
          );
          const endShell = pointOnPolar(center, rb, beta);
          const commands: string[] = [];
          const samples: Point[] = [a];
          let length = 0;
          let arcCount = 0;

          if (Math.abs(startDelta) > 1e-8) {
            commands.push(
              arcCommand(ra, startDelta, startShell),
            );
            samples.push(
              ...circularArcSamples(
                center,
                ra,
                aa,
                startDelta,
              ),
            );
            length += Math.abs(startDelta) * ra;
            arcCount += 1;
          }

          if (
            distance(samples[samples.length - 1], outerStart) >
            1e-7
          ) {
            commands.push(
              `L ${outerStart.x} ${outerStart.y}`,
            );
            samples.push(outerStart);
            length += Math.abs(routeRadius - ra);
          }

          if (Math.abs(middleDelta) > 1e-8) {
            commands.push(
              arcCommand(
                routeRadius,
                middleDelta,
                outerEnd,
              ),
            );
            samples.push(
              ...circularArcTopologySamples(
                center,
                routeRadius,
                alpha,
                middleDelta,
              ),
            );
            length +=
              Math.abs(middleDelta) * routeRadius;
            arcCount += 1;
          }

          if (
            distance(samples[samples.length - 1], endShell) >
            1e-7
          ) {
            commands.push(
              `L ${endShell.x} ${endShell.y}`,
            );
            samples.push(endShell);
            length += Math.abs(routeRadius - rb);
          }

          if (Math.abs(endDelta) > 1e-8) {
            commands.push(
              arcCommand(rb, endDelta, b),
            );
            samples.push(
              ...circularArcSamples(
                center,
                rb,
                beta,
                endDelta,
              ),
            );
            length += Math.abs(endDelta) * rb;
            arcCount += 1;
          } else if (
            distance(samples[samples.length - 1], b) > 1e-7
          ) {
            commands.push(`L ${b.x} ${b.y}`);
            samples.push(b);
            length += distance(
              samples[samples.length - 2],
              b,
            );
          }

          candidates.push({
            commands,
            samples,
            arcCount,
            length,
          });
        }
      }
    }
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

interface PolarGridStep {
  commands: string[];
  samples: Point[];
  length: number;
  orientation: 1 | 2;
}

interface PolarQueueItem {
  key: string;
  radiusIndex: number;
  angleIndex: number;
  orientation: 0 | 1 | 2;
  cost: number;
}

function pushPolarQueue(
  heap: PolarQueueItem[],
  item: PolarQueueItem,
): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].cost <= heap[index].cost) break;
    [heap[parent], heap[index]] = [
      heap[index],
      heap[parent],
    ];
    index = parent;
  }
}

function popPolarQueue(
  heap: PolarQueueItem[],
): PolarQueueItem | undefined {
  if (!heap.length) return undefined;
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < heap.length &&
        heap[left].cost < heap[smallest].cost
      ) {
        smallest = left;
      }
      if (
        right < heap.length &&
        heap[right].cost < heap[smallest].cost
      ) {
        smallest = right;
      }
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [
        heap[smallest],
        heap[index],
      ];
      index = smallest;
    }
  }
  return first;
}

function uniquePolarValues(
  values: number[],
  tolerance = 1e-6,
): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const result: number[] = [];
  for (const value of sorted) {
    if (
      !result.length ||
      Math.abs(value - result[result.length - 1]) >
        tolerance
    ) {
      result.push(value);
    }
  }
  return result;
}

function crossingsAgainstPath(
  existing: Point[],
  extension: Point[],
): number {
  if (existing.length < 2 || extension.length < 2) {
    return 0;
  }
  let crossings = 0;
  for (let i = 0; i < extension.length - 1; i += 1) {
    for (let j = 0; j < existing.length - 1; j += 1) {
      if (
        intersects(
          extension[i],
          extension[i + 1],
          existing[j],
          existing[j + 1],
        )
      ) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

function findPolarValueIndex(
  values: number[],
  target: number,
): number {
  let bestIndex = 0;
  let bestError = Number.POSITIVE_INFINITY;
  values.forEach((value, index) => {
    const error = Math.abs(value - target);
    if (error < bestError) {
      bestError = error;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * Route one station pair on an explicit polar grid. Nodes are intersections
 * of routing circles and radial spokes; edges are therefore *only* circular
 * arcs or radial straight lines. Previously drawn pieces of the same route
 * are treated as obstacles with a lexicographically dominant crossing cost.
 */
function polarGridConnection(
  a: Point,
  b: Point,
  center: Point,
  radii: number[],
  angles: number[],
  existing: Point[],
): OrthoradialEdgeGeometry | undefined {
  const tau = Math.PI * 2;
  const ra = Math.hypot(
    a.x - center.x,
    a.y - center.y,
  );
  const rb = Math.hypot(
    b.x - center.x,
    b.y - center.y,
  );
  const aa = normalizedAngle(
    Math.atan2(a.y - center.y, a.x - center.x),
  );
  const ab = normalizedAngle(
    Math.atan2(b.y - center.y, b.x - center.x),
  );
  const startR = findPolarValueIndex(radii, ra);
  const endR = findPolarValueIndex(radii, rb);
  const startA = findPolarValueIndex(angles, aa);
  const endA = findPolarValueIndex(angles, ab);

  const stateKey = (
    radiusIndex: number,
    angleIndex: number,
    orientation: 0 | 1 | 2,
  ) => `${radiusIndex}:${angleIndex}:${orientation}`;

  const queue: PolarQueueItem[] = [];
  const distances = new Map<string, number>();
  const previous = new Map<
    string,
    { key: string; step: PolarGridStep }
  >();

  const startKey = stateKey(startR, startA, 0);
  distances.set(startKey, 0);
  pushPolarQueue(queue, {
    key: startKey,
    radiusIndex: startR,
    angleIndex: startA,
    orientation: 0,
    cost: 0,
  });

  let goalKey: string | undefined;

  while (queue.length) {
    const current = popPolarQueue(queue)!;
    if (
      current.cost !== distances.get(current.key)
    ) {
      continue;
    }
    if (
      current.radiusIndex === endR &&
      current.angleIndex === endA
    ) {
      goalKey = current.key;
      break;
    }

    const radius = radii[current.radiusIndex];
    const angle = angles[current.angleIndex];
    const from = pointOnPolar(
      center,
      radius,
      angle,
    );

    const neighbors: Array<{
      radiusIndex: number;
      angleIndex: number;
      step: PolarGridStep;
    }> = [];

    for (const radialDelta of [-1, 1]) {
      const nextR = current.radiusIndex + radialDelta;
      if (nextR < 0 || nextR >= radii.length) {
        continue;
      }
      const to = pointOnPolar(
        center,
        radii[nextR],
        angle,
      );
      neighbors.push({
        radiusIndex: nextR,
        angleIndex: current.angleIndex,
        step: {
          commands: [`L ${to.x} ${to.y}`],
          samples: [from, to],
          length: Math.abs(
            radii[nextR] - radius,
          ),
          orientation: 1,
        },
      });
    }

    for (const angularDirection of [-1, 1] as const) {
      const nextA =
        (current.angleIndex +
          angularDirection +
          angles.length) %
        angles.length;
      const nextAngle = angles[nextA];
      let delta =
        angularDirection > 0
          ? (nextAngle - angle + tau) % tau
          : -((angle - nextAngle + tau) % tau);
      if (Math.abs(delta) < 1e-9) continue;
      const to = pointOnPolar(
        center,
        radius,
        nextAngle,
      );
      neighbors.push({
        radiusIndex: current.radiusIndex,
        angleIndex: nextA,
        step: {
          commands: [
            arcCommand(radius, delta, to),
          ],
          samples: [
            from,
            ...circularArcTopologySamples(
              center,
              radius,
              angle,
              delta,
            ),
          ],
          length: Math.abs(delta) * radius,
          orientation: 2,
        },
      });
    }

    for (const neighbor of neighbors) {
      const crossings = crossingsAgainstPath(
        existing,
        neighbor.step.samples,
      );
      const bend =
        current.orientation !== 0 &&
        current.orientation !==
          neighbor.step.orientation
          ? 1
          : 0;
      const nextCost =
        current.cost +
        crossings * 1e9 +
        bend * 36 +
        neighbor.step.length;
      const nextKey = stateKey(
        neighbor.radiusIndex,
        neighbor.angleIndex,
        neighbor.step.orientation,
      );
      if (
        nextCost + 1e-9 >=
        (distances.get(nextKey) ??
          Number.POSITIVE_INFINITY)
      ) {
        continue;
      }
      distances.set(nextKey, nextCost);
      previous.set(nextKey, {
        key: current.key,
        step: neighbor.step,
      });
      pushPolarQueue(queue, {
        key: nextKey,
        radiusIndex: neighbor.radiusIndex,
        angleIndex: neighbor.angleIndex,
        orientation: neighbor.step.orientation,
        cost: nextCost,
      });
    }
  }

  if (!goalKey) return undefined;

  const steps: PolarGridStep[] = [];
  let cursor = goalKey;
  while (cursor !== startKey) {
    const entry = previous.get(cursor);
    if (!entry) return undefined;
    steps.push(entry.step);
    cursor = entry.key;
  }
  steps.reverse();

  const commands: string[] = [];
  const samples: Point[] = [a];
  let length = 0;
  let arcCount = 0;
  for (const step of steps) {
    commands.push(...step.commands);
    samples.push(...step.samples.slice(1));
    length += step.length;
    if (step.orientation === 2) arcCount += 1;
  }

  // Snap the mathematical grid endpoints back to the exact route anchors.
  // They should already be equal up to floating-point tolerance.
  if (distance(samples[0], a) > 1e-6) {
    samples.unshift(a);
  }
  if (
    distance(samples[samples.length - 1], b) >
    1e-6
  ) {
    commands.push(`L ${b.x} ${b.y}`);
    samples.push(b);
    length += distance(
      samples[samples.length - 2],
      b,
    );
  }

  return {
    commands,
    samples,
    arcCount,
    length,
  };
}

function orthoradialEscapePath(
  points: Point[],
  center: Point,
): RouteGeometry {
  const tau = Math.PI * 2;
  const stationRadii = points.map((point) =>
    Math.hypot(
      point.x - center.x,
      point.y - center.y,
    ),
  );
  const stationAngles = points.map((point) =>
    normalizedAngle(
      Math.atan2(
        point.y - center.y,
        point.x - center.x,
      ),
    ),
  );

  const sortedStationRadii = uniquePolarValues(
    stationRadii,
  );
  const radialValues = [...sortedStationRadii];
  for (
    let index = 0;
    index < sortedStationRadii.length - 1;
    index += 1
  ) {
    const a = sortedStationRadii[index];
    const b = sortedStationRadii[index + 1];
    if (b - a > 30) {
      radialValues.push((a + b) / 2);
    }
  }
  const minRadius = Math.min(...stationRadii);
  const maxRadius = Math.max(...stationRadii);
  radialValues.push(
    Math.max(12, minRadius - 72),
    maxRadius + 72,
    maxRadius + 160,
    maxRadius + 300,
  );
  const radii = uniquePolarValues(
    radialValues.filter((radius) => radius > 1),
  );

  const sortedStationAngles = uniquePolarValues(
    stationAngles,
  );
  const angularValues = [...sortedStationAngles];
  for (
    let index = 0;
    index < sortedStationAngles.length;
    index += 1
  ) {
    const current = sortedStationAngles[index];
    const next =
      index + 1 < sortedStationAngles.length
        ? sortedStationAngles[index + 1]
        : sortedStationAngles[0] + tau;
    const gap = next - current;
    angularValues.push(
      normalizedAngle(current + gap / 2),
    );
    if (gap > Math.PI / 5) {
      angularValues.push(
        normalizedAngle(current + gap / 3),
        normalizedAngle(current + (2 * gap) / 3),
      );
    }
  }
  const angles = uniquePolarValues(
    angularValues.map(normalizedAngle),
  );

  const commands = [
    `M ${points[0].x} ${points[0].y}`,
  ];
  const samples: Point[] = [points[0]];
  let arcCount = 0;
  let fallbackCount = 0;

  for (
    let index = 0;
    index < points.length - 1;
    index += 1
  ) {
    const compact = orthoradialEdgeCandidates(
      points[index],
      points[index + 1],
      center,
    )
      .map((candidate) => ({
        candidate,
        crossings:
          extensionCrossings(
            samples,
            candidate.samples,
          ) +
          sampledSelfCrossings(candidate.samples),
      }))
      .sort(
        (a, b) =>
          a.crossings - b.crossings ||
          a.candidate.length - b.candidate.length,
      );

    let chosen = compact[0].candidate;
    if (compact[0].crossings > 0) {
      const routed = polarGridConnection(
        points[index],
        points[index + 1],
        center,
        radii,
        angles,
        samples,
      );
      if (routed) {
        const routedCrossings =
          extensionCrossings(
            samples,
            routed.samples,
          ) +
          sampledSelfCrossings(routed.samples);
        if (routedCrossings < compact[0].crossings) {
          chosen = routed;
          fallbackCount += 1;
        }
      }
    }

    commands.push(...chosen.commands);
    samples.push(...chosen.samples.slice(1));
    arcCount += chosen.arcCount;
  }

  return {
    d: commands.join(' '),
    samples,
    arcCount,
    fallbackCount,
  };
}

function orthoradialPath(
  points: Point[],
  center: Point,
  allowedCrossings = 0,
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
  const beamWidth = 36;

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
  const compact: RouteGeometry = {
    d: best.commands.join(' '),
    samples: best.samples,
    arcCount: best.arcCount,
    fallbackCount: 0,
  };

  // Beam search intentionally prefers compact geometry, but a very long line
  // can still need a wider topological corridor. Only pay that visual cost
  // when it strictly reduces self-crossings.
  if (best.crossings > allowedCrossings) {
    const escaped = orthoradialEscapePath(
      points,
      center,
    );
    if (
      sampledSelfCrossings(escaped.samples) <
      sampledSelfCrossings(compact.samples)
    ) {
      return escaped;
    }
  }

  return compact;
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

interface MoscowPathCandidate {
  commands: string[];
  samples: Point[];
  length: number;
  bends: number;
  arcCount: number;
}

function moscowEdgeCandidates(
  graph: GraphModel,
  layout: LayoutResult,
  path: string[],
  points: Point[],
  index: number,
  rings: Map<string, CircleGeometry>,
  lineId?: string,
): MoscowPathCandidate[] {
  const a = points[index];
  const b = points[index + 1];
  const edgeId = edgeKey(path[index], path[index + 1]);
  const circle = rings.get(edgeId);

  if (!circle) {
    return strictAxisCandidates(a, b, 45).map((candidate) => ({
      commands: candidate.points
        .slice(1)
        .map((point) => `L ${point.x} ${point.y}`),
      samples: candidate.points,
      length: candidate.length,
      bends: candidate.bends,
      arcCount: 0,
    }));
  }

  const start = layout.positions[path[index]];
  const end = layout.positions[path[index + 1]];
  const lanes = [
    ...(graph.edgeByKey.get(edgeId)?.lineIds ?? []),
  ].sort();
  const laneIndex = lineId ? lanes.indexOf(lineId) : -1;
  const offset =
    lineId && lanes.length > 1 && laneIndex >= 0
      ? (laneIndex - (lanes.length - 1) / 2) * 12
      : 0;
  const radius = Math.max(1, circle.radius + offset);
  const onLane = (point: Point): Point => ({
    x:
      circle.center.x +
      ((point.x - circle.center.x) * radius) / circle.radius,
    y:
      circle.center.y +
      ((point.y - circle.center.y) * radius) / circle.radius,
  });
  const laneStart = onLane(start);
  const laneEnd = onLane(end);
  let delta =
    Math.atan2(
      end.y - circle.center.y,
      end.x - circle.center.x,
    ) -
    Math.atan2(
      start.y - circle.center.y,
      start.x - circle.center.x,
    );
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  const commands: string[] = [];
  const samples: Point[] = [a];
  let length = 0;

  if (distance(a, laneStart) > 1e-6) {
    commands.push(`L ${laneStart.x} ${laneStart.y}`);
    samples.push(laneStart);
    length += distance(a, laneStart);
  }

  commands.push(
    arcCommand(radius, delta, laneEnd),
  );
  const angle = Math.atan2(
    start.y - circle.center.y,
    start.x - circle.center.x,
  );
  const arcSamples = circularArcSamples(
    circle.center,
    radius,
    angle,
    delta,
  );
  samples.push(...arcSamples);
  length += Math.abs(delta) * radius;

  if (distance(samples[samples.length - 1], b) > 1e-6) {
    commands.push(`L ${b.x} ${b.y}`);
    length += distance(samples[samples.length - 1], b);
    samples.push(b);
  }

  return [{
    commands,
    samples,
    length,
    bends: offset ? 2 : 0,
    arcCount: 1,
  }];
}

function moscowStrictPath(
  graph: GraphModel,
  layout: LayoutResult,
  path: string[],
  points: Point[],
  rings: Map<string, CircleGeometry>,
  lineId?: string,
): RouteGeometry {
  if (!points.length) {
    return { d: '', samples: [], arcCount: 0, fallbackCount: 0 };
  }

  type State = {
    commands: string[];
    samples: Point[];
    crossings: number;
    length: number;
    bends: number;
    arcCount: number;
  };

  let states: State[] = [{
    commands: [`M ${points[0].x} ${points[0].y}`],
    samples: [points[0]],
    crossings: 0,
    length: 0,
    bends: 0,
    arcCount: 0,
  }];

  const beamWidth = 20;

  for (let index = 0; index < points.length - 1; index += 1) {
    const candidates = moscowEdgeCandidates(
      graph,
      layout,
      path,
      points,
      index,
      rings,
      lineId,
    );
    const next: State[] = [];

    for (const state of states) {
      for (const candidate of candidates) {
        const addedCrossings = extensionCrossings(
          state.samples,
          candidate.samples,
        );
        next.push({
          commands: [...state.commands, ...candidate.commands],
          samples: [
            ...state.samples,
            ...candidate.samples.slice(1),
          ],
          crossings: state.crossings + addedCrossings,
          length: state.length + candidate.length,
          bends: state.bends + candidate.bends,
          arcCount: state.arcCount + candidate.arcCount,
        });
      }
    }

    next.sort(
      (a, b) =>
        a.crossings - b.crossings ||
        a.bends - b.bends ||
        a.length - b.length,
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
    const baseline = sampledSelfCrossings(
      path.map((nodeId) => layout.positions[nodeId]),
    );
    return orthoradialPath(
      points,
      concentricCenter,
      baseline,
    );
  }

  if (
    layout.style === 'taipei' ||
    layout.style === 'london' ||
    layout.style === 'hex'
  ) {
    return strictAxisPath(
      points,
      layout.style === 'hex' ? 60 : 45,
    );
  }

  if (layout.style === 'moscow') {
    return moscowStrictPath(
      graph,
      layout,
      path,
      points,
      rings,
      lineId,
    );
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
    const length = distance(a, b);
    const ta = tangent(i), tb = tangent(i + 1);
    const strength = 0.08;
    const previousLength = i > 0 ? distance(points[i - 1], a) : length;
    const nextLength = i + 2 < points.length ? distance(b, points[i + 2]) : length;
    const obstacles = graph.edges.filter(e => ![e.a, e.b].some(id => id === path[i] || id === path[i + 1]));
    let accepted = false;
    for (const factor of [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125, 0.00390625]) {
      const h1 = Math.min(length, previousLength) * strength * factor;
      const h2 = Math.min(length, nextLength) * strength * factor;
      const c1 = { x: a.x + ta.x * h1, y: a.y + ta.y * h1 };
      const c2 = { x: b.x - tb.x * h2, y: b.y - tb.y * h2 };
      const curve = Array.from(
        { length: 25 },
        (_, step) => cubic(a, c1, c2, b, step / 24),
      );
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
      commands.push(
        `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`,
      );
      samples.push(...curve.slice(1));
      accepted = true;
      break;
    }
    if (!accepted) { commands.push(`L ${b.x} ${b.y}`); samples.push(b); fallbackCount++; }
  }
  return { d: commands.join(' '), samples, arcCount, fallbackCount };
}
