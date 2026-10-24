import type { GraphModel, Point } from '../types';
import { layoutTaipei } from './octilinear';
import {
  collapseRouteZigzagsSafely,
  regularizeRouteCorridors,
  routeTopologySectionsSafely,
  relaxPathKinksSafely,
  repairIntroducedPathSelfCrossings,
  separateNodesSafely,
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

  const topologyReference = layoutTaipei(graph, geographic);
  const topologySafeCorridors = repairIntroducedPathSelfCrossings(
    graph,
    corridors,
    topologyReference,
    24,
  );

  const dezigzagged = collapseRouteZigzagsSafely(graph, topologySafeCorridors, {
    angleStep: 60,
    passes: 5,
    minimumTurnDegrees: 24,
    minimumNodeDistance: 29,
    maxShift: 28,
    structuralMaxShift: 12,
  });

  const relaxed = relaxPathKinksSafely(graph, dezigzagged, {
    passes: 7,
    thresholdDegrees: 90,
    minimumNodeDistance: 29,
    maxShift: 30,
    structuralMaxShift: 16,
  });

  const untangled = repairIntroducedPathSelfCrossings(
    graph,
    relaxed,
    topologyReference,
    24,
  );
  const sectionRouted = routeTopologySectionsSafely(graph, topologyReference, untangled, geographic, {
    angleStep: 60, passes: 8, equalSpacingWeight: 0.8,
    minimumNodeDistance: 29, maximumShift: 110, minimumTurnDegrees: 20,
    maxShapeAnchors: 2, shapeTolerance: 24,
  });
  return separateNodesSafely(graph, sectionRouted, 24, 18);
}
