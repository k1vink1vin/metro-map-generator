import type { GraphModel, Point } from '../types';

export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 720;
export const CANVAS_PADDING = 86;

export function projectGeographic(
  graph: GraphModel,
  width = CANVAS_WIDTH,
  height = CANVAS_HEIGHT,
  padding = CANVAS_PADDING,
): Record<string, Point> {
  const centerLat =
    graph.nodes.reduce((sum, node) => sum + node.lat, 0) / graph.nodes.length;
  const centerLon =
    graph.nodes.reduce((sum, node) => sum + node.lon, 0) / graph.nodes.length;
  const cosLat = Math.cos((centerLat * Math.PI) / 180);

  const raw = graph.nodes.map((node) => ({
    id: node.id,
    x: (node.lon - centerLon) * cosLat,
    y: -(node.lat - centerLat),
  }));

  let minX = Math.min(...raw.map((point) => point.x));
  let maxX = Math.max(...raw.map((point) => point.x));
  let minY = Math.min(...raw.map((point) => point.y));
  let maxY = Math.max(...raw.map((point) => point.y));

  if (Math.abs(maxX - minX) < 1e-9) {
    minX -= 0.5;
    maxX += 0.5;
  }
  if (Math.abs(maxY - minY) < 1e-9) {
    minY -= 0.5;
    maxY += 0.5;
  }

  const scale = Math.min(
    (width - padding * 2) / (maxX - minX),
    (height - padding * 2) / (maxY - minY),
  );

  const usedWidth = (maxX - minX) * scale;
  const usedHeight = (maxY - minY) * scale;
  const offsetX = (width - usedWidth) / 2;
  const offsetY = (height - usedHeight) / 2;

  return Object.fromEntries(
    raw.map((point) => [
      point.id,
      {
        x: offsetX + (point.x - minX) * scale,
        y: offsetY + (point.y - minY) * scale,
      },
    ]),
  );
}
