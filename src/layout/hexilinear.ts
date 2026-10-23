import type { GraphModel, Point } from '../types';
import { schematizeOnAngularGrid } from './common';

export function layoutHexilinear(
  graph: GraphModel,
  geographic: Record<string, Point>,
): Record<string, Point> {
  return schematizeOnAngularGrid(graph, geographic, {
    angleStep: 60,
    geographyWeight: 0.24,
    equalSpacingWeight: 0.56,
    iterations: 110,
  });
}
