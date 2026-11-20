import type { GraphModel } from '../types';

export function defaultConcentricCenter(graph: GraphModel, sourceName: string): string | undefined {
  if (sourceName.toLowerCase() !== 'tpe_metro.xlsm') return undefined;
  const taipeiMain = graph.stationToNode.get('R10');
  if (!taipeiMain || graph.stationToNode.get('BL12') !== taipeiMain) return undefined;
  return taipeiMain;
}
