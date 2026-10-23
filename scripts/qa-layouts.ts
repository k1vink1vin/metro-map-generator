import { readFileSync } from 'node:fs';
import { buildGraph } from '../src/core/graph.ts';
import { validateMoscowRings } from '../src/core/moscowRings.ts';
import { importExcelBuffer } from '../src/io/importData.ts';
import { computeLayout } from '../src/layout/index.ts';
import type { GraphModel, Point, StyleId } from '../src/types.ts';

const workbookPath = new URL('../TPE_Metro.xlsm', import.meta.url);
const data = new Uint8Array(readFileSync(workbookPath));
const input = await importExcelBuffer(data);
const graph = buildGraph(input);
const rings = validateMoscowRings(graph, input.moscowRings ?? []);


const multiColorLines = graph.lines
  .map((line) => ({
    id: line.id,
    pathIds: line.pathIds ?? line.paths.map((_, index) => String(index)),
    colors: line.pathColors ?? line.paths.map(() => line.color),
  }))
  .filter((line) => new Set(line.colors).size > 1);

for (const line of graph.lines) {
  if (
    line.pathColors &&
    line.pathColors.length !== line.paths.length
  ) {
    throw new Error(
      `${line.id}: pathColors length does not match paths length`,
    );
  }
}

if (!multiColorLines.length) {
  throw new Error(
    'TPE_Metro.xlsm is expected to contain at least one multi-color branch path.',
  );
}

console.log(
  'Per-path color overrides:',
  multiColorLines.map((line) => ({
    line: line.id,
    paths: line.pathIds.map(
      (pathId, index) => `${pathId}=${line.colors[index]}`,
    ),
  })),
);

const styles: StyleId[] = [
  'geographic',
  'taipei',
  'london',
  'moscow',
  'concentric',
  'hex',
];

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)),
  );
  return sorted[index];
}

function properIntersection(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) -
    (q.y - p.y) * (r.x - p.x);

  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  const eps = 1e-6;

  return (
    ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
    ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))
  );
}

function crossingPairs(
  graph: GraphModel,
  positions: Record<string, Point>,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < graph.edges.length; i += 1) {
    const first = graph.edges[i];
    for (let j = i + 1; j < graph.edges.length; j += 1) {
      const second = graph.edges[j];
      if (
        first.a === second.a ||
        first.a === second.b ||
        first.b === second.a ||
        first.b === second.b
      ) {
        continue;
      }
      if (
        properIntersection(
          positions[first.a],
          positions[first.b],
          positions[second.a],
          positions[second.b],
        )
      ) {
        pairs.push([
          `${first.a}--${first.b}`,
          `${second.a}--${second.b}`,
        ]);
      }
    }
  }
  return pairs;
}

function angularError(
  graph: GraphModel,
  positions: Record<string, Point>,
  stepDegrees?: number,
): number {
  if (!stepDegrees) return 0;
  const step = (stepDegrees * Math.PI) / 180;
  const errors = graph.edges.map((edge) => {
    const a = positions[edge.a];
    const b = positions[edge.b];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const snapped = Math.round(angle / step) * step;
    let diff = Math.abs(angle - snapped);
    diff = Math.min(diff, Math.PI * 2 - diff);
    return (diff * 180) / Math.PI;
  });
  return errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length);
}


function signedTurn(a: Point, b: Point, c: Point): number {
  const first = Math.atan2(b.y - a.y, b.x - a.x);
  const second = Math.atan2(c.y - b.y, c.x - b.x);
  let turn = second - first;
  while (turn > Math.PI) turn -= Math.PI * 2;
  while (turn < -Math.PI) turn += Math.PI * 2;
  return turn;
}

function moscowDoglegDetails(
  graph: GraphModel,
  positions: Record<string, Point>,
) {
  const details: Array<{
    line: string;
    path: string;
    stations: string[];
  }> = [];

  for (const line of graph.lines) {
    line.paths.forEach((path, pathIndex) => {
      const turns: number[] = [];
      for (let index = 1; index < path.length - 1; index += 1) {
        turns.push(
          signedTurn(
            positions[path[index - 1]],
            positions[path[index]],
            positions[path[index + 1]],
          ),
        );
      }

      for (let index = 0; index < turns.length - 1; index += 1) {
        const first = turns[index];
        const second = turns[index + 1];
        const opposite = Math.sign(first) !== Math.sign(second);
        const strong =
          Math.abs(first) > (24 * Math.PI) / 180 &&
          Math.abs(second) > (24 * Math.PI) / 180;

        if (opposite && strong) {
          details.push({
            line: line.id,
            path: line.pathIds?.[pathIndex] ?? String(pathIndex),
            stations: path
              .slice(index, index + 4)
              .map((nodeId) => graph.nodeById.get(nodeId)?.name ?? nodeId),
          });
        }
      }
    });
  }

  return details;
}

function moscowTerminalHookDetails(
  graph: GraphModel,
  positions: Record<string, Point>,
) {
  const details: Array<{
    line: string;
    path: string;
    stations: string[];
    angle: number;
  }> = [];

  const inspect = (
    lineId: string,
    pathId: string,
    triplet: string[],
  ) => {
    const [aId, bId, cId] = triplet;
    if ((graph.adjacency.get(cId)?.length ?? 0) > 1) return;

    const turn = Math.abs(
      signedTurn(
        positions[aId],
        positions[bId],
        positions[cId],
      ),
    );
    const degrees = (turn * 180) / Math.PI;
    if (degrees < 24) return;

    details.push({
      line: lineId,
      path: pathId,
      stations: triplet.map(
        (nodeId) => graph.nodeById.get(nodeId)?.name ?? nodeId,
      ),
      angle: degrees,
    });
  };

  for (const line of graph.lines) {
    line.paths.forEach((path, pathIndex) => {
      if (path.length < 3) return;
      const pathId = line.pathIds?.[pathIndex] ?? String(pathIndex);
      inspect(line.id, pathId, [path[2], path[1], path[0]]);
      const last = path.length - 1;
      inspect(line.id, pathId, [
        path[last - 2],
        path[last - 1],
        path[last],
      ]);
    });
  }

  return details;
}

function metrics(
  graph: GraphModel,
  positions: Record<string, Point>,
  style: StyleId,
) {
  const edgeLengths = graph.edges.map((edge) =>
    distance(positions[edge.a], positions[edge.b]),
  );

  const nodeDistances: number[] = [];
  const closePairList: Array<{ a: string; b: string; distance: number }> = [];
  let closePairs = 0;
  let severePairs = 0;

  for (let i = 0; i < graph.nodes.length; i += 1) {
    for (let j = i + 1; j < graph.nodes.length; j += 1) {
      const value = distance(
        positions[graph.nodes[i].id],
        positions[graph.nodes[j].id],
      );
      nodeDistances.push(value);
      if (value < 34) {
        closePairs += 1;
        closePairList.push({
          a: graph.nodes[i].id,
          b: graph.nodes[j].id,
          distance: value,
        });
      }
      if (value < 22) severePairs += 1;
    }
  }

  const shortEdges = edgeLengths.filter((value) => value < 42).length;
  const severeShortEdges = edgeLengths.filter((value) => value < 28).length;
  const crossingList = crossingPairs(graph, positions);
  const crossings = crossingList.length;
  const angleStep =
    style === 'hex'
      ? 60
      : style === 'taipei' || style === 'london'
        ? 45
        : undefined;
  const angleError = angularError(graph, positions, angleStep);

  const xs = Object.values(positions).map((point) => point.x);
  const ys = Object.values(positions).map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  const score = Math.max(
    0,
    100 -
      crossings * 1.8 -
      closePairs * 0.45 -
      severePairs * 1.2 -
      shortEdges * 0.25 -
      severeShortEdges * 0.75 -
      angleError * (angleStep ? 0.7 : 0),
  );

  const doglegDetails =
    style === 'moscow'
      ? moscowDoglegDetails(graph, positions)
      : [];
  const doglegs = doglegDetails.length;
  const terminalHookDetails =
    style === 'moscow'
      ? moscowTerminalHookDetails(graph, positions)
      : [];
  const terminalHooks = terminalHookDetails.length;

  return {
    style,
    canvas: `${Math.round(width)}x${Math.round(height)}`,
    minEdge: Math.min(...edgeLengths),
    p10Edge: percentile(edgeLengths, 0.1),
    minNode: Math.min(...nodeDistances),
    closePairs,
    shortEdges,
    crossings,
    angleError,
    doglegs,
    doglegDetails,
    terminalHooks,
    terminalHookDetails,
    score,
    crossingList,
    closePairList: closePairList
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 12),
  };
}

const results = styles.map((style) => {
  const layout = computeLayout(graph, style, {
    moscowRings: rings,
  });
  return metrics(graph, layout.positions, style);
});

console.log(
  `TPE_Metro.xlsm QA: ${graph.nodes.length} topology nodes / ${graph.edges.length} edges / ${graph.lines.length} routes / ${rings.length} Moscow rings`,
);
console.table(
  results.map((result) => ({
    style: result.style,
    canvas: result.canvas,
    minEdge: result.minEdge.toFixed(1),
    p10Edge: result.p10Edge.toFixed(1),
    minNode: result.minNode.toFixed(1),
    closePairs: result.closePairs,
    shortEdges: result.shortEdges,
    crossings: result.crossings,
    angleError: result.angleError.toFixed(1),
    doglegs: result.doglegs,
    terminalHooks: result.terminalHooks,
    score: result.score.toFixed(1),
  })),
);

for (const result of results) {
  if (!Number.isFinite(result.score)) {
    throw new Error(`${result.style}: non-finite QA score`);
  }
}


for (const result of results) {
  if (result.score >= 90) continue;
  console.log(`\n[${result.style}] QA diagnostics`);
  if (result.crossingList.length) {
    console.log('crossings:', result.crossingList.slice(0, 12));
  }
  if (result.closePairList.length) {
    console.log(
      'closest pairs:',
      result.closePairList.map((pair) => ({
        a: graph.nodeById.get(pair.a)?.name ?? pair.a,
        b: graph.nodeById.get(pair.b)?.name ?? pair.b,
        distance: pair.distance.toFixed(1),
      })),
    );
  }
}


const failures: string[] = [];
for (const result of results) {
  if (result.score < 90) {
    failures.push(`${result.style}: score ${result.score.toFixed(1)} < 90`);
  }
  if (result.minNode < 38) {
    failures.push(`${result.style}: minimum station distance ${result.minNode.toFixed(1)} < 38`);
  }
  if (result.shortEdges > 6) {
    failures.push(`${result.style}: ${result.shortEdges} short edges > 6`);
  }
  if (result.style === 'moscow' && result.doglegs > 3) {
    failures.push(
      `moscow: ${result.doglegs} alternating doglegs > 3`,
    );
  }

  const allowedCrossings = result.style === 'moscow' ? 4 : 0;
  if (result.crossings > allowedCrossings) {
    failures.push(
      `${result.style}: ${result.crossings} crossings > ${allowedCrossings}`,
    );
  }
  if (
    (result.style === 'taipei' ||
      result.style === 'london' ||
      result.style === 'hex') &&
    result.angleError > 12
  ) {
    failures.push(
      `${result.style}: angular error ${result.angleError.toFixed(1)}° > 12°`,
    );
  }
}

if (failures.length) {
  throw new Error(
    'Passenger-map QA regression:\n' + failures.join('\n'),
  );
}


const moscowResult = results.find((result) => result.style === 'moscow');
if (moscowResult?.doglegDetails.length) {
  console.log('Moscow dogleg details:', moscowResult.doglegDetails);
}


if (moscowResult?.terminalHookDetails.length) {
  console.log(
    'Moscow terminal hook details:',
    moscowResult.terminalHookDetails,
  );
}
