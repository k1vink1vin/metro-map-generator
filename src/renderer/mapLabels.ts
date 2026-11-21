import { nodeDegree } from '../core/graph';
import type { GraphModel, Point } from '../types';
import type { RenderedRoutePath } from './routeGeometry';

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface MarkerSize {
  width: number;
  height: number;
}

export interface LabelPlacement extends Point {
  nodeId: string;
  text: string;
  englishText?: string;
  textAnchor: 'start' | 'middle' | 'end';
  rect: Rect;
  badge?: Point;
  leader?: { from: Point; to: Point };
}

interface Segment {
  a: Point;
  b: Point;
}

export function centeredRect(point: Point, size: MarkerSize): Rect {
  return {
    x: point.x - size.width / 2,
    y: point.y - size.height / 2,
    ...size,
  };
}

export function expand(rect: Rect, margin: number): Rect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

function overlap(a: Rect, b: Rect): number {
  const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, dx) * Math.max(0, dy);
}

function segmentInterval({ a, b }: Segment, rect: Rect): [number, number] | undefined {
  // Clip the parameter interval of the segment against both rectangle axes.
  let low = 0;
  let high = 1;
  for (const [origin, delta, min, max] of [
    [a.x, b.x - a.x, rect.x, rect.x + rect.width],
    [a.y, b.y - a.y, rect.y, rect.y + rect.height],
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < min || origin > max) return undefined;
      continue;
    }
    const enter = (min - origin) / delta;
    const leave = (max - origin) / delta;
    low = Math.max(low, Math.min(enter, leave));
    high = Math.min(high, Math.max(enter, leave));
    if (low > high) return undefined;
  }
  return [low, high];
}

export function touchesRect(segment: Segment, rect: Rect): boolean {
  return segmentInterval(segment, rect) !== undefined;
}

export function visibleLeaderSegments(label: LabelPlacement, others: LabelPlacement[]): Segment[] {
  const leader = label.leader;
  if (!leader) return [];
  const { from: a, to: b } = leader;
  const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const gaps = others.flatMap(other => {
    if (other.nodeId === label.nodeId) return [];
    const interval = segmentInterval({ a, b }, expand(other.rect, 7));
    return interval ? [interval] : [];
  }).sort((first, second) => first[0] - second[0]);
  // Print the guide on either side of any other label it passes. The original
  // endpoints still identify the station and its own callout.
  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of gaps) {
    if (start > cursor) segments.push({ a: at(cursor), b: at(start) });
    cursor = Math.max(cursor, end);
  }
  if (cursor < 1) segments.push({ a: at(cursor), b });
  return segments;
}

function segmentIndex(routes: RenderedRoutePath[], margin: number) {
  const cells = new Map<string, Segment[]>();
  const step = 64;
  function cellKeys(rect: Rect): string[] {
    const keys: string[] = [];
    for (let x = Math.floor(rect.x / step); x <= Math.floor((rect.x + rect.width) / step); x++) {
      for (let y = Math.floor(rect.y / step); y <= Math.floor((rect.y + rect.height) / step); y++) {
        keys.push(`${x},${y}`);
      }
    }
    return keys;
  }
  function bounds({ a, b }: Segment) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }
  for (const path of routes) {
    for (let i = 1; i < path.samples.length; i++) {
      const segment = { a: path.samples[i - 1], b: path.samples[i] };
      for (const key of cellKeys(bounds(segment))) {
        const cell = cells.get(key) ?? [];
        cell.push(segment);
        cells.set(key, cell);
      }
    }
  }
  return {
    touches(rect: Rect) {
      const box = expand(rect, margin);
      return cellKeys(box).some(key => cells.get(key)?.some(segment => touchesRect(segment, box)));
    },
    leaderPenalty(leader: Segment) {
      const candidates = new Set(cellKeys(bounds(leader)).flatMap(key => cells.get(key) ?? []));
      let penalty = 0;
      for (const { a, b } of candidates) {
        const dx = leader.b.x - leader.a.x;
        const dy = leader.b.y - leader.a.y;
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const cross = dx * ey - dy * ex;
        if (Math.abs(cross) < 1e-9) continue;
        const rx = a.x - leader.a.x;
        const ry = a.y - leader.a.y;
        const t = (rx * ey - ry * ex) / cross;
        const u = (rx * dy - ry * dx) / cross;
        if (t > 0.08 && t < 1 && u >= 0 && u < 1) penalty += 24;
      }
      return penalty;
    },
  };
}

export function textWidth(text: string, font: number) {
  return Array.from(text).reduce((width, character) => {
    if (/^[ilI1.,'/() ]$/.test(character)) return width + 0.43 * font;
    if (/^[MW@%]$/.test(character)) return width + 1.03 * font;
    if (/^[\x20-\x7e]$/.test(character)) return width + 0.76 * font;
    return width + 1.03 * font;
  }, 0) + 4;
}

interface Candidate {
  placement: LabelPlacement;
  cost: number;
}

function optionsForLabel(
  nodeId: string,
  text: string,
  englishText: string | undefined,
  point: Point,
  marker: MarkerSize,
  detached: MarkerSize | undefined,
  fontSize: number,
  englishSize: number,
  routeIndex: ReturnType<typeof segmentIndex>,
  obstacles: Rect[],
) {
  const textHeight = fontSize * 1.67 + (englishText ? englishSize * 1.35 : 0);
  const width = Math.max(16, detached?.width ?? 0, textWidth(text, fontSize), englishText ? textWidth(englishText, englishSize) : 0);
  const badgeHeight = detached ? detached.height + 7 : 0;
  const height = textHeight + badgeHeight;
  const options: Candidate[] = [];

  function add(left: number, top: number, anchor: LabelPlacement['textAnchor'], preference: number) {
    const rect = { x: left, y: top, width, height };
    const clearance = expand(rect, 2.5);
    const stationOverlap = obstacles.reduce((area, obstacle) => area + overlap(clearance, obstacle), 0);
    const routeOverlap = routeIndex.touches(clearance);
    const x = anchor === 'start' ? left + 1 : anchor === 'end' ? left + width - 1 : left + width / 2;
    const y = top + badgeHeight + fontSize * 1.27;
    const badge = detached ? {
      x: anchor === 'middle' ? x : anchor === 'start' ? left + detached.width / 2 : left + width - detached.width / 2,
      y: top + detached.height / 2,
    } : undefined;
    const to = {
      x: Math.max(left, Math.min(point.x, left + width)),
      y: Math.max(top, Math.min(point.y, top + height)),
    };
    const dx = to.x - point.x;
    const dy = to.y - point.y;
    const edge = 1 / Math.max(Math.abs(dx) / (marker.width / 2 + 1), Math.abs(dy) / (marker.height / 2 + 1));
    const from = { x: point.x + dx * Math.min(1, edge), y: point.y + dy * Math.min(1, edge) };
    const gap = Math.hypot(to.x - from.x, to.y - from.y);
    const leader = (detached || gap > 12) && gap > 2 ? { from, to } : undefined;
    const leaderCost = leader ? 18 + routeIndex.leaderPenalty({ a: from, b: to }) : 0;
    const cost = stationOverlap * 16000 + (routeOverlap ? 10000000 : 0) + gap * 1.5 + leaderCost + preference;
    options.push({ placement: { nodeId, text, englishText, x, y, textAnchor: anchor, rect, badge, leader }, cost });
  }

  for (const gap of [6, 12, 21, 35, 52, 75, 105, 145, 190, 240, 300]) {
    for (const offset of [0, -0.62, 0.62, -1.2, 1.2]) {
      const top = point.y - height / 2 + offset * height;
      add(point.x + marker.width / 2 + gap, top, 'start', Math.abs(offset) * 5);
      add(point.x - marker.width / 2 - gap - width, top, 'end', Math.abs(offset) * 5 + 1);
    }
    for (const sign of [-1, 1]) {
      const top = sign < 0 ? point.y - marker.height / 2 - gap * 0.75 - height : point.y + marker.height / 2 + gap * 0.75;
      add(point.x + marker.width / 2 + gap * 0.75, top, 'start', 7);
      add(point.x - marker.width / 2 - gap * 0.75 - width, top, 'end', 8);
    }
    for (const offset of [0, -0.33, 0.33]) {
      const left = point.x - width / 2 + offset * width;
      add(left, point.y - marker.height / 2 - gap - height, 'middle', 2 + Math.abs(offset) * 5);
      add(left, point.y + marker.height / 2 + gap, 'middle', 3 + Math.abs(offset) * 5);
    }
  }
  return options.sort((a, b) => a.cost - b.cost);
}

export function buildLabelPlacements(
  graph: GraphModel,
  positions: Record<string, Point>,
  sizes: Map<string, MarkerSize>,
  detached: Set<string>,
  anchorSize: MarkerSize,
  routePaths: RenderedRoutePath[],
  routeMargin: number,
  fontSize: number,
  englishSize: number,
): LabelPlacement[] {
  const routeIndex = segmentIndex(routePaths, routeMargin);
  const markers = graph.nodes.map(node =>
    centeredRect(positions[node.id], detached.has(node.id) ? anchorSize : sizes.get(node.id)!),
  );
  const ordered = [...graph.nodes].sort((a, b) => {
    const priority = (id: string) => Number(detached.has(id)) * 2 + Number(nodeDegree(graph, id) !== 2);
    return priority(b.id) - priority(a.id) || positions[a.id].y - positions[b.id].y;
  });
  const alternatives = ordered.map(node =>
    optionsForLabel(node.id, node.name || node.id, node.nameEn?.trim(), positions[node.id],
      detached.has(node.id) ? anchorSize : sizes.get(node.id)!,
      detached.has(node.id) ? sizes.get(node.id) : undefined,
      fontSize, englishSize, routeIndex, markers),
  );
  const selected: Candidate[] = [];

  function choose(options: Candidate[], index: number) {
    let best = options[0];
    let bestScore = Infinity;
    for (const candidate of options) {
      if (candidate.cost >= bestScore) break;
      const rect = expand(candidate.placement.rect, 2);
      let score = candidate.cost;
      for (let j = 0; j < selected.length; j++) {
        if (j === index) continue;
        const other = selected[j].placement;
        const otherRect = expand(other.rect, 2);
        score += overlap(rect, otherRect) * 750;
        if (candidate.placement.leader && touchesRect({ a: candidate.placement.leader.from, b: candidate.placement.leader.to }, otherRect)) score += 18000;
        if (other.leader && touchesRect({ a: other.leader.from, b: other.leader.to }, rect)) score += 18000;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  for (const options of alternatives) selected.push(choose(options, selected.length));
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let i = selected.length - 1; i >= 0; i--) {
      const best = choose(alternatives[i], i);
      if (best !== selected[i]) {
        selected[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return selected.map(({ placement }) => placement);
}
