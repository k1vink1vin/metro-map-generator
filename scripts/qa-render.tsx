import React from 'react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildGraph } from '../src/core/graph.ts';
import { validateMoscowRings } from '../src/core/moscowRings.ts';
import { importExcelBuffer } from '../src/io/importData.ts';
import { computeLayout } from '../src/layout/index.ts';
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
.ring-guide{display:none}
.station{stroke:#111827}
.station-normal{fill:#fff;stroke-width:2.5}
.interchange-outer{fill:#fff;stroke-width:3}
.interchange-inner{fill:#111827;stroke:none}
.ring-node-marker{display:none}
.tokyo-badge-shell{fill:#9ca3af;stroke:#30343b}
.tokyo-badge-inner,.taipei-code-badge{fill:#fff}
.taipei-transfer-shell{fill:#9ca3af;stroke:#30343b}
.station-code-prefix,.station-code-number{fill:#111827;stroke:none;font-family:Arial,"Noto Sans TC",sans-serif;font-weight:900}
.moscow-station,.moscow-transfer-ring{fill:#fff}
.moscow-transfer-base{fill:#fff;stroke:#222}
.station-label{fill:#111827;font-family:Arial,"Noto Sans TC",sans-serif;font-weight:700;paint-order:stroke;stroke:#fff;stroke-linejoin:round}
`;

mkdirSync('qa-artifacts', { recursive: true });

for (const style of styles) {
  const layout = computeLayout(graph, style, {
    moscowRings: rings,
  });
  const markup = renderToStaticMarkup(
    <SvgMap graph={graph} layout={layout} zoom={1} />,
  ).replace(
    '>',
    `><style>${css}</style>`,
  );
  writeFileSync(
    `qa-artifacts/${style}.svg`,
    '<?xml version="1.0" encoding="UTF-8"?>\n' + markup,
  );
}

console.log(
  `Rendered ${styles.length} QA SVGs from TPE_Metro.xlsm to qa-artifacts/`,
);


const stationStyles: StationVisualStyle[] = [
  'taipei',
  'tokyo',
  'moscow',
];
const stationLayout = computeLayout(graph, 'taipei', {
  moscowRings: rings,
});

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

for (const stationStyle of stationStyles) {
  const markup = renderToStaticMarkup(
    <SvgMap
      graph={graph}
      layout={stationLayout}
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
        `${stationStyle}: same-line branch junction ${node.id} was rendered as an interchange`,
      );
    }
  }

  writeFileSync(
    `qa-artifacts/stations-${stationStyle}.svg`,
    '<?xml version="1.0" encoding="UTF-8"?>\n' + markup,
  );
}

console.log(
  `Rendered ${stationStyles.length} station-style QA SVGs.`,
);
