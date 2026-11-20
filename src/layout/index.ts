import { projectGeographic } from '../core/projection';
import type { GraphModel, LayoutResult, StyleId, ValidatedMoscowRing } from '../types';
import { finalizeLayoutPositions } from './finalize';
import { layoutHexilinear } from './hexilinear';
import { layoutLondon, layoutTaipei } from './octilinear';
import { layoutConcentric, layoutMoscow } from './radial';
import { equalizeRenderedStationRhythm } from './renderEquidistance';
import { refinePassengerClearance } from './passengerClearance';
import { refineMoscowPassengerMap } from './moscowOptimization';

export interface LayoutOptions {
  moscowRings?: ValidatedMoscowRing[];
  /** Optional graph-node or station ID that must sit at the concentric origin. */
  concentricCenterNodeId?: string;
}

function scalePositions(layout: LayoutResult, factor: number, origin: { x: number; y: number }): LayoutResult {
  if (factor === 1) return layout;
  const scale = (point: { x: number; y: number }) => ({
    x: origin.x + (point.x - origin.x) * factor,
    y: origin.y + (point.y - origin.y) * factor,
  });
  return {
    ...layout,
    positions: Object.fromEntries(Object.entries(layout.positions).map(([id, point]) => [id, scale(point)])),
    radialCenter: layout.radialCenter && scale(layout.radialCenter),
  };
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

  const result: LayoutResult = {
    style,
    positions: finalized.positions,
    geographicPositions: geographic,
    integrity: finalized.integrity,
    ...extra,
    radialCenter,
  };

  // Concentric equal spacing is solved natively in polar geometry and in the
  // orthoradial beam objective. Avoid repeatedly rendering the whole network
  // just to rediscover the same legal arc/radial corridor.
  if (style === 'concentric') return result;

  let rhythm = result;
  // A single exact rendered-rhythm pass suffices after the constrained
  // Moscow optimizer (measured CV 0.79%, no U-turns/self-crossings).
  // Repeating it runs the full route search three unnecessary times.
  for (let pass = 0; pass < (style === 'moscow' ? 1 : 4); pass += 1) {
    const next = equalizeRenderedStationRhythm(graph, rhythm);
    if (next === rhythm) break;
    rhythm = next;
  }
  if (style === 'taipei' || style === 'hex') {
    const clearer = refinePassengerClearance(graph, rhythm);
    // Reserve space for full station badges in the dense regional network.
    // Uniform enlargement preserves direction, topology and interval ratios.
    const growth = (style === 'taipei' ? 0.24 : 0.35) * Math.min(1, graph.nodes.length / 240);
    return scalePositions(clearer, 1 + growth, { x: 86, y: 86 });
  }
  if (style === 'moscow') return refineMoscowPassengerMap(graph, rhythm);
  if (style === 'london') {
    // Preserve equal station rhythm and 45-degree geometry. A local pairwise
    // repulsion here disturbs corridor spacing and failed the design audit.
    // A uniform display-scale adjustment preserves those invariants.
    let minDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < graph.nodes.length; i++) {
      for (let j = i + 1; j < graph.nodes.length; j++) {
        const a = rhythm.positions[graph.nodes[i].id];
        const b = rhythm.positions[graph.nodes[j].id];
        minDistance = Math.min(minDistance, Math.hypot(b.x - a.x, b.y - a.y));
      }
    }
    if (minDistance > 0 && minDistance < 30) {
      const factor = Math.min(4, 30.5 / minDistance);
      const points = Object.values(rhythm.positions);
      const center = {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
      };
      return scalePositions(rhythm, factor, center);
    }
  }
  return rhythm;
}

export function computeLayout(
  graph: GraphModel,
  style: StyleId,
  options: LayoutOptions = {},
): LayoutResult {
  const geographic = projectGeographic(graph);

  if (style === 'geographic') {
    const result = finish(graph, style, geographic, geographic);
    // Uniform enlargement preserves the projected distances and north-up bearings.
    const scale = Math.min(6, Math.max(1, Math.sqrt(graph.nodes.length / 8)));
    return scalePositions(result, scale, { x: 86, y: 86 });
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

  const concentric = layoutConcentric(
    graph,
    geographic,
    options.concentricCenterNodeId,
  );
  return finish(
    graph,
    style,
    geographic,
    concentric.positions,
    { radialCenter: concentric.center },
  );
}
