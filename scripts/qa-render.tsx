import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildRenderedRoutePaths, sampledSelfCrossings } from '../src/renderer/routeGeometry';
import { SvgMap } from '../src/renderer/SvgMap.tsx';
import type { StationVisualStyle, StyleId } from '../src/types.ts';

import { graph, rings, input, workbookSha256, workbookLayout } from './workbook-fixture';

const styles: StyleId[] = [
  'geographic',
  'taipei',
  'london',
  'moscow',
  'concentric',
  'hex',
];

mkdirSync('qa-artifacts', { recursive: true });
writeFileSync('qa-artifacts/workbook-manifest.json', JSON.stringify({
  source: 'TPE_Metro.xlsm',
  sha256: workbookSha256,
  stationRecords: input.stations.length,
  stations: graph.nodes.map(({ id, name, nameEn, stationIds }) => ({ id, name, nameEn, stationIds })),
  routes: graph.lines.map(line => ({
    id: line.id,
    paths: line.paths.map((nodes, index) => ({
      nodes,
      id: line.pathIds?.[index] ?? String(index),
      color: line.pathColors?.[index] ?? line.color,
    })),
  })),
}, null, 2));

const stationStyles: StationVisualStyle[] = [
  'taipei',
  'tokyo',
  'osaka',
  'moscow',
];

const sameLineBranchJunctions = graph.nodes.filter((node) => {
  if (node.stationIds.length !== 1) return false;
  if ((graph.adjacency.get(node.id)?.length ?? 0) <= 2) return false;

  const incidentLineIds = new Set<string>();
  for (const line of graph.lines) {
    if (line.paths.some((path) => path.includes(node.id))) {
      incidentLineIds.add(line.id);
    }
  }
  return incidentLineIds.size === 1;
});

if (!sameLineBranchJunctions.length) {
  throw new Error(
    'Expected at least one same-line branch junction in TPE_Metro.xlsm QA fixture.',
  );
}

const suffixedStationIds = graph.nodes.flatMap((node) =>
  node.stationIds.filter((stationId) =>
    /^[A-Za-z]+[-_ ]?\d+[A-Za-z]$/.test(stationId.trim()),
  ),
);

if (!suffixedStationIds.length) {
  throw new Error(
    'Expected at least one suffixed station code such as G03A/R22A in TPE_Metro.xlsm QA fixture.',
  );
}

const normalizedSuffixCodes = suffixedStationIds.map((stationId) =>
  stationId.trim().toUpperCase(),
);

function abruptRouteReversals(
  points: Array<{ x: number; y: number }>,
): Array<{
  sampleIndex: number;
  degrees: number;
  point: { x: number; y: number };
}> {
  const segments: Array<{
    sampleIndex: number;
    direction: number;
  }> = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
    segments.push({
      sampleIndex: index,
      direction: Math.atan2(b.y - a.y, b.x - a.x),
    });
  }

  const reversals: Array<{
    sampleIndex: number;
    degrees: number;
    point: { x: number; y: number };
  }> = [];
  for (let index = 1; index < segments.length; index += 1) {
    let delta =
      segments[index].direction -
      segments[index - 1].direction;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const degrees = Math.abs(delta) * 180 / Math.PI;
    if (degrees >= 150) {
      const sampleIndex = segments[index].sampleIndex;
      reversals.push({
        sampleIndex,
        degrees,
        point: points[sampleIndex],
      });
    }
  }
  return reversals;
}

const requestedStyles = process.argv.slice(2);
for (const name of requestedStyles) {
  if (!styles.includes(name as StyleId)) throw new Error(`Unknown layout style: ${name}`);
}
const selectedStyles = requestedStyles.length ? styles.filter(style => requestedStyles.includes(style)) : styles;
let renderCount = 0;
const renderFailures: string[] = [];
for (const style of selectedStyles) {
  const layout = workbookLayout(style);

  if (style !== 'geographic') {
    let minimum = Number.POSITIVE_INFINITY;
    for (let i = 0; i < graph.nodes.length; i++) {
      for (let j = i + 1; j < graph.nodes.length; j++) {
        const a = layout.positions[graph.nodes[i].id];
        const b = layout.positions[graph.nodes[j].id];
        minimum = Math.min(minimum, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    if (minimum < 28) {
      renderFailures.push(`${style}: distinct stations are only ${minimum.toFixed(2)} units apart (minimum 28)`);
    }
  }

  for (const route of buildRenderedRoutePaths(graph, layout)) {
    const path = graph.lines.find(line => line.id === route.lineId)!.paths[route.pathIndex];
    const baseline = sampledSelfCrossings(path.map(id => layout.positions[id]));
    const rendered = sampledSelfCrossings(route.samples);
    if (style === 'geographic' && rendered > baseline) renderFailures.push(`${style}/${route.lineId}: rendered curves add self-crossings (${rendered} > ${baseline})`);
    if (style !== 'geographic' && rendered > 0) {
      renderFailures.push(`${style}/${route.lineId}: ${rendered} self-crossings in the rendered path`);
    }
    if (style === 'concentric') {
      const reversals = abruptRouteReversals(route.samples);
      if (reversals.length) renderFailures.push(`${style}/${route.lineId}: ${reversals.length} near-180 degree U-turns`);
    }

    if (style === 'geographic') {
      if (route.samples.length !== path.length) {
        throw new Error(
          `geographic/${route.lineId}: expected one rendered point per station anchor`,
        );
      }
      route.samples.forEach((point, index) => {
        const expected = layout.positions[path[index]];
        if (Math.hypot(point.x - expected.x, point.y - expected.y) > 1e-7) {
          throw new Error(
            `geographic/${route.lineId}: renderer moved station ${path[index]} away from its projected lat/lon position`,
          );
        }
      });
    }

    if (style === 'moscow') {
      const reversals = abruptRouteReversals(route.samples);
      if (reversals.length) {
        throw new Error(
          `moscow/${route.lineId}: rendered route contains a >=150° U-turn: ` +
          JSON.stringify({
            reversals,
            stations: path.map((nodeId) => ({
              nodeId,
              name: graph.nodeById.get(nodeId)?.name ?? nodeId,
              point: layout.positions[nodeId],
            })),
          }),
        );
      }
    }

    if (style === 'moscow' && rings.length && !buildRenderedRoutePaths(graph, layout).some(p => p.arcCount > 0)) throw new Error('Moscow has no rendered circular route arcs');
  }

  for (const stationStyle of stationStyles) {
    const markup = renderToStaticMarkup(
      <SvgMap
        graph={graph}
        layout={layout}
        zoom={1}
        stationStyle={stationStyle}
        sourceName="TPE_Metro.xlsm"
      />,
    );

    if (markup.includes(' / branch') || markup.includes('／branch')) {
      throw new Error(`${style}/${stationStyle}: untranslated branch label`);
    }
    if (!markup.includes('id="map-provenance"') || !markup.includes('data-public-use="not-verified"')) {
      throw new Error(`${style}/${stationStyle}: missing non-official map origin warning`);
    }
    if (!markup.includes('台鐵／高鐵僅顯示輸入資料所列部分車站')) {
      throw new Error(`${style}/${stationStyle}: missing partial railway coverage disclosure`);
    }
    if (!markup.includes('新北投支線') || !markup.includes('小碧潭支線')) {
      throw new Error(`${style}/${stationStyle}: missing explicit Taiwanese branch names`);
    }
    const bilingualReady = graph.nodes.every(node => Boolean(node.nameEn?.trim()));
    if (!markup.includes(`data-bilingual-ready="${bilingualReady}"`)) {
      throw new Error(`${style}/${stationStyle}: bilingual readiness flag disagrees with source data`);
    }
    if (!bilingualReady && !markup.includes('英文站名缺漏：')) {
      throw new Error(`${style}/${stationStyle}: missing visible bilingual data warning`);
    }
    const markers = (markup.match(/data-node-id="/g) ?? []).length;
    const labels = (markup.match(/class="station-label"/g) ?? []).length;
    if (markers !== graph.nodes.length || labels !== graph.nodes.length) {
      renderFailures.push(`${style}/${stationStyle}: ${markers} markers / ${labels} labels for ${graph.nodes.length} topology stations`);
    }
    const viewport = markup.match(/viewBox="([^"]+)"/);
    const dimensions = viewport?.[1].trim().split(/\s+/).map(Number);
    const maxDimension = Math.max(12000, graph.nodes.length * 40);
    if (!dimensions || dimensions.length !== 4 || dimensions.some((n) => !Number.isFinite(n))) {
      renderFailures.push(`${style}/${stationStyle}: invalid SVG viewport`);
    } else if (Math.max(dimensions[2], dimensions[3]) > maxDimension) {
      renderFailures.push(`${style}/${stationStyle}: ${dimensions[2].toFixed(0)}×${dimensions[3].toFixed(0)} viewport exceeds ${maxDimension}, stations become unreadably small`);
    }

    const expectedStationScale = style === 'geographic' ? '0.82' : '1';
    const expectedLabelSize = style === 'geographic' ? '13' : '14';
    if (!markup.includes(`data-station-visual-scale="${expectedStationScale}"`) ||
        !markup.includes(`data-label-font-size="${expectedLabelSize}"`)) {
      throw new Error(`${style}/${stationStyle}: unexpected station or label scale`);
    }

    for (const node of sameLineBranchJunctions) {
      const marker = `data-node-id="${node.id}" data-interchange="false"`;
      if (!markup.includes(marker)) {
        throw new Error(
          `${style}/${stationStyle}: same-line branch junction ${node.id} was rendered as an interchange`,
        );
      }
    }

    if (
      stationStyle === 'taipei' ||
      stationStyle === 'tokyo' ||
      stationStyle === 'osaka'
    ) {
      const missing = normalizedSuffixCodes.filter(
        (code) => !markup.includes(`data-station-code="${code}"`),
      );
      if (missing.length) {
        throw new Error(
          `${style}/${stationStyle}: suffixed station codes missing from rendered badges: ${missing.slice(0, 5).join(', ')}`,
        );
      }
    }

    if (stationStyle === 'taipei') {
      for (const code of normalizedSuffixCodes) {
        const badgePattern = new RegExp(
          `class="taipei-code-badge" data-station-code="${code}" data-suffixed="true" style="fill:#ffffff;stroke:[^"]+"`,
        );
        if (!badgePattern.test(markup)) {
          throw new Error(
            `${style}/taipei: suffixed badge ${code} must remain white with route-color outline`,
          );
        }
      }
    }

    if (
      stationStyle === 'osaka' &&
      (!markup.includes('class="osaka-code-text"') ||
        markup.includes('class="osaka-code-prefix"'))
    ) {
      throw new Error(
        `${style}/osaka: Osaka badges must use horizontal single-line station codes`,
      );
    }

    if (style === 'moscow') {
      const haloCount =
        (markup.match(/class="moscow-ring-halo"/g) ?? []).length;
      if (haloCount !== rings.length) {
        throw new Error(
          `moscow/${stationStyle}: expected ${rings.length} ring halos, rendered ${haloCount}`,
        );
      }
    }

    writeFileSync(
      `qa-artifacts/${style}--stations-${stationStyle}.svg`,
      '<?xml version="1.0" encoding="UTF-8"?>\n' + markup,
    );
    if (style === 'moscow' && stationStyle === 'taipei') {
      const hui = graph.nodes.find(node => node.name === '迴龍');
      const tao = graph.nodes.find(node => node.name === '桃園車站');
      if (!hui || !tao) throw new Error('Missing named geographic comparison stations');
      const a = layout.positions[hui.id], b = layout.positions[tao.id];
      const padding = 110;
      const focusBox = `${Math.min(a.x,b.x)-padding} ${Math.min(a.y,b.y)-padding} ${Math.abs(a.x-b.x)+padding*2} ${Math.abs(a.y-b.y)+padding*2}`;
      const focus = markup.replace(/viewBox="[^"]+"/, `viewBox="${focusBox}"`)
        .replace('</svg>', `<g fill="none" stroke="#111827" stroke-width="3"><circle cx="${a.x}" cy="${a.y}" r="24"/><circle cx="${b.x}" cy="${b.y}" r="24"/><path stroke-dasharray="8 6" d="M ${b.x} ${b.y} L ${a.x} ${a.y}"/></g><g fill="#111827" font-size="20" font-weight="bold"><text x="${a.x+28}" y="${a.y-30}">迴龍</text><text x="${b.x+28}" y="${b.y+44}">桃園車站</text></g></svg>`);
      writeFileSync('qa-artifacts/moscow--huilong-taoyuan-detail.svg', '<?xml version="1.0" encoding="UTF-8"?>\n' + focus);
    }
    renderCount += 1;
  }
}

console.log(
  `Rendered ${renderCount} layout/station-style QA SVGs from TPE_Metro.xlsm.`,
);
console.log(
  'Suffixed station codes:',
  normalizedSuffixCodes,
);


// Collect all 24 previews for inspection even when a style fails geometry QA.
// The job still fails and must never be treated as a passing passenger map.
if (renderFailures.length) throw new Error('Rendered topology failures:\n' + renderFailures.join('\n'));
