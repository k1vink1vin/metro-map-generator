export type StationVisualStyle = 'taipei' | 'tokyo' | 'osaka' | 'moscow';

export type StyleId =
  | 'geographic'
  | 'taipei'
  | 'london'
  | 'moscow'
  | 'concentric'
  | 'hex';

export interface Station {
  id: string;
  name?: string;
  lat: number;
  lon: number;
  /**
   * Stable transfer-complex / topology key, normally XFER_###.
   *
   * Different station IDs with the same physical coordinates can be
   * auto-grouped when this field is blank. Once assigned, this ID takes
   * precedence over station names so renaming a station does not change
   * transfer topology.
   */
  complexId?: string;
}

export interface TransitLine {
  id: string;
  name?: string;
  color: string;
  /**
   * A line may contain multiple paths. This is how Y-shaped branches are
   * represented without guessing the branch structure.
   */
  paths: string[][];
  /** Optional metadata aligned by path index. */
  pathIds?: string[];
  pathColors?: string[];
}

export interface MoscowRingDefinition {
  id: string;
  stationIds: string[];
}

export interface ValidatedMoscowRing {
  id: string;
  stationIds: string[];
  nodes: string[];
}

export interface NetworkInput {
  stations: Station[];
  lines: TransitLine[];
  moscowRings?: MoscowRingDefinition[];
}

export interface Point {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  stationIds: string[];
  name: string;
  lat: number;
  lon: number;
}

export interface GraphEdge {
  key: string;
  a: string;
  b: string;
  lineIds: string[];
}

export interface GraphLine {
  id: string;
  name: string;
  color: string;
  paths: string[][];
  pathIds?: string[];
  pathColors?: string[];
}

export interface GraphModel {
  nodes: GraphNode[];
  nodeById: Map<string, GraphNode>;
  stationToNode: Map<string, string>;
  edges: GraphEdge[];
  edgeByKey: Map<string, GraphEdge>;
  adjacency: Map<string, string[]>;
  lines: GraphLine[];
}

export interface RingCandidateDiagnostic {
  id: string;
  nodes: string[];
  score: number;
  routeIds: string[];
  transferCount: number;
  outwardConnections: number;
  areaCoverage: number;
  shapeFill: number;
  aspectScore: number;
  radialConsistency: number;
}

export interface LayoutIntegrity {
  routeCount: number;
  pathCount: number;
  segmentCount: number;
  repairedNodeCount: number;
  separatedNodePairs: number;
  valid: boolean;
}

export interface LayoutResult {
  style: StyleId;
  positions: Record<string, Point>;
  geographicPositions: Record<string, Point>;
  primaryRing?: string[];
  primaryRingCandidateId?: string;
  ringCandidates?: RingCandidateDiagnostic[];
  moscowRings?: ValidatedMoscowRing[];
  /** Exact common centre used by the orthoradial / concentric style. */
  radialCenter?: Point;
  integrity: LayoutIntegrity;
}
