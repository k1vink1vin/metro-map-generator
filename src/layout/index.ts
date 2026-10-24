import { projectGeographic } from '../core/projection';
import type { GraphModel, LayoutResult, StyleId, ValidatedMoscowRing } from '../types';
import { finalizeLayoutPositions } from './finalize';
import { layoutHexilinear } from './hexilinear';
import { layoutLondon, layoutTaipei } from './octilinear';
import { layoutConcentric, layoutMoscow } from './radial';

export interface LayoutOptions {
  moscowRings?: ValidatedMoscowRing[];
}

function finish(
  graph: GraphModel,
  style: StyleId,
  geographic: LayoutResult['geographicPositions'],
  proposed: LayoutResult['positions'],
  extra: Partial<
    Pick<
      LayoutResult,
      'primaryRing' | 'primaryRingCandidateId' | 'ringCandidates' | 'moscowRings'
    >
  > = {},
): LayoutResult {
  const finalized = finalizeLayoutPositions(
    graph,
    style,
    proposed,
    geographic,
    new Set(extra.moscowRings?.flatMap(ring => ring.nodes) ?? []),
  );

  return {
    style,
    positions: finalized.positions,
    geographicPositions: geographic,
    integrity: finalized.integrity,
    ...extra,
  };
}

export function computeLayout(
  graph: GraphModel,
  style: StyleId,
  options: LayoutOptions = {},
): LayoutResult {
  const geographic = projectGeographic(graph);

  if (style === 'geographic') {
    return finish(graph, style, geographic, geographic);
  }

  if (style === 'taipei') {
    return finish(
      graph,
      style,
      geographic,
      layoutTaipei(graph, geographic),
    );
  }

  if (style === 'london') {
    return finish(
      graph,
      style,
      geographic,
      layoutLondon(graph, geographic),
    );
  }

  if (style === 'hex') {
    return finish(
      graph,
      style,
      geographic,
      layoutHexilinear(graph, geographic),
    );
  }

  if (style === 'moscow') {
    const result = layoutMoscow(
      graph,
      geographic,
      options.moscowRings ?? [],
    );

    return finish(graph, style, geographic, result.positions, {
      moscowRings: result.moscowRings,
      primaryRing: result.moscowRings[0]?.nodes,
    });
  }

  return finish(
    graph,
    style,
    geographic,
    layoutConcentric(graph, geographic),
  );
}
