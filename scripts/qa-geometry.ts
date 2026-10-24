import assert from 'node:assert/strict';
import { buildGraph } from '../src/core/graph';
import { circleThroughStations, sampledSelfCrossings, stationAnchoredPath } from '../src/renderer/routeGeometry';
import type { LayoutResult, Point } from '../src/types';

function fixture(positions: Record<string, Point>, path: string[], moscow = false, parallel = false) {
  const graph = buildGraph({ stations: Object.keys(positions).map((id, i) => ({ id, lat: i, lon: i })),
    lines: [{ id: 'test', color: '#123456', paths: [path] },
      ...(parallel ? [{ id: 'z-other', color: '#987654', paths: [[...path].reverse()] }] : [])] });
  const layout: LayoutResult = { style: moscow ? 'moscow' : 'taipei', positions,
    geographicPositions: positions, integrity: { routeCount: 1, pathCount: 1, segmentCount: path.length - 1, repairedNodeCount: 0, separatedNodePairs: 0, valid: true },
    moscowRings: moscow ? [{ id: 'ring', stationIds: path.slice(0, -1), nodes: path.slice(0, -1) }] : [] };
  return stationAnchoredPath(graph, layout, path, path.map(id => positions[id]), parallel ? 'test' : undefined);
}

const corners = { A: { x: 0, y: 0 }, B: { x: 100, y: 0 }, C: { x: 100, y: 100 }, D: { x: 200, y: 100 } };
const route = fixture(corners, ['A', 'B', 'C', 'D']);
assert(route.d.includes('C '), 'nontrivial corners must be interpolated smoothly');
for (const station of Object.values(corners)) assert(route.samples.some(p => Math.hypot(p.x - station.x, p.y - station.y) < 1e-8), 'curve must pass through every station');

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
