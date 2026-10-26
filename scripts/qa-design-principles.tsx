import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { buildGraph } from '../src/core/graph.ts';
import { validateMoscowRings } from '../src/core/moscowRings.ts';
import { importExcelBuffer } from '../src/io/importData.ts';
import { computeLayout } from '../src/layout/index.ts';
import {
  buildRenderedRoutePaths,
  sampledSelfCrossings,
  stationAnchoredPath,
} from '../src/renderer/routeGeometry.ts';
import {
  buildGeometricBundleMap,
  offsetPathForLine,
} from '../src/renderer/geometry.ts';
import { SvgMap } from '../src/renderer/SvgMap.tsx';
import type { GraphModel, LayoutResult, Point, StyleId } from '../src/types.ts';

const data = new Uint8Array(
  readFileSync(new URL('../TPE_Metro.xlsm', import.meta.url)),
);
const input = await importExcelBuffer(data);
const graph = buildGraph(input);
const rings = validateMoscowRings(graph, input.moscowRings ?? []);
const allStyles: StyleId[] = ['taipei', 'london', 'moscow', 'concentric', 'hex'];
const requestedStyles = process.argv.slice(2);
for (const requested of requestedStyles) {
  if (!allStyles.includes(requested as StyleId)) {
    throw new Error(`Unknown schematic style: ${requested}`);
  }
}
const styles = requestedStyles.length
  ? allStyles.filter((style) => requestedStyles.includes(style))
  : allStyles;

const distance = (a: Point, b: Point) =>
  Math.hypot(b.x - a.x, b.y - a.y);

function structuralNode(graph: GraphModel, nodeId: string): boolean {
  const node = graph.nodeById.get(nodeId);
  if (!node) return true;
  if ((graph.adjacency.get(nodeId)?.length ?? 0) !== 2) return true;
  if (node.stationIds.length > 1) return true;
  let incidentLines = 0;
  for (const line of graph.lines) {
    if (line.paths.some((path) => path.includes(nodeId))) {
      incidentLines += 1;
      if (incidentLines > 1) return true;
    }
  }
  return false;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean < 1e-9) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / mean;
}

function angleErrorDegrees(a: Point, b: Point, stepDegrees: number): number {
  if (distance(a, b) < 1e-8) return 0;
  const step = (stepDegrees * Math.PI) / 180;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const snapped = Math.round(angle / step) * step;
  let diff = Math.abs(angle - snapped);
  while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
  return (diff * 180) / Math.PI;
}

function parseCommands(d: string): Array<{
  command: string;
  from?: Point;
  to: Point;
}> {
  const result: Array<{ command: string; from?: Point; to: Point }> = [];
  const regex = /([MLA])\s*([^MLA]*)/g;
  let match: RegExpExecArray | null;
  let current: Point | undefined;
  while ((match = regex.exec(d))) {
    const command = match[1];
    const numbers = (match[2].match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? [])
      .map(Number);
    let to: Point | undefined;
    if ((command === 'M' || command === 'L') && numbers.length >= 2) {
      to = { x: numbers[0], y: numbers[1] };
    } else if (command === 'A' && numbers.length >= 7) {
      to = {
        x: numbers[numbers.length - 2],
        y: numbers[numbers.length - 1],
      };
    }
    if (!to) continue;
    result.push({ command, from: current, to });
    current = to;
  }
  return result;
}

function renderedAngleAudit(layout: LayoutResult) {
  let worst = 0;
  let checked = 0;
  let illegalCurveCommands = 0;

  for (const route of buildRenderedRoutePaths(graph, layout)) {
    illegalCurveCommands +=
      (route.d.match(/[QC]/g) ?? []).length;
    const commands = parseCommands(route.d);
    for (const item of commands) {
      if (!item.from) continue;
      if (layout.style === 'concentric') {
        if (item.command === 'L') {
          const center = layout.radialCenter!;
          const vx = item.to.x - item.from.x;
          const vy = item.to.y - item.from.y;
          const rx = item.from.x - center.x;
          const ry = item.from.y - center.y;
          const cross = Math.abs(vx * ry - vy * rx);
          const scale = Math.max(1, Math.hypot(vx, vy) * Math.hypot(rx, ry));
          worst = Math.max(worst, (cross / scale) * 180 / Math.PI);
          checked += 1;
        } else if (item.command !== 'A') {
          illegalCurveCommands += 1;
        }
        continue;
      }

      if (item.command === 'A') {
        if (layout.style !== 'moscow') illegalCurveCommands += 1;
        continue;
      }
      if (item.command !== 'L') continue;
      worst = Math.max(
        worst,
        angleErrorDegrees(
          item.from,
          item.to,
          layout.style === 'hex' ? 60 : 45,
        ),
      );
      checked += 1;
    }
  }

  return { worstDegrees: worst, checked, illegalCurveCommands };
}

function topologyAudit(layout: LayoutResult) {
  const expectedPaths = graph.lines.reduce(
    (sum, line) => sum + line.paths.length,
    0,
  );
  const rendered = buildRenderedRoutePaths(graph, layout);
  const bundles = buildGeometricBundleMap(graph, layout.positions);
  const ringNodes = new Set(
    layout.style === 'moscow'
      ? layout.moscowRings?.flatMap((ring) => ring.nodes) ?? []
      : [],
  );
  let addedSelfCrossings = 0;
  const selfCrossingDetails: Array<{
    line: string;
    path: string;
    baseline: number;
    rendered: number;
  }> = [];
  let stationOrderFailures = 0;

  for (const route of rendered) {
    const line = graph.lines.find((candidate) => candidate.id === route.lineId)!;
    const path = line.paths[route.pathIndex];
    const baseline = sampledSelfCrossings(
      path.map((nodeId) => layout.positions[nodeId]),
    );
    const renderedCrossings = sampledSelfCrossings(route.samples);
    if (renderedCrossings > baseline) {
      addedSelfCrossings += 1;
      selfCrossingDetails.push({
        line: route.lineId,
        path:
          line.pathIds?.[route.pathIndex] ??
          String(route.pathIndex),
        baseline,
        rendered: renderedCrossings,
      });
    }

    const anchors = offsetPathForLine(
      graph,
      path,
      layout.positions,
      line.id,
      12,
      bundles,
    ).map((point, index) =>
      ringNodes.has(path[index])
        ? layout.positions[path[index]]
        : point,
    );

    let cursor = 0;
    for (const anchor of anchors) {
      let found = -1;
      for (let index = cursor; index < route.samples.length; index += 1) {
        if (distance(route.samples[index], anchor) < 1e-5) {
          found = index;
          break;
        }
      }
      if (found < 0) {
        stationOrderFailures += 1;
        break;
      }
      cursor = found;
    }
  }
  return {
    valid:
      layout.integrity.valid &&
      rendered.length === expectedPaths &&
      stationOrderFailures === 0,
    expectedPaths,
    renderedPaths: rendered.length,
    addedSelfCrossings,
    selfCrossingDetails,
    stationOrderFailures,
  };
}

function parallelAudit(layout: LayoutResult) {
  const bundles = buildGeometricBundleMap(graph, layout.positions);
  let samples = 0;
  let worstGapError = 0;
  let worstEndpointDrift = 0;

  for (const edge of graph.edges) {
    if (edge.lineIds.length < 2) continue;
    const a = layout.positions[edge.a];
    const b = layout.positions[edge.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-8) continue;
    const normal = { x: -dy / length, y: dx / length };

    const lanes: Array<{ lineId: string; oa: number; ob: number }> = [];
    for (const lineId of edge.lineIds) {
      const line = graph.lines.find((candidate) => candidate.id === lineId);
      if (!line) continue;
      let found: { path: string[]; index: number } | undefined;
      for (const path of line.paths) {
        for (let index = 0; index < path.length - 1; index += 1) {
          if (
            (path[index] === edge.a && path[index + 1] === edge.b) ||
            (path[index] === edge.b && path[index + 1] === edge.a)
          ) {
            found = { path, index };
            break;
          }
        }
        if (found) break;
      }
      if (!found) continue;
      const shifted = offsetPathForLine(
        graph,
        found.path,
        layout.positions,
        lineId,
        12,
        bundles,
      );
      const forward = found.path[found.index] === edge.a;
      const sa = shifted[forward ? found.index : found.index + 1];
      const sb = shifted[forward ? found.index + 1 : found.index];
      lanes.push({
        lineId,
        oa: (sa.x - a.x) * normal.x + (sa.y - a.y) * normal.y,
        ob: (sb.x - b.x) * normal.x + (sb.y - b.y) * normal.y,
      });
    }

    for (let i = 0; i < lanes.length; i += 1) {
      worstEndpointDrift = Math.max(
        worstEndpointDrift,
        Math.abs(lanes[i].oa - lanes[i].ob),
      );
      for (let j = i + 1; j < lanes.length; j += 1) {
        const gapA = Math.abs(lanes[i].oa - lanes[j].oa);
        const gapB = Math.abs(lanes[i].ob - lanes[j].ob);
        const expected = 12 * Math.abs(
          edge.lineIds.indexOf(lanes[i].lineId) -
          edge.lineIds.indexOf(lanes[j].lineId),
        );
        worstGapError = Math.max(
          worstGapError,
          Math.abs(gapA - expected),
          Math.abs(gapB - expected),
        );
        samples += 2;
      }
    }
  }

  return { samples, worstGapError, worstEndpointDrift };
}

function renderedSegmentLengths(
  layout: LayoutResult,
  lineId: string,
  path: string[],
): number[] {
  const bundles = buildGeometricBundleMap(graph, layout.positions);
  const ringNodes = new Set(
    layout.style === 'moscow'
      ? layout.moscowRings?.flatMap((ring) => ring.nodes) ?? []
      : [],
  );
  const offset = offsetPathForLine(
    graph,
    path,
    layout.positions,
    lineId,
    12,
    bundles,
  ).map((point, index) =>
    ringNodes.has(path[index]) ? layout.positions[path[index]] : point,
  );

  return path.slice(0, -1).map((nodeId, index) => {
    const nextId = path[index + 1];
    const geometry = stationAnchoredPath(
      graph,
      layout,
      [nodeId, nextId],
      [offset[index], offset[index + 1]],
      lineId,
    );
    return geometry.samples.slice(1).reduce(
      (sum, point, sampleIndex) =>
        sum + distance(geometry.samples[sampleIndex], point),
      0,
    );
  });
}

function equidistanceAudit(layout: LayoutResult) {
  const runDetails: Array<{
    line: string;
    path: string;
    from: string;
    to: string;
    cv: number;
    lengths: number[];
  }> = [];

  for (const line of graph.lines) {
    for (let pathIndex = 0; pathIndex < line.paths.length; pathIndex += 1) {
      const path = line.paths[pathIndex];
      const lengths = renderedSegmentLengths(layout, line.id, path);
      const anchors = new Set<number>([0, path.length - 1]);
      path.forEach((nodeId, index) => {
        if (structuralNode(graph, nodeId)) anchors.add(index);
      });
      const sorted = [...anchors].sort((a, b) => a - b);
      for (let index = 0; index < sorted.length - 1; index += 1) {
        const start = sorted[index];
        const end = sorted[index + 1];
        if (end - start < 2) continue;
        const run = lengths.slice(start, end);
        if (run.length < 2) continue;
        runDetails.push({
          line: line.id,
          path: line.pathIds?.[pathIndex] ?? String(pathIndex),
          from: graph.nodeById.get(path[start])?.name ?? path[start],
          to: graph.nodeById.get(path[end])?.name ?? path[end],
          cv: coefficientOfVariation(run),
          lengths: run.map((value) => Number(value.toFixed(2))),
        });
      }
    }
  }

  const sorted = [...runDetails].sort((a, b) => a.cv - b.cv);
  return {
    runs: sorted.length,
    maxCv: sorted.at(-1)?.cv ?? 0,
    p95Cv:
      sorted[Math.floor(Math.max(0, sorted.length - 1) * 0.95)]?.cv ?? 0,
    medianCv: sorted[Math.floor(sorted.length * 0.5)]?.cv ?? 0,
    worstRuns: [...sorted]
      .sort((a, b) => b.cv - a.cv)
      .slice(0, 8),
  };
}

function syntheticParallelGapAudit() {
  let worstGapError = 0;

  for (const bendDegrees of [45, 60]) {
    const radians = (bendDegrees * Math.PI) / 180;
    const positions = {
      PA: { x: 0, y: 0 },
      PB: { x: 100, y: 0 },
      PC: {
        x: 100 + Math.cos(radians) * 100,
        y: Math.sin(radians) * 100,
      },
    };
    const testGraph = buildGraph({
      stations: [
        { id: 'PA', lat: 0, lon: 0 },
        { id: 'PB', lat: 0, lon: 1 },
        { id: 'PC', lat: 1, lon: 2 },
      ],
      lines: [
        {
          id: 'P1',
          color: '#ff0000',
          paths: [['PA', 'PB', 'PC']],
        },
        {
          id: 'P2',
          color: '#0000ff',
          paths: [['PA', 'PB', 'PC']],
        },
      ],
    });
    const bundles = buildGeometricBundleMap(
      testGraph,
      positions,
    );
    const lanes = ['P1', 'P2'].map((lineId) =>
      offsetPathForLine(
        testGraph,
        ['PA', 'PB', 'PC'],
        positions,
        lineId,
        12,
        bundles,
      ),
    );

    for (let segment = 0; segment < 2; segment += 1) {
      const ids = [
        ['PA', 'PB'],
        ['PB', 'PC'],
      ][segment] as ['PA' | 'PB', 'PB' | 'PC'];
      const a = positions[ids[0]];
      const b = positions[ids[1]];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      const normal = {
        x: -dy / length,
        y: dx / length,
      };

      for (const endpoint of [segment, segment + 1]) {
        const gap = Math.abs(
          (lanes[0][endpoint].x - lanes[1][endpoint].x) *
            normal.x +
          (lanes[0][endpoint].y - lanes[1][endpoint].y) *
            normal.y,
        );
        worstGapError = Math.max(
          worstGapError,
          Math.abs(gap - 12),
        );
      }
    }
  }

  return { worstGapError };
}

function roundedCornerAudit(layout: LayoutResult) {
  const markup = renderToStaticMarkup(
    React.createElement(SvgMap, {
      graph,
      layout,
      zoom: 1,
      stationStyle: 'taipei',
    }),
  );
  const routeCount = buildRenderedRoutePaths(graph, layout).length;
  const joins = (markup.match(/stroke-linejoin="round"/g) ?? []).length;
  const caps = (markup.match(/stroke-linecap="round"/g) ?? []).length;
  const widths = [...markup.matchAll(
    /data-line-id="[^"]+"[^>]*stroke-width="([^"]+)"/g,
  )].map((match) => Number(match[1]));

  return {
    routeCount,
    rounded: joins >= routeCount && caps >= routeCount,
    uniformStroke:
      widths.length === routeCount &&
      widths.every((width) => Math.abs(width - widths[0]) < 1e-9),
    cornerRadius: widths.length ? widths[0] / 2 : 0,
  };
}

const hardFailures: string[] = [];
const syntheticParallel = syntheticParallelGapAudit();

for (const style of styles) {
  const layout = computeLayout(graph, style, { moscowRings: rings });
  const topology = topologyAudit(layout);
  const angles = renderedAngleAudit(layout);
  const rounded = roundedCornerAudit(layout);
  const parallel = parallelAudit(layout);
  const spacing = equidistanceAudit(layout);

  const topologyCompliant =
    topology.valid && topology.addedSelfCrossings === 0;
  const angleCompliant =
    angles.illegalCurveCommands === 0 &&
    angles.worstDegrees < 1e-6;
  const roundedCompliant =
    rounded.rounded && rounded.uniformStroke;
  const parallelCompliant =
    syntheticParallel.worstGapError < 1e-6 &&
    (
      parallel.samples === 0 ||
      (
        parallel.worstGapError < 0.25 &&
        parallel.worstEndpointDrift < 0.25
      )
    );
  // "Completely equidistant" is represented by a strict 2% CV target.
  // Keep this diagnostic (not yet a deploy blocker) until the layout solvers
  // are upgraded for all five schematic grammars.
  const spacingCompliant = spacing.maxCv <= 0.02;

  if (!topologyCompliant) {
    hardFailures.push(`${style}: topology relation/order regression`);
  }
  if (!angleCompliant) {
    hardFailures.push(
      `${style}: angular grammar error ${angles.worstDegrees}°`,
    );
  }
  if (!roundedCompliant) {
    hardFailures.push(`${style}: route corners are not uniformly rounded`);
  }
  if (!parallelCompliant) {
    hardFailures.push(
      `${style}: parallel lane spacing drift ${Math.max(
        parallel.worstGapError,
        syntheticParallel.worstGapError,
      )}px`,
    );
  }
  if (!spacingCompliant) {
    hardFailures.push(
      `${style}: ordinary-station spacing CV ${(
        spacing.maxCv * 100
      ).toFixed(2)}% exceeds 2%`,
    );
  }

  console.log(
    '[design-principles]',
    JSON.stringify({
      style,
      compliant: {
        topology: topologyCompliant,
        angles: angleCompliant,
        roundedCorners: roundedCompliant,
        parallelSpacing: parallelCompliant,
        equidistantStations: spacingCompliant,
      },
      topology,
      angles,
      rounded,
      parallel: {
        ...parallel,
        synthetic45And60WorstGapError:
          syntheticParallel.worstGapError,
      },
      spacing: {
        runs: spacing.runs,
        maxCvPercent: Number((spacing.maxCv * 100).toFixed(2)),
        p95CvPercent: Number((spacing.p95Cv * 100).toFixed(2)),
        medianCvPercent: Number((spacing.medianCv * 100).toFixed(2)),
        worstRuns: spacing.worstRuns.map((run) => ({
          ...run,
          cvPercent: Number((run.cv * 100).toFixed(2)),
          cv: undefined,
        })),
      },
    }),
  );
}

if (hardFailures.length) {
  throw new Error(
    'Schematic design-principle regression:\n' +
      hardFailures.join('\n'),
  );
}
