import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildGraph } from '../src/core/graph';
import { validateMoscowRings } from '../src/core/moscowRings';
import { defaultConcentricCenter } from '../src/core/workbookPresentation';
import { importExcelBuffer } from '../src/io/importData';
import { computeLayout } from '../src/layout';
import type { LayoutResult, StyleId } from '../src/types';

const workbook = readFileSync(new URL('../TPE_Metro.xlsm', import.meta.url));
export const workbookSha256 = createHash('sha256').update(workbook).digest('hex');
export const input = await importExcelBuffer(new Uint8Array(workbook));
export const graph = buildGraph(input);
export const rings = validateMoscowRings(graph, input.moscowRings ?? []);
export const concentricCenterNodeId = defaultConcentricCenter(graph, 'TPE_Metro.xlsm');
if (!concentricCenterNodeId || graph.nodeById.get(concentricCenterNodeId)?.name !== '台北車站') {
  throw new Error('The canonical workbook must provide 台北車站 as the concentric centre.');
}

const layouts = new Map<StyleId, LayoutResult>();
export function workbookLayout(style: StyleId) {
  const cached = layouts.get(style);
  if (cached) return cached;
  const layout = computeLayout(graph, style, { moscowRings: rings, concentricCenterNodeId });
  layouts.set(style, layout);
  return layout;
}
