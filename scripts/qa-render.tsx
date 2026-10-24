import React from 'react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildGraph } from '../src/core/graph.ts';
import { validateMoscowRings } from '../src/core/moscowRings.ts';
import { importExcelBuffer } from '../src/io/importData.ts';
import { computeLayout } from '../src/layout/index.ts';
import { buildRenderedRoutePaths, sampledSelfCrossings } from '../src/renderer/routeGeometry';
import { SvgMap } from '../src/renderer/SvgMap.tsx';
import type { StationVisualStyle, StyleId } from '../src/types.ts';

const data = new Uint8Array(
  readFileSync(new URL('../TPE_Metro.xlsm', import.meta.url)),
);
const input = await importExcelBuffer(data);
const graph = buildGraph(input);
const rings = validateMoscowRings(graph, input.moscowRings ?? []);
const styles: StyleId[] = [
  'geographic',
  'taipei',
  'london',
  'moscow',
  'concentric',
  'hex',
];

const css = `
.map-background{fill:#fff}
.moscow-ring-halo{fill:none;stroke:#d8dee8;stroke-width:16;stroke-linecap:round;stroke-linejoin:round;opacity:.72}
.concentric-guide{fill:none;stroke:#dbe4ee;stroke-width:1.2;stroke-dasharray:5 9}
.ring-guide{display:none}
.station{stroke:#111827}
.station-normal{fill:#fff;stroke-width:2.5}
.interchange-outer{fill:#fff;stroke-width:3}
.interchange-inner{fill:#111827;stroke:none}
.ring-node-marker{display:none}
.tokyo-badge-shell{fill:#9ca3af;stroke:#30343b}
.tokyo-badge-inner,.taipei-code-badge{fill:#fff}
.taipei-transfer-shell{fill:#9ca3af;stroke:#30343b}
.station-code-prefix,.station-code-number,.station-code-suffix{fill:#111827;stroke:none;font-family:Arial,"Noto Sans TC",sans-serif;font-weight:900}
.osaka-code-badge{stroke:#fff}
.osaka-transfer-shell{fill:#fff;stroke:#4b5563}
.osaka-code-prefix,.osaka-code-number,.osaka-code-suffix,.osaka-code-text{fill:#fff;stroke:none;font-family:Arial,"Noto Sans TC",sans-serif;font-weight:900}
.moscow-station,.moscow-transfer-ring{fill:#fff}
.moscow-transfer-base{fill:#fff;stroke:#222}
.station-label{fill:#111827;font-family:Arial,"Noto Sans TC",sans-serif;font-weight:700;paint-order:stroke;stroke:#fff;stroke-linejoin:round}
`;

mkdirSync('qa-artifacts', { recursive: true });

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

const requestedStyles = process.argv.slice(2);
for (const name of requestedStyles) {
  if (!styles.includes(name as StyleId)) throw new Error(`Unknown layout style: ${name}`);
}
const selectedStyles = requestedStyles.length ? styles.filter(style => requestedStyles.includes(style)) : styles;
let renderCount = 0;
for (const style of selectedStyles) {
  const layout = computeLayout(graph, style, {
    moscowRings: rings,
  });

  for (const route of buildRenderedRoutePaths(graph, layout)) {
    const path = graph.lines.find(line => line.id === route.lineId)!.paths[route.pathIndex];
    const baseline = sampledSelfCrossings(path.map(id => layout.positions[id]));
    const rendered = sampledSelfCrossings(route.samples);
    if (rendered > baseline) throw new Error(`${style}/${route.lineId}: rendered curves add self-crossings (${rendered} > ${baseline})`);
    if (style === 'moscow' && rings.length && !buildRenderedRoutePaths(graph, layout).some(p => p.arcCount > 0)) throw new Error('Moscow has no rendered circular route arcs');
  }

  for (const stationStyle of stationStyles) {
    const markup = renderToStaticMarkup(
      <SvgMap
        graph={graph}
        layout={layout}
        zoom={1}
        stationStyle={stationStyle}
      />,
    ).replace(
      '>',
      `><style>${css}</style>`,
    );

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
      '<?xml version="1.0" encoding="UTF-8"?>\n' + markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '),
    );
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

