import type {
  GraphEdge,
  GraphLine,
  GraphModel,
  GraphNode,
  NetworkInput,
  Station,
} from '../types';

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

const COORD_TOLERANCE = 0.0000001;

function normalizeStationName(name?: string): string {
  return (name ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\\s\\-_—–·・.,，。()（）\\[\\]【】]/g, '');
}

function sameCoordinates(a: Station, b: Station): boolean {
  return (
    Math.abs(a.lat - b.lat) <= COORD_TOLERANCE &&
    Math.abs(a.lon - b.lon) <= COORD_TOLERANCE
  );
}

function assertCoordinatesMatch(
  stations: Station[],
  label: string,
): void {
  if (stations.length <= 1) return;

  const reference = stations[0];
  for (const station of stations.slice(1)) {
    if (!sameCoordinates(reference, station)) {
      throw new Error(
        `Transfer station "${label}" has inconsistent coordinates: ` +
          `${reference.id} (${reference.lat}, ${reference.lon}) vs ` +
          `${station.id} (${station.lat}, ${station.lon}). ` +
          'Use one shared latitude/longitude for every ID of the same physical transfer station.',
      );
    }
  }
}

function coordinateKey(station: Station): string {
  return `${station.lat.toFixed(7)}|${station.lon.toFixed(7)}`;
}

function buildStationGroups(stations: Station[]): Map<string, Station[]> {
  const byName = new Map<string, Station[]>();
  for (const station of stations) {
    const normalizedName = normalizeStationName(station.name);
    if (!normalizedName) continue;
    const sameName = byName.get(normalizedName) ?? [];
    sameName.push(station);
    byName.set(normalizedName, sameName);
  }

  for (const group of byName.values()) {
    if (group.length <= 1) continue;
    const label = group[0].name?.trim() || group[0].id;
    assertCoordinatesMatch(group, label);
  }

  const groups = new Map<string, Station[]>();
  const explicitComplexes = new Map<string, Station[]>();
  const unassigned: Station[] = [];

  for (const station of stations) {
    const complexId = station.complexId?.trim();
    if (complexId) {
      const group = explicitComplexes.get(complexId) ?? [];
      group.push(station);
      explicitComplexes.set(complexId, group);
    } else {
      unassigned.push(station);
    }
  }

  for (const [complexId, group] of explicitComplexes) {
    assertCoordinatesMatch(group, complexId);
    groups.set(complexId, group);
  }

  const byCoordinate = new Map<string, Station[]>();
  for (const station of unassigned) {
    const key = coordinateKey(station);
    const group = byCoordinate.get(key) ?? [];
    group.push(station);
    byCoordinate.set(key, group);
  }

  const transferKeys = [...byCoordinate.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key]) => key)
    .sort();

  const usedGroupIds = new Set(groups.keys());
  const autoIdByCoordinate = new Map<string, string>();
  let nextTransferNumber = 1;

  for (const key of transferKeys) {
    let candidate = '';

    do {
      candidate = `XFER_${String(nextTransferNumber).padStart(3, '0')}`;
      nextTransferNumber += 1;
    } while (usedGroupIds.has(candidate));

    usedGroupIds.add(candidate);
    autoIdByCoordinate.set(key, candidate);
  }

  for (const [key, group] of byCoordinate) {
    if (group.length === 1) {
      groups.set(group[0].id, group);
      continue;
    }

    const autoId = autoIdByCoordinate.get(key)!;
    groups.set(autoId, group);
  }

  return groups;
}

export function buildGraph(input: NetworkInput): GraphModel {
  if (!input.stations.length) {
    throw new Error('At least one station is required.');
  }

  const seenStationIds = new Set<string>();
  for (const station of input.stations) {
    if (!station.id) throw new Error('Station id cannot be empty.');
    if (seenStationIds.has(station.id)) {
      throw new Error(`Duplicate station id: ${station.id}.`);
    }
    seenStationIds.add(station.id);

    if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) {
      throw new Error(`Invalid coordinates for station ${station.id}.`);
    }
  }

  const byStation = new Map(
    input.stations.map((station) => [station.id, station]),
  );
  const groups = buildStationGroups(input.stations);

  const stationToNode = new Map<string, string>();
  const nodes: GraphNode[] = [];

  for (const [groupId, stations] of groups) {
    const lat =
      stations.reduce((sum, item) => sum + item.lat, 0) /
      stations.length;
    const lon =
      stations.reduce((sum, item) => sum + item.lon, 0) /
      stations.length;

    const normalizedNames = new Map<string, string>();
    for (const station of stations) {
      const normalized = normalizeStationName(station.name);
      if (normalized && station.name?.trim()) {
        normalizedNames.set(normalized, station.name.trim());
      }
    }

    const name =
      normalizedNames.size === 1
        ? [...normalizedNames.values()][0]
        : stations.find((item) => item.name?.trim())?.name?.trim() ??
          stations.map((item) => item.id).join(' / ');

    nodes.push({
      id: groupId,
      stationIds: stations.map((item) => item.id),
      name,
      lat,
      lon,
    });

    for (const station of stations) {
      stationToNode.set(station.id, groupId);
    }
  }

  const edgeMap = new Map<string, GraphEdge>();
  const graphLines: GraphLine[] = [];
  const seenLineIds = new Set<string>();

  for (const line of input.lines) {
    if (!line.id) throw new Error('Line id cannot be empty.');
    if (seenLineIds.has(line.id)) {
      throw new Error(`Duplicate line id: ${line.id}.`);
    }
    seenLineIds.add(line.id);

    const paths = line.paths.map((path, pathIndex) => {
      const mapped = path.map((stationId) => {
        if (!byStation.has(stationId)) {
          throw new Error(
            `Line ${line.id} references unknown station ${stationId}.`,
          );
        }
        return stationToNode.get(stationId)!;
      });

      const collapsed = mapped.filter(
        (nodeId, index) =>
          index === 0 || nodeId !== mapped[index - 1],
      );

      if (collapsed.length < 2) {
        throw new Error(
          `Line ${line.id} path ${pathIndex + 1} must contain at least two distinct topology nodes.`,
        );
      }

      return collapsed;
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
          if (!existing.lineIds.includes(line.id)) {
            existing.lineIds.push(line.id);
          }
        } else {
          edgeMap.set(key, {
            key,
            a,
            b,
            lineIds: [line.id],
          });
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

  const nodeById = new Map(
    nodes.map((node) => [node.id, node]),
  );
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

export function nodeDegree(
  graph: GraphModel,
  nodeId: string,
): number {
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
        variants.push(
          [
            ...candidate.slice(i),
            ...candidate.slice(0, i),
          ].join('|'),
        );
      }
    }
    return variants.sort()[0];
  };

  for (const start of ids) {
    const visited = new Set<string>([start]);
    const path = [start];

    const dfs = (current: string) => {
      if (
        cycles.size >= maxCycles ||
        path.length > maxLength
      ) {
        return;
      }

      for (
        const next of graph.adjacency.get(current) ?? []
      ) {
        if (next === start && path.length >= 3) {
          const cycle = [...path];
          cycles.set(canonicalize(cycle), cycle);
          if (cycles.size >= maxCycles) return;
          continue;
        }

        if (visited.has(next)) continue;
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
