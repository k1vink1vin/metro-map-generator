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
      'primaryRing' | 'primaryRingCandidateId' | 'ringCandidates' | 'moscowRings' | 'radialCenter'
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

  // Finalization performs a uniform scale + translation. Carry the exact
  // orthoradial centre through that transform so the renderer can use the
  // same centre for every circular arc and radial segment.
  let radialCenter = extra.radialCenter;
  if (radialCenter && graph.nodes.length >= 2) {
    let first = graph.nodes[0].id;
    let second = graph.nodes[1].id;
    let widest = 0;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const a = proposed[graph.nodes[i].id];
        const b = proposed[graph.nodes[j].id];
        if (!a || !b) continue;
        const span = Math.hypot(b.x - a.x, b.y - a.y);
        if (span > widest) {
          widest = span;
          first = graph.nodes[i].id;
          second = graph.nodes[j].id;
        }
      }
    }
    const beforeA = proposed[first];
    const beforeB = proposed[second];
    const afterA = finalized.positions[first];
    const afterB = finalized.positions[second];
    const beforeSpan = beforeA && beforeB
      ? Math.hypot(beforeB.x - beforeA.x, beforeB.y - beforeA.y)
      : 0;
    const afterSpan = afterA && afterB
      ? Math.hypot(afterB.x - afterA.x, afterB.y - afterA.y)
      : 0;
    if (beforeA && afterA && beforeSpan > 1e-9 && Number.isFinite(afterSpan)) {
      const scale = afterSpan / beforeSpan;
      radialCenter = {
        x: afterA.x + (radialCenter.x - beforeA.x) * scale,
        y: afterA.y + (radialCenter.y - beforeA.y) * scale,
      };
    }
  }

  return {
    style,
    positions: finalized.positions,
    geographicPositions: geographic,
    integrity: finalized.integrity,
    ...extra,
    radialCenter,
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
    // Give independently circularized regional systems room in the global
    // geographic frame instead of allowing enlarged circles to exchange sides.
    const ringFrame = Object.fromEntries(Object.entries(geographic).map(([id,p]) => [id, {x:p.x * 2, y:p.y * 2}]));
    const result = layoutMoscow(
      graph,
      ringFrame,
      options.moscowRings ?? [],
      90,
    );

    return finish(graph, style, geographic, result.positions, {
      moscowRings: result.moscowRings,
      primaryRing: result.moscowRings[0]?.nodes,
    });
  }

  const concentric = layoutConcentric(graph, geographic);
  return finish(
    graph,
    style,
    geographic,
    concentric.positions,
    { radialCenter: concentric.center },
  );
}
