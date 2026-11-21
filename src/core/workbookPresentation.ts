import type { GraphModel } from '../types';

export function defaultConcentricCenter(graph: GraphModel): string | undefined {
  const taipeiMain = graph.stationToNode.get('R10');
  if (!taipeiMain || graph.stationToNode.get('BL12') !== taipeiMain) return undefined;

  const taipeiMainStops = [['TPE_R', 'R10'], ['TPE_BL', 'BL12']];
  const hasTaipeiMain = taipeiMainStops.every(([lineId, stationId]) =>
    graph.lines.some(line => line.id === lineId && line.stationPaths.some(path => path.includes(stationId))),
  );
  return hasTaipeiMain ? taipeiMain : undefined;
}
