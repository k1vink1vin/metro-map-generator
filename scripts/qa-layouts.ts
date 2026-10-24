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

function directionalFidelity(
  graph: GraphModel,
  positions: Record<string, Point>,
  geographic: Record<string, Point>,
) {
  let northTotal = 0;
  let northMatches = 0;
  let eastTotal = 0;
  let eastMatches = 0;

  for (let i = 0; i < graph.nodes.length; i += 1) {
    for (let j = i + 1; j < graph.nodes.length; j += 1) {
      const aId = graph.nodes[i].id;
      const bId = graph.nodes[j].id;
      const geoA = geographic[aId];
      const geoB = geographic[bId];
      const outA = positions[aId];
      const outB = positions[bId];

      const geoDx = geoB.x - geoA.x;
      const geoDy = geoB.y - geoA.y;
      const outDx = outB.x - outA.x;
      const outDy = outB.y - outA.y;

      // Ignore geographically close pairs where a schematic layout is
      // allowed to reorder stations for legibility.
      if (Math.abs(geoDy) >= 45) {
        northTotal += 1;
        if (Math.sign(geoDy) === Math.sign(outDy)) northMatches += 1;
      }
      if (Math.abs(geoDx) >= 45) {
        eastTotal += 1;
        if (Math.sign(geoDx) === Math.sign(outDx)) eastMatches += 1;
      }
    }
  }

  return {
    northOrder: northTotal ? northMatches / northTotal : 1,
    eastOrder: eastTotal ? eastMatches / eastTotal : 1,
  };
}

function ringCircularity(
  positions: Record<string, Point>,
) {
  return rings.map((ring) => {
    const points = ring.nodes.map((id) => positions[id]);
    const center = {
      x:
        points.reduce((sum, point) => sum + point.x, 0) /
        Math.max(1, points.length),
      y:
        points.reduce((sum, point) => sum + point.y, 0) /
        Math.max(1, points.length),
    };
    const radii = points.map((point) =>
      Math.hypot(point.x - center.x, point.y - center.y),
    );
    const mean =
      radii.reduce((sum, radius) => sum + radius, 0) /
      Math.max(1, radii.length);
    const variance =
      radii.reduce(
        (sum, radius) => sum + (radius - mean) ** 2,
        0,
      ) / Math.max(1, radii.length);
    const deviation = Math.sqrt(variance);
    return {
      id: ring.id,
      meanRadius: mean,
      coefficientOfVariation:
        mean > 1e-9 ? deviation / mean : Number.POSITIVE_INFINITY,
    };
  });
}

function ringSeparation(
  positions: Record<string, Point>,
  geographic: Record<string, Point>,
) {
  if (rings.length < 2) {
    return { minDistance: Number.POSITIVE_INFINITY, minRatio: Number.POSITIVE_INFINITY };
  }

  const centerOf = (
    nodeIds: string[],
    source: Record<string, Point>,
  ): Point => ({
    x:
      nodeIds.reduce((sum, id) => sum + source[id].x, 0) /
      nodeIds.length,
    y:
      nodeIds.reduce((sum, id) => sum + source[id].y, 0) /
      nodeIds.length,
  });

  let minDistance = Number.POSITIVE_INFINITY;
  let minRatio = Number.POSITIVE_INFINITY;

  for (let i = 0; i < rings.length; i += 1) {
    for (let j = i + 1; j < rings.length; j += 1) {
      const layoutA = centerOf(rings[i].nodes, positions);
      const layoutB = centerOf(rings[j].nodes, positions);
      const geoA = centerOf(rings[i].nodes, geographic);
      const geoB = centerOf(rings[j].nodes, geographic);
      const layoutDistance = distance(layoutA, layoutB);
      const geographicDistance = Math.max(1, distance(geoA, geoB));

      minDistance = Math.min(minDistance, layoutDistance);
      minRatio = Math.min(minRatio, layoutDistance / geographicDistance);
    }
  }

  return { minDistance, minRatio };
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

function selfCrossingPathDetails(
  graph: GraphModel,
  positions: Record<string, Point>,
) {
  return graph.lines.flatMap((line) =>
    line.paths.flatMap((path, pathIndex) => {
      let crossings = 0;
      for (let first = 0; first < path.length - 1; first += 1) {
        for (
          let second = first + 2;
          second < path.length - 1;
          second += 1
        ) {
          if (
            properIntersection(
              positions[path[first]],
              positions[path[first + 1]],
              positions[path[second]],
              positions[path[second + 1]],
            )
          ) {
            crossings += 1;
          }
        }
      }
      if (!crossings) return [];
      return [{
        line: line.id,
        path: line.pathIds?.[pathIndex] ?? String(pathIndex),
        crossings,
        stations: path.map(
          (id) => graph.nodeById.get(id)?.name ?? id,
        ),
      }];
    }),
  );
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


function routeBendQuality(
  graph: GraphModel,
  positions: Record<string, Point>,
) {
  let sharpTurns = 0;
  let zigzags = 0;
  let selfCrossings = 0;
  const sharpDetails: Array<{
    line: string;
    path: string;
    station: string;
    angle: number;
  }> = [];

  for (const line of graph.lines) {
    line.paths.forEach((path, pathIndex) => {
      const turns: number[] = [];
      for (let index = 1; index < path.length - 1; index += 1) {
        const turn = signedTurn(
          positions[path[index - 1]],
          positions[path[index]],
          positions[path[index + 1]],
        );
        turns.push(turn);
        const degrees = Math.abs((turn * 180) / Math.PI);
        if (degrees > 100) {
          sharpTurns += 1;
          sharpDetails.push({
            line: line.id,
            path: line.pathIds?.[pathIndex] ?? String(pathIndex),
            station:
              graph.nodeById.get(path[index])?.name ?? path[index],
            angle: degrees,
          });
        }
      }

      for (let index = 0; index < turns.length - 1; index += 1) {
        const first = turns[index];
        const second = turns[index + 1];
        const strong =
          Math.abs(first) > (24 * Math.PI) / 180 &&
          Math.abs(second) > (24 * Math.PI) / 180;
        if (strong && Math.sign(first) !== Math.sign(second)) {
          zigzags += 1;
        }
      }

      for (let first = 0; first < path.length - 1; first += 1) {
        for (let second = first + 2; second < path.length - 1; second += 1) {
          if (
            properIntersection(
              positions[path[first]],
              positions[path[first + 1]],
              positions[path[second]],
              positions[path[second + 1]],
            )
          ) {
            selfCrossings += 1;
          }
        }
      }
    });
  }

  return {
    sharpTurns,
    zigzags,
    selfCrossings,
    sharpDetails: sharpDetails
      .sort((a, b) => b.angle - a.angle)
      .slice(0, 16),
  };
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
  const ringNodeSet = new Set(rings.flatMap((ring) => ring.nodes));

  const isOrdinaryCorridorNode = (nodeId: string): boolean => {
    const node = graph.nodeById.get(nodeId);
    if (!node) return false;
    if (ringNodeSet.has(nodeId)) return false;
    if ((graph.adjacency.get(nodeId)?.length ?? 0) !== 2) return false;
    if (node.stationIds.length !== 1) return false;

    const incidentLines = new Set<string>();
    for (const neighbor of graph.adjacency.get(nodeId) ?? []) {
      const edge = graph.edgeByKey.get(
        [nodeId, neighbor].sort().join('::'),
      );
      for (const lineId of edge?.lineIds ?? []) {
        incidentLines.add(lineId);
      }
    }
    return incidentLines.size === 1;
  };

  for (const line of graph.lines) {
    line.paths.forEach((path, pathIndex) => {
      for (let index = 0; index < path.length - 3; index += 1) {
        const [aId, bId, cId, dId] = path.slice(index, index + 4);
        if (
          !isOrdinaryCorridorNode(bId) ||
          !isOrdinaryCorridorNode(cId)
        ) {
          continue;
        }

        const first = signedTurn(
          positions[aId],
          positions[bId],
          positions[cId],
        );
        const second = signedTurn(
          positions[bId],
          positions[cId],
          positions[dId],
        );
        const opposite = Math.sign(first) !== Math.sign(second);
        const strong =
          Math.abs(first) > (24 * Math.PI) / 180 &&
          Math.abs(second) > (24 * Math.PI) / 180;

        if (opposite && strong) {
          details.push({
            line: line.id,
            path: line.pathIds?.[pathIndex] ?? String(pathIndex),
            stations: [aId, bId, cId, dId].map(
              (nodeId) => graph.nodeById.get(nodeId)?.name ?? nodeId,
            ),
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
  const ringNodeSet = new Set(rings.flatMap((ring) => ring.nodes));
  const details: Array<{
    line: string;
    path: string;
    stations: string[];
    angle: number;
    middleDegree: number;
    middleStationIds: string[];
    middleInRing: boolean;
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
      middleDegree: graph.adjacency.get(bId)?.length ?? 0,
      middleStationIds: graph.nodeById.get(bId)?.stationIds ?? [],
      middleInRing: ringNodeSet.has(bId),
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
  geographic: Record<string, Point>,
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
  const bendQuality = routeBendQuality(graph, positions);

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
  const direction = directionalFidelity(graph, positions, geographic);
  const separation =
    style === 'moscow'
      ? ringSeparation(positions, geographic)
      : { minDistance: Number.POSITIVE_INFINITY, minRatio: Number.POSITIVE_INFINITY };
  const circularity =
    style === 'moscow'
      ? ringCircularity(positions)
      : [];

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
    sharpTurns: bendQuality.sharpTurns,
    zigzags: bendQuality.zigzags,
    selfCrossings: bendQuality.selfCrossings,
    sharpDetails: bendQuality.sharpDetails,
    doglegs,
    doglegDetails,
    terminalHooks,
    terminalHookDetails,
    northOrder: direction.northOrder,
    eastOrder: direction.eastOrder,
    ringCenterDistance: separation.minDistance,
    ringCenterRatio: separation.minRatio,
    ringCircularity: circularity,
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
  return metrics(
    graph,
    layout.positions,
    layout.geographicPositions,
    style,
  );
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
    sharpTurns: result.sharpTurns,
    zigzags: result.zigzags,
    selfX: result.selfCrossings,
    doglegs: result.doglegs,
    terminalHooks: result.terminalHooks,
    north: (result.northOrder * 100).toFixed(1) + '%',
    east: (result.eastOrder * 100).toFixed(1) + '%',
    ringGap:
      Number.isFinite(result.ringCenterDistance)
        ? result.ringCenterDistance.toFixed(1)
        : '—',
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
  if (
    result.sharpTurns ||
    result.zigzags ||
    result.selfCrossings
  ) {
    console.log('bend quality:', {
      sharpTurns: result.sharpTurns,
      zigzags: result.zigzags,
      selfCrossings: result.selfCrossings,
      worst: result.sharpDetails.slice(0, 8),
    });
    if (result.selfCrossings) {
      console.log(
        'self-crossing paths:',
        JSON.stringify(
          selfCrossingPathDetails(
            graph,
            computeLayout(graph, result.style, {
              moscowRings: rings,
            }).positions,
          ),
          null,
          2,
        ),
      );
    }
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
const geographicResult = results.find(
  (result) => result.style === 'geographic',
);
const baselineCrossings = geographicResult?.crossings ?? 0;
const geographicReference = computeLayout(graph, 'geographic', {
  moscowRings: rings,
});
const baselineMoscowDoglegs = moscowDoglegDetails(
  graph,
  geographicReference.positions,
).length;
const baselineTerminalHooks = moscowTerminalHookDetails(
  graph,
  geographicReference.positions,
).length;

const crossingBudget: Record<StyleId, number> = {
  geographic: baselineCrossings,
  taipei: Math.max(baselineCrossings + 12, Math.ceil(baselineCrossings * 1.45)),
  london: Math.max(baselineCrossings + 12, Math.ceil(baselineCrossings * 1.45)),
  moscow: Math.max(baselineCrossings + 18, Math.ceil(baselineCrossings * 1.6)),
  concentric: Math.max(baselineCrossings + 30, Math.ceil(baselineCrossings * 2.2)),
  hex: Math.max(baselineCrossings + 24, Math.ceil(baselineCrossings * 1.8)),
};

for (const result of results) {
  if (result.minNode < 28) {
    failures.push(
      `${result.style}: minimum station distance ${result.minNode.toFixed(1)} < 28`,
    );
  }
  if (result.shortEdges > 10) {
    failures.push(
      `${result.style}: ${result.shortEdges} short edges > 10`,
    );
  }
  if (result.crossings > crossingBudget[result.style]) {
    failures.push(
      `${result.style}: ${result.crossings} crossings > passenger budget ${crossingBudget[result.style]} (geographic baseline ${baselineCrossings})`,
    );
  }

  if (result.style !== 'geographic' && result.selfCrossings > 0) {
    failures.push(
      `${result.style}: ${result.selfCrossings} route self-crossings; schematic styles must preserve unambiguous route topology`,
    );
  }

  const sharpTurnBudget: Record<StyleId, number> = {
    geographic: 100,
    taipei: 20,
    london: 0,
    moscow: 25,
    concentric: 60,
    hex: 0,
  };
  const zigzagBudget: Record<StyleId, number> = {
    geographic: 140,
    taipei: 30,
    london: 65,
    moscow: 55,
    concentric: 70,
    hex: 85,
  };

  if (result.sharpTurns > sharpTurnBudget[result.style]) {
    failures.push(
      `${result.style}: ${result.sharpTurns} sharp turns > style budget ${sharpTurnBudget[result.style]}`,
    );
  }
  if (result.zigzags > zigzagBudget[result.style]) {
    failures.push(
      `${result.style}: ${result.zigzags} zig-zags > style budget ${zigzagBudget[result.style]}`,
    );
  }

  const northMinimum =
    result.style === 'concentric' ? 0.76 : 0.82;
  const eastMinimum =
    result.style === 'concentric' || result.style === 'moscow'
      ? 0.7
      : 0.75;

  if (result.northOrder < northMinimum) {
    failures.push(
      `${result.style}: north-up ordering ${(result.northOrder * 100).toFixed(1)}% < ${(northMinimum * 100).toFixed(0)}%`,
    );
  }
  if (result.eastOrder < eastMinimum) {
    failures.push(
      `${result.style}: east-west ordering ${(result.eastOrder * 100).toFixed(1)}% < ${(eastMinimum * 100).toFixed(0)}%`,
    );
  }

  if (result.style === 'moscow') {
    if (result.doglegs > baselineMoscowDoglegs + 3) {
      failures.push(
        `moscow: ${result.doglegs} alternating doglegs exceeds geographic baseline ${baselineMoscowDoglegs} + 3`,
      );
    }
    if (result.terminalHooks > baselineTerminalHooks + 1) {
      failures.push(
        `moscow: ${result.terminalHooks} terminal hooks exceeds geographic baseline ${baselineTerminalHooks} + 1`,
      );
    }
    for (const ring of result.ringCircularity) {
      if (ring.coefficientOfVariation > 0.025) {
        failures.push(
          `moscow: ${ring.id} is not circular enough (radius CV ${(ring.coefficientOfVariation * 100).toFixed(2)}%)`,
        );
      }
    }
    if (
      rings.length > 1 &&
      (result.ringCenterDistance < 80 ||
        result.ringCenterRatio < 0.45)
    ) {
      failures.push(
        `moscow: ring centers collapsed together (distance ${result.ringCenterDistance.toFixed(1)}, ratio ${result.ringCenterRatio.toFixed(2)})`,
      );
    }
  }

  if (
    (result.style === 'taipei' ||
      result.style === 'london' ||
      result.style === 'hex') &&
    result.angleError > 16
  ) {
    failures.push(
      `${result.style}: angular error ${result.angleError.toFixed(1)}° > 16°`,
    );
  }
}

console.log(
  'Moscow geographic bend baseline:',
  {
    doglegs: baselineMoscowDoglegs,
    terminalHooks: baselineTerminalHooks,
  },
);

const finalMoscow = results.find((result) => result.style === 'moscow');
console.log(
  'Moscow ring circularity:',
  finalMoscow?.ringCircularity.map((ring) => ({
    id: ring.id,
    radius: ring.meanRadius.toFixed(1),
    radiusCV: (ring.coefficientOfVariation * 100).toFixed(2) + '%',
  })),
);

console.log(
  'Validated Moscow rings:',
  rings.map((ring) => ({
    id: ring.id,
    stations: ring.nodes.map(
      (nodeId) => graph.nodeById.get(nodeId)?.name ?? nodeId,
    ),
  })),
);

const moscowLayoutForPathDiagnostics = computeLayout(
  graph,
  'moscow',
  { moscowRings: rings },
);
const moscowRingNodes = new Set(
  rings.flatMap((ring) => ring.nodes),
);
const selfCrossingPathDiagnostics = graph.lines.flatMap((line) =>
  line.paths.flatMap((path, pathIndex) => {
    let crossings = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      for (let j = i + 2; j < path.length - 1; j += 1) {
        if (
          properIntersection(
            moscowLayoutForPathDiagnostics.positions[path[i]],
            moscowLayoutForPathDiagnostics.positions[path[i + 1]],
            moscowLayoutForPathDiagnostics.positions[path[j]],
            moscowLayoutForPathDiagnostics.positions[path[j + 1]],
          )
        ) {
          crossings += 1;
        }
      }
    }
    if (!crossings) return [];
    return [{
      line: line.id,
      path: line.pathIds?.[pathIndex] ?? String(pathIndex),
      crossings,
      anchors: path
        .map((nodeId, index) => ({
          index,
          nodeId,
          name: graph.nodeById.get(nodeId)?.name ?? nodeId,
          ring: moscowRingNodes.has(nodeId),
          degree: graph.adjacency.get(nodeId)?.length ?? 0,
          stationIds: graph.nodeById.get(nodeId)?.stationIds ?? [],
        }))
        .filter(
          (item) =>
            item.ring ||
            item.degree > 2 ||
            item.stationIds.length > 1,
        ),
      stations: path.map(
        (nodeId) => graph.nodeById.get(nodeId)?.name ?? nodeId,
      ),
    }];
  }),
);
console.log(
  'Moscow self-crossing route paths JSON:',
  JSON.stringify(selfCrossingPathDiagnostics, null, 2),
);

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

if (failures.length) {
  throw new Error(
    'Passenger-map QA regression:\n' + failures.join('\n'),
  );
}
