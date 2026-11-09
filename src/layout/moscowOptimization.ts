import type { GraphModel, LayoutResult, Point } from '../types';

type Axis = 0 | 1;
type OrderConstraint = { a: number; b: number; axis: Axis; sign: number };
type OrdinarySection = number[];

const norm = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function isOrdinary(graph: GraphModel, nodeId: string): boolean {
  const node = graph.nodeById.get(nodeId);
  return Boolean(
    node && node.stationIds.length === 1 &&
      (graph.adjacency.get(nodeId)?.length ?? 0) === 2 &&
      graph.lines.filter((line) => line.paths.some((path) => path.includes(nodeId))).length === 1,
  );
}

function collectOrdinarySections(graph: GraphModel, indices: Map<string, number>): OrdinarySection[] {
  const sections: OrdinarySection[] = [];
  for (const line of graph.lines) {
    for (const path of line.paths) {
      const anchors = new Set<number>([0, path.length - 1]);
      path.forEach((id, index) => {
        if (!isOrdinary(graph, id)) anchors.add(index);
      });
      const ordered = [...anchors].sort((a, b) => a - b);
      for (let index = 0; index < ordered.length - 1; index += 1) {
        if (ordered[index + 1] - ordered[index] < 2) continue;
        sections.push(path.slice(ordered[index], ordered[index + 1] + 1)
          .map((id) => indices.get(id)!));
      }
    }
  }
  return sections;
}

/**
 * A schematic ring is a rigid circle: no optimization may distort its
 * radius, equal angular slots, or station order. Optimize only the connecting
 * corridors using the SAME source-order threshold as qa:geography.
 */
export function refineMoscowPassengerMap(graph: GraphModel, layout: LayoutResult): LayoutResult {
  if (layout.style !== 'moscow' || !layout.moscowRings?.length || graph.nodes.length < 15) {
    return layout;
  }
  const ids = graph.nodes.map((node) => node.id);
  const n = ids.length;
  const indices = new Map(ids.map((id, index) => [id, index]));
  const rings = new Set(layout.moscowRings.flatMap((ring) => ring.nodes));
  const fixed = new Uint8Array(ids.map((id) => rings.has(id) ? 1 : 0));
  const source = ids.map((id) => layout.geographicPositions[id]);
  const positions = ids.map((id) => ({ ...layout.positions[id] }));
  const geo = (index: number, axis: Axis) => axis === 0 ? source[index].x : source[index].y;
  const coord = (index: number, axis: Axis) => axis === 0 ? positions[index].x : positions[index].y;
  const setCoord = (index: number, axis: Axis, value: number) => {
    if (axis === 0) positions[index].x = value;
    else positions[index].y = value;
  };

  const constraints: OrderConstraint[] = [];
  const orderPerAxis: number[][] = [[], []];
  for (const axis of [0, 1] as const) {
    const sorted = ids.map((_, index) => index)
      .sort((a, b) => geo(a, axis) - geo(b, axis));
    orderPerAxis.push(sorted);
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const delta = geo(i, axis) - geo(j, axis);
        if (Math.abs(delta) < 45) continue;
        constraints.push({ a: i, b: j, axis, sign: Math.sign(delta) });
      }
    }
  }

  // Set the intersection of the half-planes determined by the immutable
  // ring stations, then project all remaining station pairs in source order.
  // This projection never moves a genuine circular interchange.
  for (const axis of [0, 1] as const) {
    const sorted = ids.map((_, index) => index)
      .sort((a, b) => geo(a, axis) - geo(b, axis));
    for (let iteration = 0; iteration < 20; iteration += 1) {
      let moved = false;
      for (const id of sorted) {
        if (fixed[id]) continue;
        let lower = Number.NEGATIVE_INFINITY;
        let upper = Number.POSITIVE_INFINITY;
        for (const other of sorted) {
          if (!fixed[other]) continue;
          const delta = geo(id, axis) - geo(other, axis);
          if (delta >= 45) lower = Math.max(lower, coord(other, axis) + 0.025);
          if (delta <= -45) upper = Math.min(upper, coord(other, axis) - 0.025);
        }
        if (lower > upper) return layout;
        const before = coord(id, axis);
        const next = Math.min(upper, Math.max(lower, before));
        if (Math.abs(next - before) > 1e-6) { setCoord(id, axis, next); moved = true; }
      }
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const a = sorted[i], b = sorted[j];
          if (geo(b, axis) - geo(a, axis) < 45) continue;
          const gap = coord(b, axis) - coord(a, axis);
          if (gap >= 0.025) continue;
          const delta = 0.025 - gap;
          if (fixed[a] && fixed[b]) return layout;
          if (fixed[a]) setCoord(b, axis, coord(b, axis) + delta);
          else if (fixed[b]) setCoord(a, axis, coord(a, axis) - delta);
          else {
            setCoord(a, axis, coord(a, axis) - delta / 2);
            setCoord(b, axis, coord(b, axis) + delta / 2);
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  const feasibleOrder = (id: number, candidate: Point): boolean => {
    for (let other = 0; other < n; other += 1) {
      if (other === id) continue;
      for (const axis of [0, 1] as const) {
        const delta = geo(id, axis) - geo(other, axis);
        const candidateValue = axis === 0 ? candidate.x : candidate.y;
        if (Math.abs(delta) >= 45 && delta * (candidateValue - coord(other, axis)) <= 0) return false;
      }
    }
    return true;
  };

  // Separate the few close pairs along a feasible arc around their partner.
  // Reject every move that would reverse a meaningful geographic relation.
  for (let pass = 0; pass < 5; pass += 1) {
    let moved = false;
    for (let a = 0; a < n; a += 1) {
      for (let b = a + 1; b < n; b += 1) {
        if (norm(positions[a], positions[b]) >= 29.3) continue;
        let bestId = -1;
        let best: Point | undefined;
        let bestCost = Number.POSITIVE_INFINITY;
        for (const id of [a, b]) {
          if (fixed[id]) continue;
          const stationary = positions[id === a ? b : a];
          const before = positions[id];
          for (let k = 0; k < 96; k += 1) {
            const theta = 2 * Math.PI * k / 96;
            const point = {
              x: stationary.x + 29.8 * Math.cos(theta),
              y: stationary.y + 29.8 * Math.sin(theta),
            };
            if (!feasibleOrder(id, point)) continue;
            if (positions.some((other, index) =>
              index !== id && index !== a && index !== b && norm(point, other) < 28.8,
            )) continue;
            const cost = norm(point, before);
            if (cost < bestCost) { bestCost = cost; bestId = id; best = point; }
          }
        }
        if (bestId >= 0 && best) { positions[bestId] = best; moved = true; }
      }
    }
    if (!moved) break;
  }

  const sections = collectOrdinarySections(graph, indices);
  if (!sections.length) {
    return { ...layout, positions: Object.fromEntries(ids.map((id, i) => [id, positions[i]])) };
  }

  // Smooth constrained optimizer: ordinary octilinear corridor lengths are a
  // differentiable surrogate for the exact SVG route lengths. The final
  // result is still checked by the renderer QA; the surrogate alone does not
  // certify passenger readiness.
  const fixedOrigins = new Float64Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    fixedOrigins[i * 2] = positions[i].x;
    fixedOrigins[i * 2 + 1] = positions[i].y;
  }
  let values = new Float64Array(fixedOrigins);

  const optimize = (
    iterations: number,
    rate: number,
    sectionWeight: number,
    worstWeight: number,
    softmaxStrength: number,
    geographicWeight: number,
    distanceWeight: number,
    originWeight: number,
  ) => {
    const origin = new Float64Array(values);
    const first = new Float64Array(n * 2);
    const second = new Float64Array(n * 2);
    const gradient = new Float64Array(n * 2);
    const cvSquares = new Float64Array(sections.length);
    const lengths: number[][] = [];
    const means = new Float64Array(sections.length);
    const softmax = new Float64Array(sections.length);
    const kk = Math.SQRT2 - 1;

    // Refresh a conservative active set rather than checking every far
    // geographic-order constraint on every optimization iteration. The
    // final result remains subject to exhaustive qa:geography.
    let activeConstraints: OrderConstraint[] = [];
    for (let step = 1; step <= iterations; step += 1) {
      if (step === 1 || step % 20 === 0) {
        const margin = rate > 1 ? 90 : 40;
        activeConstraints = constraints.filter((constraint) => {
          const a = constraint.a * 2 + constraint.axis;
          const b = constraint.b * 2 + constraint.axis;
          return constraint.sign * (values[a] - values[b]) < margin;
        });
      }
      gradient.fill(0);
      let maximum = Number.NEGATIVE_INFINITY;
      for (let s = 0; s < sections.length; s += 1) {
        const section = sections[s];
        const segmentLengths: number[] = [];
        let total = 0;
        for (let edge = 0; edge < section.length - 1; edge += 1) {
          const a = section[edge] * 2, b = section[edge + 1] * 2;
          const dx = Math.abs(values[a] - values[b]);
          const dy = Math.abs(values[a + 1] - values[b + 1]);
          const length = Math.max(dx, dy) + kk * Math.min(dx, dy);
          segmentLengths.push(length);
          total += length;
        }
        lengths[s] = segmentLengths;
        const mean = total / segmentLengths.length;
        means[s] = mean;
        let cv = 0;
        for (const len of segmentLengths) cv += ((len / mean) - 1) ** 2;
        cv /= segmentLengths.length;
        cvSquares[s] = cv;
        maximum = Math.max(maximum, cv * softmaxStrength);
      }
      let denom = 0;
      for (let s = 0; s < sections.length; s += 1) {
        softmax[s] = Math.exp(cvSquares[s] * softmaxStrength - maximum);
        denom += softmax[s];
      }

      for (let s = 0; s < sections.length; s += 1) {
        const section = sections[s];
        const segmentLengths = lengths[s];
        const mean = means[s];
        if (mean < 1e-8) continue;
        const sectionGradientWeight = sectionWeight / sections.length + worstWeight * softmax[s] / denom;
        for (let edge = 0; edge < segmentLengths.length; edge += 1) {
          const a = section[edge] * 2, b = section[edge + 1] * 2;
          const dx = values[a] - values[b], dy = values[a + 1] - values[b + 1];
          const length = segmentLengths[edge];
          const derivative = sectionGradientWeight * 2 * (length / mean - 1 - cvSquares[s]) /
            (segmentLengths.length * mean);
          const x = Math.abs(dx) >= Math.abs(dy) ? 1 : kk;
          const y = Math.abs(dx) >= Math.abs(dy) ? kk : 1;
          const gx = derivative * x * Math.sign(dx);
          const gy = derivative * y * Math.sign(dy);
          gradient[a] += gx; gradient[b] -= gx;
          gradient[a + 1] += gy; gradient[b + 1] -= gy;
        }
      }

      for (const constraint of activeConstraints) {
        const a = constraint.a * 2 + constraint.axis;
        const b = constraint.b * 2 + constraint.axis;
        const signedGap = constraint.sign * (values[a] - values[b]);
        if (signedGap >= 1) continue;
        const derivative = -2 * geographicWeight * (1 - signedGap) * constraint.sign;
        gradient[a] += derivative;
        gradient[b] -= derivative;
      }

      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const a = i * 2, b = j * 2;
          const dx = values[a] - values[b], dy = values[a + 1] - values[b + 1];
          const dist = Math.hypot(dx, dy);
          if (dist >= 30 || dist <= 1e-8) continue;
          const gain = -2 * distanceWeight * (30 - dist) / dist;
          gradient[a] += gain * dx; gradient[b] -= gain * dx;
          gradient[a + 1] += gain * dy; gradient[b + 1] -= gain * dy;
        }
      }

      const firstCorrection = 1 - Math.pow(0.9, step);
      const secondCorrection = 1 - Math.pow(0.999, step);
      for (let i = 0; i < n; i += 1) {
        if (fixed[i]) continue;
        for (let axis = 0; axis < 2; axis += 1) {
          const index = i * 2 + axis;
          const grad = gradient[index] + 2 * originWeight * (values[index] - origin[index]);
          first[index] = 0.9 * first[index] + 0.1 * grad;
          second[index] = 0.999 * second[index] + 0.001 * grad * grad;
          values[index] -= rate * (first[index] / firstCorrection) /
            (Math.sqrt(second[index] / secondCorrection) + 1e-8);
        }
      }
    }
  };

  optimize(600, 1.8, 120, 70, 150, 0.03, 0.1, 0.000005);
  optimize(1600, 0.45, 4000, 14000, 2500, 1, 0.6, 0.0000001);

  const output = Object.fromEntries(ids.map((id, index) => [id, {
    x: fixed[index] ? fixedOrigins[index * 2] : values[index * 2],
    y: fixed[index] ? fixedOrigins[index * 2 + 1] : values[index * 2 + 1],
  }]));
  return { ...layout, positions: output };
}