import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeLayout } from '../src/layout';
import { SvgMap } from '../src/renderer/SvgMap';
import { concentricCenterNodeId, graph, workbookLayout } from './workbook-fixture';

const selected = [concentricCenterNodeId, graph.stationToNode.get('BR10'), graph.stationToNode.get('BL07')];
assert.equal(new Set(selected).size, 3);
const results = selected.map(id => {
  assert.ok(id);
  const layout = id === concentricCenterNodeId
    ? workbookLayout('concentric')
    : computeLayout(graph, 'concentric', { concentricCenterNodeId: id });
  assert.ok(layout.integrity.valid);
  assert.equal(layout.radialCenterNodeId, id);
  const center = layout.radialCenter;
  assert.ok(center);
  const point = layout.positions[id];
  const offset = Math.hypot(point.x - center.x, point.y - center.y);
  assert.ok(offset < 1e-5, `${id}: centre station offset ${offset}`);
  const name = graph.nodeById.get(id)?.name;
  assert.ok(name);
  const svg = renderToStaticMarkup(<SvgMap graph={graph} layout={layout} />);
  assert.ok(svg.includes(`data-concentric-center="${id}"`));
  assert.ok(svg.includes(`中心 ${name}`));
  return { id, name, offset, routes: layout.integrity.routeCount, paths: layout.integrity.pathCount };
});
assert.deepEqual(results.map(result => result.name), ['台北車站', '忠孝復興', '板橋']);
mkdirSync('qa-artifacts', { recursive: true });
writeFileSync('qa-artifacts/concentric-centres.json', JSON.stringify(results, null, 2));
console.log('Concentric centre regression:', results);
