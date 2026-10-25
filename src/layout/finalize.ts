import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../core/projection';
import type { GraphModel, LayoutIntegrity, Point, StyleId } from '../types';
import { simplifyPassengerRoutesSafely, eliminateAcuteRouteTurnsSafely, repairGeographicOrderSafely, collapseRouteZigzagsSafely, relaxPathKinksSafely, repairIntroducedPathSelfCrossings, separateNodesSafely } from './common';

function isFinitePoint(point?: Point): point is Point {
  return Boolean(
    point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y),
  );
}

function deterministicFallback(index: number): Point {
  const columns = 8;
  const spacing = 54;
  return {
    x: 100 + (index % columns) * spacing,
    y: 100 + Math.floor(index / columns) * spacing,
  };
}

function ensureEveryNodeHasPosition(
  graph: GraphModel,
  proposed: Record<string, Point>,
  geographic: Record<string, Point>,
): { positions: Record<string, Point>; repairedNodeCount: number } {
  const positions: Record<string, Point> = {};
  let repairedNodeCount = 0;

  graph.nodes.forEach((node, index) => {
    if (isFinitePoint(proposed[node.id])) {
      positions[node.id] = { ...proposed[node.id] };
      return;
    }

    repairedNodeCount += 1;
    positions[node.id] = isFinitePoint(geographic[node.id])
      ? { ...geographic[node.id] }
      : deterministicFallback(index);
  });

  return { positions, repairedNodeCount };
}

/**
 * Prevents distinct topology nodes from collapsing to effectively the same
 * screen location. It only acts on very close pairs and therefore serves as a
 * repair pass, not a primary layout algorithm.
 */
function separateOverlappingNodes(
  graph: GraphModel,
  input: Record<string, Point>,
  minimumDistance = 24,
  iterations = 10,
): { positions: Record<string, Point>; separatedNodePairs: number } {
  const positions = Object.fromEntries(
    Object.entries(input).map(([id, point]) => [id, { ...point }]),
  );
  let separatedNodePairs = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let moved = false;

    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const aId = graph.nodes[i].id;
        const bId = graph.nodes[j].id;
        const a = positions[aId];
        const b = positions[bId];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);

        if (distance >= minimumDistance) continue;

        if (distance < 1e-6) {
          const angle = ((i * 37 + j * 91) % 360) * (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }

        const push = (minimumDistance - distance) / 2;
        const nx = dx / distance;
        const ny = dy / distance;

        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;

        separatedNodePairs += 1;
        moved = true;
      }
    }

    if (!moved) break;
  }

  return { positions, separatedNodePairs };
}

function passengerCanvasScale(
  graph: GraphModel,
  style: StyleId,
): number {
  const nodeFactor = Math.sqrt(graph.nodes.length / 45);
  const edgeFactor = Math.sqrt(graph.edges.length / 55);
  // Dense multi-system maps need more breathing room than the original
  // Taipei-only fixture. Keep the same geometry, but increase the passenger
  // canvas instead of shrinking station labels into unreadability.
  const base = Math.max(1, Math.max(nodeFactor, edgeFactor)) * 1.18;
  const styleMultiplier: Record<StyleId, number> = {
    geographic: 1.05,
    taipei: 2.1,
    london: 1.12,
    moscow: 1.9,
    concentric: 1.08,
    hex: 1.12,
  };
  return Math.min(style === 'moscow' ? 6 : 4.5, base * styleMultiplier[style]);
}

function fitToCanvas(
  graph: GraphModel,
  style: StyleId,
  positions: Record<string, Point>,
  padding = 86,
): Record<string, Point> {
  const entries = Object.entries(positions);
  if (!entries.length) return positions;

  const xs = entries.map(([, point]) => point.x);
  const ys = entries.map(([, point]) => point.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);

  if (Math.abs(maxX - minX) < 1e-9) {
    minX -= 0.5;
    maxX += 0.5;
  }
  if (Math.abs(maxY - minY) < 1e-9) {
    minY -= 0.5;
    maxY += 0.5;
  }

  const sourceWidth = maxX - minX;
  const sourceHeight = maxY - minY;
  const passengerScale = passengerCanvasScale(graph, style);
  const targetWidth = CANVAS_WIDTH * passengerScale;
  const targetHeight = CANVAS_HEIGHT * passengerScale;
  const scaledPadding = padding * Math.max(1, Math.sqrt(passengerScale));

  const availableWidth = targetWidth - scaledPadding * 2;
  const availableHeight = targetHeight - scaledPadding * 2;
  const scale = Math.min(
    availableWidth / sourceWidth,
    availableHeight / sourceHeight,
  );

  const usedWidth = sourceWidth * scale;
  const usedHeight = sourceHeight * scale;
  const offsetX = (targetWidth - usedWidth) / 2;
  const offsetY = (targetHeight - usedHeight) / 2;

  return Object.fromEntries(
    entries.map(([id, point]) => [
      id,
      {
        x: offsetX + (point.x - minX) * scale,
        y: offsetY + (point.y - minY) * scale,
      },
    ]),
  );
}

function validateEveryRouteIsDrawable(
  graph: GraphModel,
  positions: Record<string, Point>,
): Omit<LayoutIntegrity, 'repairedNodeCount' | 'separatedNodePairs'> {
  let pathCount = 0;
  let segmentCount = 0;
  const failures: string[] = [];

  for (const line of graph.lines) {
    if (!line.paths.length) {
      failures.push(`${line.id}: no paths`);
      continue;
    }

    line.paths.forEach((path, pathIndex) => {
      pathCount += 1;

      if (path.length < 2) {
        failures.push(`${line.id} path ${pathIndex + 1}: fewer than 2 nodes`);
        return;
      }

      for (let index = 0; index < path.length; index += 1) {
        const nodeId = path[index];
        if (!isFinitePoint(positions[nodeId])) {
          failures.push(
            `${line.id} path ${pathIndex + 1}: missing position for ${nodeId}`,
          );
        }
      }

      for (let index = 0; index < path.length - 1; index += 1) {
        const a = positions[path[index]];
        const b = positions[path[index + 1]];
        segmentCount += 1;

        if (
          !isFinitePoint(a) ||
          !isFinitePoint(b) ||
          Math.hypot(b.x - a.x, b.y - a.y) < 0.5
        ) {
          failures.push(
            `${line.id} path ${pathIndex + 1}: invisible segment ${index + 1}`,
          );
        }
      }
    });
  }

  if (failures.length) {
    throw new Error(
      `Layout completeness validation failed: ${failures.slice(0, 8).join('; ')}` +
        (failures.length > 8 ? `; +${failures.length - 8} more` : ''),
    );
  }

  return {
    routeCount: graph.lines.length,
    pathCount,
    segmentCount,
    valid: true,
  };
}

export function finalizeLayoutPositions(
  graph: GraphModel,
  style: StyleId,
  proposed: Record<string, Point>,
  geographic: Record<string, Point>,
  fixedNodes: ReadonlySet<string> = new Set(),
): { positions: Record<string, Point>; integrity: LayoutIntegrity } {
  const completed = ensureEveryNodeHasPosition(graph, proposed, geographic);
  // Moscow ring stations are deliberately placed on exact circles. The
  // generic pair-separation repair is not topology-aware and can deform
  // those circles, so Moscow relies on its own ring spacing/deformation pass.
  const topologySensitiveStyle =
    style === 'taipei' ||
    style === 'moscow' ||
    style === 'london' ||
    style === 'hex';
  const separated =
    topologySensitiveStyle
      ? { positions: completed.positions, separatedNodePairs: 0 }
      : separateOverlappingNodes(graph, completed.positions);
  const fitted = fitToCanvas(graph, style, separated.positions);
  // Taipei's section router is solved in schematic coordinates. Do not
  // disturb that geometry before fitting; after fitting, only the genuinely
  // sub-28px pairs need a tiny topology-safe separation.
  const spaced =
    style === 'taipei'
      ? separateNodesSafely(graph, fitted, 29, 6)
      : fitted;
  // Work in final display units: a short saw-tooth is a visual defect even
  // when the pre-fit coordinates made its displacement look insignificant.
  // The corridor pass accepts only moves that preserve route self-crossings,
  // external crossings and spacing. Ring stations remain fixed; shell targets remain soft constraints.
  const simplified = style !== 'geographic'
    ? collapseRouteZigzagsSafely(graph, spaced, {
        fixedNodes,
        angleStep: style === 'hex' ? 60 : style === 'moscow' || style === 'concentric' ? 15 : 45,
        passes: 6,
        minimumTurnDegrees: 20,
        minimumNodeDistance: style === 'taipei' ? 29 : style === 'moscow' ? 36 : 50,
        maxShift: style === 'moscow' ? 120 : 80,
        structuralMaxShift: 20,
      })
    : spaced;
  const relaxed = style === 'london' || style === 'hex'
    ? relaxPathKinksSafely(graph, simplified, { passes: 18, thresholdDegrees: 55,
        minimumNodeDistance: 50, maxShift: 180, structuralMaxShift: 80 }) : simplified;
  const angularPositions = style === 'london' || style === 'hex'
    ? repairIntroducedPathSelfCrossings(graph, relaxed, simplified, 50) : relaxed;
  const positions = style === 'moscow'
    ? repairGeographicOrderSafely(graph, angularPositions, geographic, fixedNodes)
    : style === 'london' || style === 'hex'
      ? simplifyPassengerRoutesSafely(graph, eliminateAcuteRouteTurnsSafely(graph, angularPositions), style === 'hex' ? 60 : 45) : angularPositions;
  const validated = validateEveryRouteIsDrawable(graph, positions);

  return {
    positions,
    integrity: {
      ...validated,
      repairedNodeCount: completed.repairedNodeCount,
      separatedNodePairs: separated.separatedNodePairs,
    },
  };
}
