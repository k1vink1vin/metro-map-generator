import type { GraphModel, Point } from '../types';
import {
  inflateCentralArea,
  regularizeRouteCorridors,
  relaxPathKinksSafely,
  repairIntroducedPathSelfCrossings,
  schematizeOnAngularGrid,
} from './common';

/**
 * Taipei 45° compromise.
 *
 * Geography remains the primary frame: the network is north-up and retains
 * relative district placement. Edges are attracted to the octolinear axis
 * family, then a conservative corner optimizer removes the worst U-turns only
 * when doing so does not introduce crossings or crowd another station.
 */
export function layoutTaipei(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  const snapped = schematizeOnAngularGrid(graph, geographic, {
    angleStep: 45,
    geographyWeight: 0.46,
    equalSpacingWeight: 0.4,
    iterations: 100,
  });

  const corridors = regularizeRouteCorridors(
    graph,
    snapped,
    geographic,
    {
      angleStep: 45,
      passes: 4,
      runBlend: 0.46,
      geographyTether: 0.22,
      equalSpacingWeight: 0.46,
      bendAnchorDegrees: 38,
    },
  );

  const relaxed = relaxPathKinksSafely(graph, corridors, {
    passes: 7,
    thresholdDegrees: 84,
    minimumNodeDistance: 29,
    maxShift: 32,
    structuralMaxShift: 18,
  });

  return repairIntroducedPathSelfCrossings(
    graph,
    relaxed,
    geographic,
    24,
  );
}

/**
 * London 45° topology diagram.
 *
 * Unlike Taipei, the dense centre is deliberately enlarged first. Geography
 * is then a weak reference while the 45° grid and near-equal station spacing
 * dominate. The final conservative corner pass keeps Beck-style topology
 * clean without creating new edge crossings.
 */
export function layoutLondon(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  const schematicReference = inflateCentralArea(geographic, 0.52);
  const snapped = schematizeOnAngularGrid(
    graph,
    schematicReference,
    {
      angleStep: 45,
      geographyWeight: 0.22,
      equalSpacingWeight: 0.68,
      iterations: 135,
    },
  );

  const corridors = regularizeRouteCorridors(
    graph,
    snapped,
    schematicReference,
    {
      angleStep: 45,
      passes: 5,
      runBlend: 0.66,
      geographyTether: 0.07,
      equalSpacingWeight: 0.76,
      bendAnchorDegrees: 58,
    },
  );

  const relaxed = relaxPathKinksSafely(graph, corridors, {
    passes: 9,
    thresholdDegrees: 78,
    minimumNodeDistance: 29,
    maxShift: 38,
    structuralMaxShift: 22,
  });

  return repairIntroducedPathSelfCrossings(
    graph,
    relaxed,
    schematicReference,
    24,
  );
}
