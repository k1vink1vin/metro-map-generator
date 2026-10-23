import type { GraphModel, Point } from '../types';
import {
  regularizeRouteCorridors,
  relaxPathKinks,
  schematizeOnAngularGrid,
} from './common';

/**
 * Hex / tri-axial style.
 *
 * The first phase attracts edges to the 0°/60°/120° axis family. The second
 * phase works on whole station runs between structural nodes, eliminating the
 * short alternating zig-zags that occur when every segment is snapped
 * independently.
 */
export function layoutHexilinear(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  const snapped = schematizeOnAngularGrid(graph, geographic, {
    angleStep: 60,
    geographyWeight: 0.38,
    equalSpacingWeight: 0.5,
    iterations: 115,
  });

  const corridors = regularizeRouteCorridors(
    graph,
    snapped,
    geographic,
    {
      angleStep: 60,
      passes: 7,
      runBlend: 0.82,
      geographyTether: 0.12,
      equalSpacingWeight: 0.62,
    },
  );

  return relaxPathKinks(graph, corridors, geographic, {
    passes: 7,
    ordinaryBlend: 0.54,
    structuralBlend: 0.14,
    geographyTether: 0.1,
    maxShift: 20,
    thresholdDegrees: 82,
  });
}
