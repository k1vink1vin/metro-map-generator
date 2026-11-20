import assert from 'node:assert/strict';
import { buildGraph } from '../src/core/graph';
import { computeLayout } from '../src/layout/index';
import { circleThroughStations, sampledSelfCrossings, stationAnchoredPath } from '../src/renderer/routeGeometry';
import { buildGeometricBundleMap, offsetPathForLine } from '../src/renderer/geometry';
import type { LayoutResult, Point, StyleId } from '../src/types';
import { routeCorridorBands } from '../src/renderer/routeCorridors';

function fixture(
  positions: Record<string, Point>,
  path: string[],
  moscow = false,
  parallel = false,
  schematic: StyleId | undefined = undefined,
  radialCenter?: Point,
) {
  const graph = buildGraph({ stations: Object.keys(positions).map((id, i) => ({ id, lat: i, lon: i })),
    lines: [{ id: 'test', color: '#123456', paths: [path] },
      ...(parallel ? [{ id: 'z-other', color: '#987654', paths: [[...path].reverse()] }] : [])] });
  const layout: LayoutResult = { style: schematic ?? (moscow ? 'moscow' : 'geographic'), positions,
    geographicPositions: positions, radialCenter,
    integrity: { routeCount: 1, pathCount: 1, segmentCount: path.length - 1, repairedNodeCount: 0, separatedNodePairs: 0, valid: true },
    moscowRings: moscow ? [{ id: 'ring', stationIds: path.slice(0, -1), nodes: path.slice(0, -1) }] : [] };
  return stationAnchoredPath(graph, layout, path, path.map(id => positions[id]), parallel ? 'test' : undefined);
}

const corners = { A: { x: 0, y: 0 }, B: { x: 100, y: 0 }, C: { x: 100, y: 100 }, D: { x: 200, y: 100 } };
const route = fixture(corners, ['A', 'B', 'C', 'D']);
assert(!route.d.includes('C '), 'Geographic must not spline or schematicize coordinates');
assert.equal(route.samples.length, 4, 'Geographic must contain only the projected station anchors');
for (const station of Object.values(corners)) assert(route.samples.some(p => Math.hypot(p.x - station.x, p.y - station.y) < 1e-8), 'Geographic polyline must pass through every exact station position');

const ring = { A: { x: 60, y: 20 }, B: { x: 10, y: 70 }, C: { x: -40, y: 20 }, D: { x: 10, y: -30 } };
const circle = circleThroughStations(Object.values(ring));
assert(circle);
assert(Math.abs(circle.center.x - 10) < 1e-8 && Math.abs(circle.radius - 50) < 1e-8);
const circularRoute = fixture(ring, ['A', 'B', 'C', 'D', 'A'], true);
assert.equal(circularRoute.arcCount, 4);
assert(fixture(ring, ['A', 'B', 'C', 'D', 'A'], true, true).d.includes('A 44 44'), 'shared circular corridors need separate concentric lanes');
for (const point of circularRoute.samples) assert(Math.abs(Math.hypot(point.x - 10, point.y - 20) - 50) < 1e-7, 'rendered ring must be a circle between stations too');
assert.equal(circleThroughStations([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]), undefined);
const translated = Object.values(ring).map(p => ({ x: p.x + 250, y: p.y - 90 }));
assert.equal(circleThroughStations(translated)?.center.x, 260, 'each ring has its own center');

const duplicates = fixture({ A: { x: 0, y: 0 }, B: { x: 0, y: 0 }, C: { x: 20, y: 20 } }, ['A', 'B', 'C']);
assert(!/NaN|Infinity/.test(duplicates.d));
console.log('Geometry QA passed: station interpolation, exact circular arcs, independent centers, degenerate inputs.');

const acute = fixture({ A: {x:0,y:0}, B: {x:100,y:0}, C: {x:40,y:40}, D: {x:150,y:90} }, ['A','B','C','D']);
assert.equal(acute.fallbackCount, 0, 'isolated acute turns must use interpolating curves');
assert.equal(sampledSelfCrossings(acute.samples), 0, 'rounding acute turns must not create loops');

function axisError(samples: Point[], stepDegrees: number): number {
  const step = (stepDegrees * Math.PI) / 180;
  return Math.max(
    0,
    ...samples.slice(1).map((point, index) => {
      const previous = samples[index];
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      if (Math.hypot(dx, dy) < 1e-8) return 0;
      const angle = Math.atan2(dy, dx);
      const snapped = Math.round(angle / step) * step;
      let error = Math.abs(angle - snapped);
      error = Math.min(error, Math.PI * 2 - error);
      return (error * 180) / Math.PI;
    }),
  );
}

for (const style of ['taipei', 'london', 'hex'] as const) {
  const schematic = fixture(corners, ['A', 'B', 'C', 'D'], false, false, style);
  assert.equal(sampledSelfCrossings(schematic.samples), 0);
  assert.equal(schematic.fallbackCount, 0);
  assert(!schematic.d.includes('C '), 'angular schematic routes must not be arbitrary splines');
  assert(axisError(schematic.samples, style === 'hex' ? 60 : 45) < 1e-7,
    `${style} route geometry must lie exactly on its angular family`);
  for (const point of Object.values(corners)) assert(schematic.samples.some(p =>
    Math.hypot(p.x-point.x,p.y-point.y)<1e-8), 'hard-axis geometry must retain every station anchor');
}

const parallelGraph = buildGraph({
  stations: [
    { id: 'A', name: 'A', lat: 0, lon: 0 },
    { id: 'B', name: 'B', lat: 0, lon: 1 },
    { id: 'C', name: 'C', lat: 1, lon: 1 },
  ],
  lines: [
    { id: 'lane-a', color: '#111111', paths: [['A', 'B', 'C']] },
    { id: 'lane-b', color: '#222222', paths: [['A', 'B', 'C']] },
  ],
});
const parallelPositions = {
  A: { x: 0, y: 0 },
  B: { x: 100, y: 0 },
  C: { x: 100, y: 100 },
};
const parallelBundles = buildGeometricBundleMap(
  parallelGraph,
  parallelPositions,
);
const laneA = offsetPathForLine(
  parallelGraph,
  ['A', 'B', 'C'],
  parallelPositions,
  'lane-a',
  12,
  parallelBundles,
);
const laneB = offsetPathForLine(
  parallelGraph,
  ['A', 'B', 'C'],
  parallelPositions,
  'lane-b',
  12,
  parallelBundles,
);
const horizontalGapAtA = Math.abs(laneA[0].y - laneB[0].y);
const horizontalGapAtB = Math.abs(laneA[1].y - laneB[1].y);
const verticalGapAtB = Math.abs(laneA[1].x - laneB[1].x);
const verticalGapAtC = Math.abs(laneA[2].x - laneB[2].x);
for (const [label, value] of [
  ['horizontal start', horizontalGapAtA],
  ['horizontal bend', horizontalGapAtB],
  ['vertical bend', verticalGapAtB],
  ['vertical end', verticalGapAtC],
] as const) {
  assert(
    Math.abs(value - 12) < 1e-7,
    `parallel lane gap must stay exactly 12px at ${label}; got ${value}`,
  );
}

const centerGraph = buildGraph({
  stations: [
    { id: 'A', name: 'A', lat: 25.0, lon: 121.0 },
    { id: 'B', name: 'B', lat: 25.1, lon: 121.1 },
    { id: 'C', name: 'C', lat: 25.2, lon: 121.2 },
  ],
  lines: [
    { id: 'center-test', color: '#123456', paths: [['A', 'B', 'C']] },
  ],
});
const centeredLayout = computeLayout(
  centerGraph,
  'concentric',
  { concentricCenterNodeId: 'B' },
);
assert(centeredLayout.radialCenter, 'Concentric layout must expose its exact common centre');
assert(
  Math.hypot(
    centeredLayout.positions.B.x - centeredLayout.radialCenter.x,
    centeredLayout.positions.B.y - centeredLayout.radialCenter.y,
  ) < 1e-7,
  'selected concentric centre station must remain exactly at radius zero',
);

const orthoradial = fixture(
  { A: { x: 100, y: 0 }, B: { x: 0, y: 160 } },
  ['A', 'B'],
  false,
  false,
  'concentric',
  { x: 0, y: 0 },
);
assert(orthoradial.d.includes('A 100 100'), 'concentric routes must use common-centre circular arcs');
assert(orthoradial.d.includes('L 0 160'), 'concentric routes must use radial straight segments between shells');


const diagonalParallelGraph = buildGraph({
  stations: [
    { id: 'PA', lat: 0, lon: 0 },
    { id: 'PB', lat: 0, lon: 1 },
    { id: 'PC', lat: 1, lon: 2 },
  ],
  lines: [
    { id: 'P1', color: '#ff0000', paths: [['PA', 'PB', 'PC']] },
    { id: 'P2', color: '#0000ff', paths: [['PA', 'PB', 'PC']] },
  ],
});
const diagonalParallelPositions = {
  PA: { x: 0, y: 0 },
  PB: { x: 100, y: 0 },
  PC: { x: 200, y: 100 },
};
const diagonalParallelBundles = buildGeometricBundleMap(
  diagonalParallelGraph,
  diagonalParallelPositions,
);
const lane1 = offsetPathForLine(
  diagonalParallelGraph,
  ['PA', 'PB', 'PC'],
  diagonalParallelPositions,
  'P1',
  12,
  diagonalParallelBundles,
);
const lane2 = offsetPathForLine(
  diagonalParallelGraph,
  ['PA', 'PB', 'PC'],
  diagonalParallelPositions,
  'P2',
  12,
  diagonalParallelBundles,
);
for (let segment = 0; segment < 2; segment += 1) {
  const a = diagonalParallelPositions[['PA', 'PB'][segment] as 'PA' | 'PB'];
  const b = diagonalParallelPositions[['PB', 'PC'][segment] as 'PB' | 'PC'];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const normal = { x: -dy / length, y: dx / length };
  for (const endpoint of [segment, segment + 1]) {
    const gap = Math.abs(
      (lane1[endpoint].x - lane2[endpoint].x) * normal.x +
      (lane1[endpoint].y - lane2[endpoint].y) * normal.y
    );
    assert(
      Math.abs(gap - 12) < 1e-6,
      `parallel lanes must keep an exact 12px gap through bends; got ${gap}`,
    );
  }
}
console.log('Parallel-lane QA passed: exact 12px gap is preserved through a 45-degree bend.');


const bandPath = (lineId: string, lineColor: string, d: string) => ({
  lineId, lineColor, d, pathIndex: 0, arcCount: 0, fallbackCount: 0, samples: [], points: [],
});
const horizontalBands = routeCorridorBands([
  bandPath('blue', '#0070bd', 'M 0 10 L 80 10'),
  bandPath('orange', '#c35617', 'M 100 10 L 40 10'),
  bandPath('crossing', '#333333', 'M 50 0 L 50 60'),
], 8);
assert.deepEqual(horizontalBands.map(bands => bands.length), [0, 1, 0]);
assert.match(horizontalBands[1][0].casing, /^M 40 10 L 80 10$/);
assert.deepEqual(horizontalBands[1][0].stripes.map(stripe => stripe.color), ['#0070bd', '#c35617']);

const circularBands = routeCorridorBands([
  bandPath('outbound', '#0070bd', 'M 100 0 A 100 100 0 0 1 0 100'),
  bandPath('inbound', '#c35617', 'M 0 100 A 100 100 0 0 0 100 0'),
], 8);
assert.equal(circularBands[1].length, 1);
assert.ok(circularBands[1][0].stripes[0].d.includes('A 97.5 97.5'));
assert.ok(circularBands[1][0].stripes[1].d.includes('A 102.5 102.5'));
console.log('Painted corridor QA passed: coincident straight and circular routes keep both colors visible.');
