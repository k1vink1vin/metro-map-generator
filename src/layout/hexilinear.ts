import type { GraphModel, Point } from '../types';
import {
  relaxPathKinksSafely,
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

  return relaxPathKinksSafely(graph, snapped, {
    passes: 5,
    thresholdDegrees: 102,
    minimumNodeDistance: 29,
    maxShift: 26,
    structuralMaxShift: 14,
  });
}
