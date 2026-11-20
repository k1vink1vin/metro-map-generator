import { graph, workbookLayout } from './workbook-fixture';
import { buildRenderedRoutePaths, sampledSelfCrossings, circleThroughStations } from '../src/renderer/routeGeometry';
const layout = workbookLayout('moscow');
const results: object[] = [];
let compared = 0;
const names = new Map(graph.nodes.map(n=>[n.id,n.name]));
for(const axis of ['x','y'] as const)for(const [i,a] of graph.nodes.entries())for(const b of graph.nodes.slice(i+1)){
 const delta=layout.geographicPositions[b.id][axis]-layout.geographicPositions[a.id][axis];
 if (Math.abs(delta)<45) continue;
 compared++;
 if ((layout.positions[b.id][axis]-layout.positions[a.id][axis])*delta<=0) results.push({axis,a:names.get(a.id),b:names.get(b.id),source:Math.abs(delta)});
}
const radii = layout.moscowRings!.map(r => circleThroughStations(r.nodes.map(id=>layout.positions[id]))?.radius);
const routes = buildRenderedRoutePaths(graph,layout);
const minRingSpacing=layout.moscowRings!.map(r=>Math.min(...r.nodes.map((id,i)=>{
 const a=layout.positions[id],b=layout.positions[r.nodes[(i+1)%r.nodes.length]];
 return Math.hypot(a.x-b.x,a.y-b.y);
})));
console.log(JSON.stringify({ratio:process.env.TEST_RADIUS_RATIO,radii,minRingSpacing,compared,violations:results.length,violationsSample:results.slice(0,8),selfCrossingRoutes:routes.filter(r=>sampledSelfCrossings(r.samples)).map(r=>r.lineId)}));
