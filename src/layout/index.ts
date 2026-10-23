import { projectGeographic } from '../core/projection';
import type { GraphModel, LayoutResult, StyleId } from '../types';
import { layoutHexilinear } from './hexilinear';
import { layoutLondon, layoutTaipei } from './octilinear';
import { layoutConcentric, layoutMoscow } from './radial';

export function computeLayout(graph: GraphModel, style: StyleId): LayoutResult {
  const geographic = projectGeographic(graph);

  if (style === 'geographic') {
    return {
      style,
      positions: geographic,
      geographicPositions: geographic,
    };
  }

  if (style === 'taipei') {
    return {
      style,
      positions: layoutTaipei(graph, geographic),
      geographicPositions: geographic,
    };
  }

  if (style === 'london') {
    return {
      style,
      positions: layoutLondon(graph, geographic),
      geographicPositions: geographic,
    };
  }

  if (style === 'hex') {
    return {
      style,
      positions: layoutHexilinear(graph, geographic),
      geographicPositions: geographic,
    };
  }

  if (style === 'moscow') {
    const result = layoutMoscow(graph, geographic);
    return {
      style,
      positions: result.positions,
      geographicPositions: geographic,
      primaryRing: result.primaryRing,
      ringCandidates: result.ringCandidates,
    };
  }

  return {
    style,
    positions: layoutConcentric(graph, geographic),
    geographicPositions: geographic,
  };
}
