import type { GraphModel, Point } from '../types';
import {
  inflateCentralArea,
  regularizeRouteCorridors,
  relaxPathKinks,
  schematizeOnAngularGrid,
} from './common';

/**
 * Taipei style: octolinear, but geographically anchored.
 *
 * 1. Keep the projected north-up geography as the strong reference.
 * 2. Snap route directions to the 45° family.
 * 3. Rebuild ordinary degree-2 station runs as one/two-axis corridors so
 *    the result does not inherit edge-by-edge saw-tooth kinks.
 * 4. Keep interchange / branch nodes as structural anchors.
 */
export function layoutTaipei(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  const snapped = schematizeOnAngularGrid(graph, geographic, {
    angleStep: 45,
    geographyWeight: 0.52,
    equalSpacingWeight: 0.34,
    iterations: 90,
  });

  const corridors = regularizeRouteCorridors(
    graph,
    snapped,
    geographic,
    {
      angleStep: 45,
      passes: 6,
      runBlend: 0.72,
      geographyTether: 0.18,
      equalSpacingWeight: 0.48,
    },
  );

  return relaxPathKinks(graph, corridors, geographic, {
    passes: 7,
    ordinaryBlend: 0.56,
    structuralBlend: 0.16,
    geographyTether: 0.12,
    maxShift: 20,
    thresholdDegrees: 78,
  });
}

/**
 * London style: topology first.
 *
 * Beck's diagram deliberately enlarged the dense centre and used only
 * horizontal, vertical and 45° axes. Here the geographic projection is first
 * centrally inflated, then only lightly tethered while ordinary route runs
 * are aggressively regularized into clean octolinear corridors.
 */
export function layoutLondon(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  const schematicReference = inflateCentralArea(geographic, 0.5);

  const snapped = schematizeOnAngularGrid(
    graph,
    schematicReference,
    {
      angleStep: 45,
      geographyWeight: 0.2,
      equalSpacingWeight: 0.72,
      iterations: 135,
    },
  );

  const corridors = regularizeRouteCorridors(
    graph,
    snapped,
    schematicReference,
    {
      angleStep: 45,
      passes: 8,
      runBlend: 0.9,
      geographyTether: 0.04,
      equalSpacingWeight: 0.84,
    },
  );

  return relaxPathKinks(
    graph,
    corridors,
    schematicReference,
    {
      passes: 9,
      ordinaryBlend: 0.62,
      structuralBlend: 0.22,
      geographyTether: 0.025,
      maxShift: 24,
      thresholdDegrees: 72,
    },
  );
}
