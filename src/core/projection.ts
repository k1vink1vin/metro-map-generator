import type { GraphModel, Point } from '../types';

export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 720;
export const CANVAS_PADDING = 86;
export const KILOMETRES_PER_LATITUDE_DEGREE = 111.195;

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

export function geographicScaleBar(graph: GraphModel, positions: Record<string, Point>, maxWidth: number) {
  if (graph.nodes.length < 2 || maxWidth <= 0) return undefined;
  const latitudeOrder = [...graph.nodes].sort((a, b) => a.lat - b.lat);
  const south = latitudeOrder[0];
  const north = latitudeOrder[latitudeOrder.length - 1];
  let spanKm = (north.lat - south.lat) * KILOMETRES_PER_LATITUDE_DEGREE;
  let spanUnits = Math.abs(positions[north.id].y - positions[south.id].y);

  if (spanKm < 1e-8) {
    const longitudeOrder = [...graph.nodes].sort((a, b) => a.lon - b.lon);
    const west = longitudeOrder[0];
    const east = longitudeOrder[longitudeOrder.length - 1];
    spanKm = (east.lon - west.lon) * KILOMETRES_PER_LATITUDE_DEGREE * Math.cos(north.lat * Math.PI / 180);
    spanUnits = Math.abs(positions[east.id].x - positions[west.id].x);
  }
  if (spanKm < 1e-8 || spanUnits < 1e-8) return undefined;

  const maxKm = maxWidth * spanKm / spanUnits;
  const decade = 10 ** Math.floor(Math.log10(maxKm));
  const kilometres = [5, 2, 1].map(step => step * decade).find(step => step <= maxKm);
  if (!kilometres) return undefined;
  return { kilometres, width: kilometres * spanUnits / spanKm };
}
