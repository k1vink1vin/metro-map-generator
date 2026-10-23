import type { GraphModel, Point } from '../types';
import { schematizeOnAngularGrid } from './common';

export function layoutTaipei(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  return schematizeOnAngularGrid(graph, geographic, {
    angleStep: 45,
    geographyWeight: 0.42,
    equalSpacingWeight: 0.38,
    iterations: 95,
  });
}

export function layoutLondon(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  return schematizeOnAngularGrid(graph, geographic, {
    angleStep: 45,
    geographyWeight: 0.26,
    equalSpacingWeight: 0.7,
    iterations: 120,
  });
}
