import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildGraph } from '../src/core/graph.ts';
import { validateMoscowRings } from '../src/core/moscowRings.ts';
import { importExcelBuffer } from '../src/io/importData.ts';
import { computeLayout } from '../src/layout/index.ts';
import { SvgMap } from '../src/renderer/SvgMap.tsx';
import type { StyleId } from '../src/types.ts';

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
