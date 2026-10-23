import type { GraphModel, Point } from '../types';
import {
  inflateCentralArea,
  relaxPathKinksSafely,
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

  return relaxPathKinksSafely(graph, snapped, {
    passes: 5,
    thresholdDegrees: 96,
    minimumNodeDistance: 29,
    maxShift: 28,
    structuralMaxShift: 15,
  });
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

  return relaxPathKinksSafely(graph, snapped, {
    passes: 7,
    thresholdDegrees: 90,
    minimumNodeDistance: 29,
    maxShift: 34,
    structuralMaxShift: 20,
  });
}
