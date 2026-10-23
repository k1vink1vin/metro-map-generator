import type {
  GraphEdge,
  GraphLine,
  GraphModel,
  GraphNode,
  NetworkInput,
} from '../types';

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export function buildGraph(input: NetworkInput): GraphModel {
  if (!input.stations.length) {
    throw new Error('At least one station is required.');
  }

  const byStation = new Map(input.stations.map((station) => [station.id, station]));
  const groups = new Map<string, typeof input.stations>();

  for (const station of input.stations) {
    if (!station.id) throw new Error('Station id cannot be empty.');
    if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) {
      throw new Error(`Invalid coordinates for station ${station.id}.`);
    }
    const groupId = station.complexId?.trim() || station.id;
    const group = groups.get(groupId) ?? [];
    group.push(station);
    groups.set(groupId, group);
  }

  const stationToNode = new Map<string, string>();
  const nodes: GraphNode[] = [];

  for (const [groupId, stations] of groups) {
    const lat = stations.reduce((sum, item) => sum + item.lat, 0) / stations.length;
    const lon = stations.reduce((sum, item) => sum + item.lon, 0) / stations.length;
    const name =
      stations.find((item) => item.name?.trim())?.name?.trim() ??
      stations.map((item) => item.id).join(' / ');

    nodes.push({
      id: groupId,
      stationIds: stations.map((item) => item.id),
      name,
      lat,
      lon,
    });

    for (const station of stations) stationToNode.set(station.id, groupId);
  }

  const edgeMap = new Map<string, GraphEdge>();
  const graphLines: GraphLine[] = [];

  for (const line of input.lines) {
    if (!line.id) throw new Error('Line id cannot be empty.');
    const paths = line.paths.map((path) => {
      const mapped = path.map((stationId) => {
        if (!byStation.has(stationId)) {
          throw new Error(`Line ${line.id} references unknown station ${stationId}.`);
        }
        return stationToNode.get(stationId)!;
      });

      return mapped.filter((nodeId, index) => index === 0 || nodeId !== mapped[index - 1]);
    });

    graphLines.push({
      id: line.id,
      name: line.name?.trim() || line.id,
      color: line.color || '#64748b',
      paths,
    });

    for (const path of paths) {
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = path[i];
        const b = path[i + 1];
        if (a === b) continue;
        const key = edgeKey(a, b);
        const existing = edgeMap.get(key);
        if (existing) {
          if (!existing.lineIds.includes(line.id)) existing.lineIds.push(line.id);
        } else {
          edgeMap.set(key, { key, a, b, lineIds: [line.id] });
        }
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);

  for (const edge of edgeMap.values()) {
    adjacency.get(edge.a)?.push(edge.b);
    adjacency.get(edge.b)?.push(edge.a);
    edge.lineIds.sort();
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = [...edgeMap.values()];

  return {
    nodes,
    nodeById,
    stationToNode,
    edges,
    edgeByKey: edgeMap,
    adjacency,
    lines: graphLines,
  };
}

export function nodeDegree(graph: GraphModel, nodeId: string): number {
  return graph.adjacency.get(nodeId)?.length ?? 0;
}

/**
 * Enumerates bounded simple cycles in an undirected graph. It is intentionally
 * bounded because enumerating every simple cycle can be exponential.
 */
export function findSimpleCycles(
  graph: GraphModel,
  maxLength = 28,
  maxCycles = 500,
): string[][] {
  const ids = graph.nodes.map((node) => node.id).sort();
  const cycles = new Map<string, string[]>();

  const canonicalize = (cycle: string[]): string => {
    const variants: string[] = [];
    for (const candidate of [cycle, [...cycle].reverse()]) {
      for (let i = 0; i < candidate.length; i += 1) {
        variants.push([...candidate.slice(i), ...candidate.slice(0, i)].join('|'));
      }
    }
    return variants.sort()[0];
  };

  for (const start of ids) {
    const visited = new Set<string>([start]);
    const path = [start];

    const dfs = (current: string) => {
      if (cycles.size >= maxCycles || path.length > maxLength) return;

      for (const next of graph.adjacency.get(current) ?? []) {
        if (next === start && path.length >= 3) {
          const cycle = [...path];
          cycles.set(canonicalize(cycle), cycle);
          if (cycles.size >= maxCycles) return;
          continue;
        }

        if (visited.has(next)) continue;
        // Prevent exploring equivalent cycles from every possible smallest node.
        if (next < start) continue;

        visited.add(next);
        path.push(next);
        dfs(next);
        path.pop();
        visited.delete(next);
      }
    };

    dfs(start);
    if (cycles.size >= maxCycles) break;
  }

  return [...cycles.values()];
}
