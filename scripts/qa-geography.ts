import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { importExcelBuffer } from '../src/io/importData';
import { buildGraph } from '../src/core/graph';
import { validateMoscowRings } from '../src/core/moscowRings';
import { computeLayout } from '../src/layout';
const input = await importExcelBuffer(new Uint8Array(readFileSync('TPE_Metro.xlsm')));
const graph = buildGraph(input);
const rings = validateMoscowRings(graph, input.moscowRings ?? []);
const layout = computeLayout(graph, 'moscow', {moscowRings:rings});
const ringNodes = new Set(rings.flatMap(r => r.nodes));
const violations: object[] = [];
let checked = 0;
for(let i=0;i<graph.nodes.length;i++) for(let j=i+1;j<graph.nodes.length;j++) {
 const a=graph.nodes[i],b=graph.nodes[j];
 for(const axis of ['x','y'] as const){
  const delta=layout.geographicPositions[b.id][axis]-layout.geographicPositions[a.id][axis];
  if(Math.abs(delta)<45)continue;
  checked++;
  const drawn=layout.positions[b.id][axis]-layout.positions[a.id][axis];
  if(Math.sign(delta)!==Math.sign(drawn)) violations.push({axis:axis==='x'?'east-west':'north-south',a:a.name,b:b.name,aId:a.id,bId:b.id,sourceGap:Math.abs(delta),drawnGap:Math.abs(drawn),bothOnRings:ringNodes.has(a.id)&&ringNodes.has(b.id)});
 }
}
violations.sort((a:any,b:any)=>b.sourceGap-a.sourceGap);
const sourceYs=Object.values(layout.geographicPositions).map(p=>p.y);
const lats=graph.nodes.map(n=>n.lat);
const thresholdKm=45*(Math.max(...lats)-Math.min(...lats))/(Math.max(...sourceYs)-Math.min(...sourceYs))*111.195;
const report={significantProjectedGap:45,approximateThresholdKm:thresholdKm,checked,violations:violations.length,fidelity:1-violations.length/checked,details:violations};
mkdirSync('qa-artifacts',{recursive:true});writeFileSync('qa-artifacts/moscow-geography.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,details:violations.slice(0,20)},null,2));

if (violations.length) throw new Error(`Moscow geographic order: ${violations.length} significant inversions`);
