import type { Point } from '../types';
import { expand, touchesRect, type Rect } from './mapLabels';

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function placeLegend(bounds: Rect, width: number, height: number, obstacles: Rect[], routes: Point[][]) {
  const inset = 32;
  // Try the open space to the upper left. The side panel remains available
  // for networks that fill this region or have an especially long legend.
  const availableWidth = bounds.width * 0.4 - width - inset;
  const availableHeight = bounds.height * 0.68 - height - inset;
  for (let dy = 0; dy <= availableHeight; dy += 32) {
    for (let dx = 0; dx <= availableWidth; dx += 32) {
      const panel = { x: bounds.x + inset + dx, y: bounds.y + inset + dy, width, height };
      const clearance = expand(panel, 20);
      if (obstacles.some(obstacle => intersects(clearance, obstacle))) continue;
      if (routes.some(points => points.some((b, index) =>
        index > 0 && touchesRect({ a: points[index - 1], b }, clearance),
      ))) continue;
      return { panel, inside: true };
    }
  }
  return {
    panel: { x: bounds.x + Math.max(bounds.width, 300) + 22, y: bounds.y + inset, width, height },
    inside: false,
  };
}
