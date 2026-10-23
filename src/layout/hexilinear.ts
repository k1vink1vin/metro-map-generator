import type { GraphModel, Point } from '../types';
import {
  regularizeRouteCorridors,
  relaxPathKinksSafely,
  repairIntroducedPathSelfCrossings,
  schematizeOnAngularGrid,
} from './common';

/**
 * Hex / 60° tri-axial grid.
 *
 * Routes are attracted to the three undirected axes 0°/60°/120°. Geography
 * remains a moderate reference so multiple regional loops keep their relative
 * placement. A crossing-safe corner pass suppresses acute zig-zags while
 * preserving the 60° family.
 */
export function layoutHexilinear(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  const snapped = schematizeOnAngularGrid(graph, geographic, {
    angleStep: 60,
    geographyWeight: 0.4,
    equalSpacingWeight: 0.46,
    iterations: 115,
  });

  const corridors = regularizeRouteCorridors(
    graph,
    snapped,
    geographic,
    {
      angleStep: 60,
      passes: 4,
      runBlend: 0.52,
      geographyTether: 0.17,
      equalSpacingWeight: 0.58,
      bendAnchorDegrees: 44,
    },
  );

  const relaxed = relaxPathKinksSafely(graph, corridors, {
    passes: 7,
    thresholdDegrees: 90,
    minimumNodeDistance: 29,
    maxShift: 30,
    structuralMaxShift: 16,
  });

  return repairIntroducedPathSelfCrossings(
    graph,
    relaxed,
    geographic,
    29,
  );
}
