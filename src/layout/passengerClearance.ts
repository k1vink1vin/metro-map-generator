import type { GraphModel, LayoutResult, Point } from '../types';
import { buildGeometricBundleMap, offsetPathForLine } from '../renderer/geometry';
import { buildRenderedRoutePaths, sampledSelfCrossings, stationAnchoredPath } from '../renderer/routeGeometry';

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

type Section = { lineId: string; path: string[]; from: number; to: number };

function ordinary(graph: GraphModel, id: string): boolean {
  const node = graph.nodeById.get(id);
  if (!node || graph.adjacency.get(id)?.length !== 2 || node.stationIds.length !== 1) return false;
  return graph.lines.filter((line) => line.paths.some((path) => path.includes(id))).length === 1;
}

function sectionsForGraph(graph: GraphModel): Section[] {
  const runs: Section[] = [];
  for (const line of graph.lines) for (const path of line.paths) {
    const anchors = new Set<number>([0, path.length - 1]);
    path.forEach((id, index) => { if (!ordinary(graph, id)) anchors.add(index); });
    const sorted = [...anchors].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const from = sorted[index], to = sorted[index + 1];
      if (to - from >= 2) runs.push({ lineId: line.id, path, from, to });
    }
  }
  return runs;
}

function coefficientOfVariation(lengths: number[]): number {
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  return Math.sqrt(lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length) / Math.max(1e-9, mean);
}

function sectionRoute(
  graph: GraphModel, layout: LayoutResult, section: Section,
): { lengths: number[]; samples: Point[] } {
  const bundles = buildGeometricBundleMap(graph, layout.positions);
  const points = offsetPathForLine(graph, section.path, layout.positions, section.lineId, 12, bundles);
  const lengths: number[] = [], samples: Point[] = [];
  for (let index = section.from; index < section.to; index += 1) {
    const geometry = stationAnchoredPath(
      graph, layout, [section.path[index], section.path[index + 1]],
      [points[index], points[index + 1]], section.lineId,
    );
    lengths.push(geometry.samples.slice(1).reduce(
      (sum, point, segment) => sum + distance(point, geometry.samples[segment]), 0,
    ));
    samples.push(...geometry.samples.slice(samples.length ? 1 : 0));
  }
  return { lengths, samples };
}

function intersection(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8;
}

function incidentCrossings(graph: GraphModel, positions: Record<string, Point>, id: string): number {
  let count = 0;
  for (const incident of graph.edges) {
    if (incident.a !== id && incident.b !== id) continue;
    for (const other of graph.edges) {
      if ([incident.a, incident.b].includes(other.a) || [incident.a, incident.b].includes(other.b)) continue;
      if (intersection(
        positions[incident.a], positions[incident.b], positions[other.a], positions[other.b],
      )) count += 1;
    }
  }
  return count;
}

function nearestPair(graph: GraphModel, positions: Record<string, Point>): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let i = 0; i < graph.nodes.length; i += 1) for (let j = i + 1; j < graph.nodes.length; j += 1) {
    minimum = Math.min(minimum, distance(positions[graph.nodes[i].id], positions[graph.nodes[j].id]));
  }
  return minimum;
}

function pointAtFraction(samples: Point[], fraction: number): Point {
  const lengths = samples.slice(1).map((point, index) => distance(point, samples[index]));
  const target = fraction * lengths.reduce((sum, len) => sum + len, 0);
  let current = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if (current + lengths[index] < target) { current += lengths[index]; continue; }
    const t = Math.max(0, Math.min(1, (target - current) / Math.max(1e-9, lengths[index])));
    const a = samples[index], b = samples[index + 1];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return { ...samples[samples.length - 1] };
}

function renderedSelfCrossings(graph: GraphModel, layout: LayoutResult): number {
  return buildRenderedRoutePaths(graph, layout).reduce(
    (sum, route) => sum + sampledSelfCrossings(route.samples), 0,
  );
}

/**
 * Passenger clearance for octolinear/hexilinear maps.
 *
 * Moving both colliding nodes equally often damages two independent station
 * rhythms. Instead, sample a circle around the other station and select the
 * topology-safe side with the lowest route-length CV penalty. Rebalance only
 * the affected ordinary corridors by sampling the same pairwise rendered
 * geometry that the design-principle QA measures. No route-color or geometry
 * assertion is relaxed to make an invalid diagram appear to pass.
 */
export function refinePassengerClearance(graph: GraphModel, original: LayoutResult): LayoutResult {
  if (original.style !== 'taipei' && original.style !== 'hex') return original;
  const positions: Record<string, Point> = Object.fromEntries(
    Object.entries(original.positions).map(([id, point]) => [id, { ...point }]),
  );
  const layout = (): LayoutResult => ({ ...original, positions });
  const sections = sectionsForGraph(graph);
  const affectedSections = (a: string, b: string) => sections.filter(
    (section) => section.path.slice(section.from, section.to + 1).includes(a) ||
      section.path.slice(section.from, section.to + 1).includes(b),
  );
  const measure = (runs: Section[]) => {
    const cvs = runs.map((run) => coefficientOfVariation(sectionRoute(graph, layout(), run).lengths));
    return {
      worst: Math.max(0, ...cvs),
      exceedance: cvs.reduce((sum, value) => sum + Math.max(0, value - 0.02) ** 2, 0),
      sum: cvs.reduce((sum, value) => sum + value ** 2, 0),
    };
  };

  for (let pass = 0; pass < 4; pass += 1) {
    const close: Array<{ a: string; b: string; length: number }> = [];
    for (let i = 0; i < graph.nodes.length; i += 1) for (let j = i + 1; j < graph.nodes.length; j += 1) {
      const a = graph.nodes[i].id, b = graph.nodes[j].id;
      const length = distance(positions[a], positions[b]);
      if (length < 29.01) close.push({ a, b, length });
    }
    close.sort((a, b) => a.length - b.length);
    let moved = 0;
    for (const { a, b } of close) {
      if (distance(positions[a], positions[b]) >= 29) continue;
      const originals = { [a]: { ...positions[a] }, [b]: { ...positions[b] } };
      const runs = affectedSections(a, b), baseline = measure(runs);
      const crossing = { [a]: incidentCrossings(graph, positions, a), [b]: incidentCrossings(graph, positions, b) };
      let best: { id: string; point: Point } | undefined;
      let bestCost = Number.POSITIVE_INFINITY;
      for (const moving of [a, b]) {
        const stationary = moving === a ? b : a;
        const old = originals[moving], centre = positions[stationary];
        for (let index = 0; index < 48; index += 1) {
          const angle = (index * Math.PI) / 24;
          const candidate = {
            x: centre.x + Math.cos(angle) * 29.6,
            y: centre.y + Math.sin(angle) * 29.6,
          };
          const shift = distance(old, candidate);
          if (shift > 47) continue;
          if (graph.nodes.some((node) =>
            node.id !== moving && node.id !== stationary && distance(candidate, positions[node.id]) < 28.5,
          )) continue;
          positions[moving] = candidate;
          if (incidentCrossings(graph, positions, moving) > crossing[moving]) {
            positions[moving] = old;
            continue;
          }
          const after = measure(runs);
          const cost = after.exceedance * 30000 + after.sum * 200 +
            Math.max(0, after.worst - baseline.worst) * 40000 + shift * 0.3;
          if (cost < bestCost) { bestCost = cost; best = { id: moving, point: candidate }; }
          positions[moving] = old;
        }
      }
      if (best) { positions[best.id] = best.point; moved += 1; }
    }
    if (!moved) break;
  }

  const beforeEqualization = Object.fromEntries(Object.entries(positions).map(([id, point]) => [id, { ...point }]));
  const beforeCrossings = renderedSelfCrossings(graph, layout());

  for (let pass = 0; pass < 8; pass += 1) {
    let moved = 0;
    for (const section of sections) {
      const before = sectionRoute(graph, layout(), section);
      const beforeCv = coefficientOfVariation(before.lengths);
      if (beforeCv < 0.012) continue;
      const movingIds = section.path.slice(section.from + 1, section.to);
      const proposed: Record<string, Point> = Object.fromEntries(
        movingIds.map((id, index) => [id, pointAtFraction(before.samples, (index + 1) / (section.to - section.from))]),
      );
      const group = new Set(movingIds);
      const outside = graph.nodes.filter((node) => !group.has(node.id));
      let oldMin = Infinity, newMin = Infinity;
      for (const id of movingIds) for (const other of outside) {
        oldMin = Math.min(oldMin, distance(positions[id], positions[other.id]));
        newMin = Math.min(newMin, distance(proposed[id], positions[other.id]));
      }
      if (newMin < Math.min(29, oldMin) - 0.1) continue;
      const old = Object.fromEntries(movingIds.map((id) => [id, positions[id]]));
      for (const id of movingIds) positions[id] = proposed[id];
      const afterCv = coefficientOfVariation(sectionRoute(graph, layout(), section).lengths);
      if (afterCv <= beforeCv - 0.001) moved += 1;
      else for (const id of movingIds) positions[id] = old[id];
    }
    if (!moved) break;
  }

  if (renderedSelfCrossings(graph, layout()) > beforeCrossings || nearestPair(graph, positions) < 28) {
    for (const [id, point] of Object.entries(beforeEqualization)) positions[id] = point;
  }
  return { ...original, positions };
}