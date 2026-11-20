import { buildRenderedRoutePaths, circleThroughStations, type RenderedRoutePath } from './routeGeometry';
import type {
  GraphModel,
  GraphNode,
  LayoutResult,
  Point,
  StationVisualStyle,
} from '../types';
import { buildLabelPlacements, type LabelPlacement, type MarkerSize } from './mapLabels';
import { mapStyles } from './mapStyles';
import { disjointGapGroups, routeCrossingGaps } from './crossingGaps';
import { routeCorridorBands } from './routeCorridors';


function relativeLuminance(color: string): number | undefined {
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(color.trim());
  if (!match) return undefined;
  const hex = match[1].length === 3 ? Array.from(match[1], channel => channel.repeat(2)).join('') : match[1];
  const rgb = [0, 2, 4].map(index => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function needsDarkRouteCasing(color: string): boolean {
  return 1.05 / ((relativeLuminance(color) ?? 0) + 0.05) < 3;
}

function badgeTextColor(color: string) {
  return (relativeLuminance(color) ?? 0) > 0.179 ? '#000' : '#fff';
}

interface SvgMapProps {
  graph: GraphModel;
  layout: LayoutResult;
  zoom?: number;
  stationStyle?: StationVisualStyle;
  sourceName?: string;
  focusedNodeId?: string;
  onStationSelect?: (nodeId: string) => void;
}

function parseStationCode(stationId: string) {
  const normalized = stationId.trim().toUpperCase();
  const match = normalized.match(/^([A-Z]+)[-_ ]?(\d+)([A-Z]?)$/);
  if (!match) {
    return { prefix: normalized, number: '', suffix: '' };
  }
  return {
    prefix: match[1],
    number: match[2],
    suffix: match[3] ?? '',
  };
}

function stationBadgeWidth(
  baseWidth: number,
  stationId: string,
  visualScale: number,
): number {
  const { suffix } = parseStationCode(stationId);
  const { prefix, number } = parseStationCode(stationId);
  return Math.max(baseWidth + (suffix ? 5 : 0), prefix.length * 5.6 + 7, number.length * 6 + (suffix ? 11 : 6)) * visualScale;
}

function osakaBadgeWidth(
  stationId: string,
  visualScale: number,
): number {
  const code = parseStationCode(stationId);
  const compact = `${code.prefix}${code.number}${code.suffix}`;
  return Math.max(31, 13 + compact.length * 6.3) * visualScale;
}

function nodeLineColors(graph: GraphModel, nodeId: string): string[] {
  const colors: string[] = [];
  for (const line of graph.lines) {
    line.paths.forEach((path, pathIndex) => {
      if (!path.includes(nodeId)) return;
      const color = line.pathColors?.[pathIndex] ?? line.color;
      if (!colors.includes(color)) colors.push(color);
    });
  }
  return colors.length ? colors : ['#111827'];
}

function isInterchangeNode(
  graph: GraphModel,
  node: GraphNode,
): boolean {
  if (node.stationIds.length > 1) return true;

  const incidentLineIds = new Set<string>();
  for (const line of graph.lines) {
    if (line.paths.some((path) => path.includes(node.id))) {
      incidentLineIds.add(line.id);
    }
  }

  return incidentLineIds.size > 1;
}

function stationCodeColor(
  graph: GraphModel,
  nodeId: string,
  stationId: string,
): string {
  for (const line of graph.lines) {
    const index = line.stationPaths.findIndex(path => path.includes(stationId));
    if (index !== -1) return line.pathColors?.[index] ?? line.color;
  }
  return nodeLineColors(graph, nodeId)[0];
}

function markerSize(
  graph: GraphModel,
  node: GraphNode,
  style: StationVisualStyle,
  scale: number,
): MarkerSize {
  const ids = node.stationIds.length ? node.stationIds : [node.id];
  const interchange = isInterchangeNode(graph, node);
  let width: number;
  let height: number;
  if (style === 'moscow') {
    width = interchange ? moscowOuterRadius(graph, node) * 2 + 4 : 14;
    height = width;
  } else if (style === 'osaka') {
    width = Math.max(...ids.map(id => osakaBadgeWidth(id, 1))) + (interchange ? 8 : 2);
    height = ids.length * 20 - 2 + (interchange ? 8 : 2);
  } else {
    const base = style === 'tokyo' ? 22 : 17;
    width = ids.reduce((sum, id) => sum + stationBadgeWidth(base, id, 1), 0) + (ids.length - 1) * 2;
    width += interchange ? (style === 'tokyo' ? 7 : 11) : 3;
    height = style === 'tokyo' ? (interchange ? 38 : 34) : (interchange ? 36 : 28);
  }
  return { width: width * scale, height: height * scale };
}

const detachedAnchorSize = { width: 4.75, height: 4.75 };

function detachedMarkers(graph: GraphModel, layout: LayoutResult, sizes: Map<string, MarkerSize>) {
  const detached = new Set<string>();
  const entries = graph.nodes.map(node => ({
    node, point: layout.positions[node.id], size: sizes.get(node.id)!,
  }));
  // Detach the wider badge first. Keep exact route anchors and take the new
  // smaller mark into account before considering the next pair.
  entries.sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height);
  const overlaps = (a: typeof entries[number], b: typeof entries[number], aSize: MarkerSize) => {
    const bSize = detached.has(b.node.id) ? detachedAnchorSize : b.size;
    return Math.abs(a.point.x - b.point.x) < (aSize.width + bSize.width) / 2 + 1
      && Math.abs(a.point.y - b.point.y) < (aSize.height + bSize.height) / 2 + 1;
  };
  for (const entry of entries) {
    if (entries.some(other => other !== entry && overlaps(entry, other, entry.size))) {
      detached.add(entry.node.id);
    }
  }
  return detached;
}

function renderTokyoStation(
  graph: GraphModel,
  node: GraphNode,
  visualScale: number,
) {
  const ids = node.stationIds.length ? node.stationIds : [node.id];
  const height = 31 * visualScale;
  const gap = 2 * visualScale;
  const widths = ids.map((stationId) =>
    stationBadgeWidth(22, stationId, visualScale),
  );
  const totalWidth =
    widths.reduce((sum, width) => sum + width, 0) +
    (ids.length - 1) * gap;
  const startX = -totalWidth / 2;

  return (
    <g className="station-style-tokyo">
      {isInterchangeNode(graph, node) ? (
        <rect x={startX - 2.5 * visualScale} y={-height / 2 - 2.5 * visualScale}
          width={totalWidth + 5 * visualScale} height={height + 5 * visualScale}
          rx={7 * visualScale} className="tokyo-transfer-shell" strokeWidth={1.6 * visualScale} />
      ) : null}
      {ids.map((stationId, index) => {
        const color = stationCodeColor(graph, node.id, stationId);
        const code = parseStationCode(stationId);
        const width = widths[index];
        const x =
          startX +
          widths.slice(0, index).reduce((sum, value) => sum + value, 0) +
          index * gap;

        return (
          <g
            key={stationId}
            data-station-code={stationId.trim().toUpperCase()}
          >
            <rect
              x={x}
              y={-height / 2}
              width={width}
              height={height}
              rx={5.5 * visualScale}
              className="tokyo-badge-shell"
              style={{ strokeWidth: 1.9 * visualScale }}
            />
            <rect
              x={x + 2.5 * visualScale}
              y={-height / 2 + 2.5 * visualScale}
              width={width - 5 * visualScale}
              height={height - 5 * visualScale}
              rx={3.8 * visualScale}
              className="tokyo-badge-inner"
              style={{
                stroke: color,
                strokeWidth: 2.5 * visualScale,
              }}
            />
            <text
              x={x + width / 2}
              y={-2.5 * visualScale}
              textAnchor="middle"
              className="station-code-prefix"
              style={{ fontSize: 7.2 * visualScale }}
            >
              {code.prefix}
            </text>
            <text
              x={x + width / 2}
              y={8.8 * visualScale}
              textAnchor="middle"
              className="station-code-number"
              style={{ fontSize: (code.suffix ? 8.4 : 9.8) * visualScale }}
            >
              {`${code.number}${code.suffix}`}
            </text>

          </g>
        );
      })}
    </g>
  );
}

function renderTaipeiStation(
  graph: GraphModel,
  node: GraphNode,
  visualScale: number,
) {
  const ids = node.stationIds.length ? node.stationIds : [node.id];
  const badgeHeight = 25 * visualScale;
  const gap = 2 * visualScale;
  const widths = ids.map((stationId) =>
    stationBadgeWidth(17, stationId, visualScale),
  );
  const totalWidth =
    widths.reduce((sum, width) => sum + width, 0) +
    (ids.length - 1) * gap;
  const startX = -totalWidth / 2;
  const isInterchange = isInterchangeNode(graph, node);

  return (
    <g className="station-style-taipei">
      {isInterchange ? (
        <rect
          x={startX - 4 * visualScale}
          y={-badgeHeight / 2 - 4 * visualScale}
          width={totalWidth + 8 * visualScale}
          height={badgeHeight + 8 * visualScale}
          rx={7 * visualScale}
          className="taipei-transfer-shell"
          style={{ strokeWidth: 2.2 * visualScale }}
        />
      ) : null}
      {ids.map((stationId, index) => {
        const color = stationCodeColor(graph, node.id, stationId);
        const code = parseStationCode(stationId);
        const badgeWidth = widths[index];
        const x =
          startX +
          widths.slice(0, index).reduce((sum, value) => sum + value, 0) +
          index * gap;
        const lowerCode = `${code.number}${code.suffix}`;

        return (
          <g key={stationId}>
            <rect
              x={x}
              y={-badgeHeight / 2}
              width={badgeWidth}
              height={badgeHeight}
              rx={4 * visualScale}
              className="taipei-code-badge"
              data-station-code={`${code.prefix}${lowerCode}`}
              data-suffixed={code.suffix ? 'true' : 'false'}
              style={{
                fill: '#ffffff',
                stroke: color,
                strokeWidth: 2.2 * visualScale,
              }}
            />
            <text
              x={x + badgeWidth / 2}
              y={-2.7 * visualScale}
              textAnchor="middle"
              className="station-code-prefix"
              style={{ fontSize: 6.5 * visualScale }}
            >
              {code.prefix}
            </text>
            <text
              x={x + badgeWidth / 2}
              y={8.2 * visualScale}
              textAnchor="middle"
              className="station-code-number taipei-station-code-number"
              data-station-code={`${code.prefix}${lowerCode}`}
              style={{
                fontSize:
                  (code.suffix ? 6.9 : 7.9) * visualScale,
                letterSpacing: code.suffix ? -0.45 * visualScale : 0,
              }}
            >
              {lowerCode}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function renderOsakaStation(
  graph: GraphModel,
  node: GraphNode,
  visualScale: number,
) {
  const ids = node.stationIds.length ? node.stationIds : [node.id];
  const badgeHeight = 18 * visualScale;
  const gap = 2 * visualScale;
  const widths = ids.map((stationId) =>
    osakaBadgeWidth(stationId, visualScale),
  );
  const maxWidth = Math.max(...widths);
  const totalHeight =
    ids.length * badgeHeight + Math.max(0, ids.length - 1) * gap;
  const startY = -totalHeight / 2;
  const isInterchange = isInterchangeNode(graph, node);

  return (
    <g className="station-style-osaka">
      {isInterchange ? (
        <rect
          x={-maxWidth / 2 - 3 * visualScale}
          y={startY - 3 * visualScale}
          width={maxWidth + 6 * visualScale}
          height={totalHeight + 6 * visualScale}
          rx={2.2 * visualScale}
          className="osaka-transfer-shell"
          style={{ strokeWidth: 1.6 * visualScale }}
        />
      ) : null}
      {ids.map((stationId, index) => {
        const color = stationCodeColor(graph, node.id, stationId);
        const code = parseStationCode(stationId);
        const compactCode = `${code.prefix}${code.number}${code.suffix}`;
        const width = widths[index];
        const x = -width / 2;
        const y = startY + index * (badgeHeight + gap);

        return (
          <g key={stationId}>
            <rect
              x={x}
              y={y}
              width={width}
              height={badgeHeight}
              rx={1.2 * visualScale}
              className="osaka-code-badge"
              style={{
                fill: color,
                strokeWidth: 1.2 * visualScale,
              }}
            />
            <text
              x={0}
              y={y + 12.4 * visualScale}
              textAnchor="middle"
              className="osaka-code-text"
              data-station-code={compactCode}
              style={{
                fontSize:
                  (compactCode.length >= 4 ? 9 : 10.2) * visualScale,
                fill: badgeTextColor(color),
              }}
            >
              {compactCode}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function moscowOuterRadius(graph: GraphModel, node: GraphNode) {
  return Math.max(10.5, 4.5 + (nodeLineColors(graph, node.id).length - 1) * 3.2);
}

function renderMoscowStation(graph: GraphModel, node: GraphNode, visualScale: number) {
  const colors = nodeLineColors(graph, node.id);
  if (!isInterchangeNode(graph, node)) {
    return (
      <g className="station-style-moscow">
        {needsDarkRouteCasing(colors[0]) ? <circle r={5.6 * visualScale}
          className="moscow-station" stroke="#334155" strokeWidth={3.2 * visualScale} /> : null}
        <circle r={5.3 * visualScale} className="moscow-station" stroke={colors[0]} strokeWidth={2.4 * visualScale} />
      </g>
    );
  }

  const outer = moscowOuterRadius(graph, node);
  return (
    <g className="station-style-moscow">
      <circle r={(outer + 1.5) * visualScale} className="moscow-transfer-base" strokeWidth={1.6 * visualScale} />
      {colors.map((color, index) => (
        <circle key={color} r={(outer - index * 3.2) * visualScale}
          className="moscow-transfer-ring" stroke={color} strokeWidth={2.3 * visualScale} />
      ))}
    </g>
  );
}

function renderMarker(graph: GraphModel, node: GraphNode, style: StationVisualStyle, scale: number) {
  if (style === 'tokyo') return renderTokyoStation(graph, node, scale);
  if (style === 'osaka') return renderOsakaStation(graph, node, scale);
  if (style === 'moscow') return renderMoscowStation(graph, node, scale);
  return renderTaipeiStation(graph, node, scale);
}

interface TaipeiRiverLandmark {
  d: string;
  label: Point;
}

function buildTaipeiRiverLandmark(
  graph: GraphModel,
  layout: LayoutResult,
): TaipeiRiverLandmark | undefined {
  // Only draw the landmark for an actual Taipei network. It is intentionally
  // schematic: the route map uses the river as an orientation cue, not as a
  // surveyed geographic feature.
  const findNode = (...aliases: string[]) =>
    graph.nodes.find((node) =>
      aliases.some((alias) =>
        node.name.toLowerCase().includes(alias.toLowerCase()),
      ),
    );

  const tamsui = graph.nodes.find(node => node.stationIds.includes('R28')) ?? findNode('淡水', 'Tamsui');
  const hongshulin = findNode('紅樹林', 'Hongshulin');
  const zhuwei = findNode('竹圍', 'Zhuwei');
  const guandu = findNode('關渡', 'Guandu');
  const taipeiMain = findNode('台北車站', '臺北車站', 'Taipei Main');
  if (!tamsui || !guandu || !taipeiMain) return undefined;

  const anchors = [tamsui, hongshulin, zhuwei, guandu]
    .filter((node): node is GraphNode => Boolean(node))
    .map((node) => layout.positions[node.id])
    .filter(Boolean);
  if (anchors.length < 2) return undefined;

  const north = anchors.map((point, index) => ({
    x: point.x - 48 - index * 4,
    y: point.y - (index === 0 ? 24 : 0),
  }));
  const last = north[north.length - 1];
  const main = layout.positions[taipeiMain.id];

  // After Guandu the Tamsui River turns south along the western side of
  // central Taipei. Keep that bend broad so it reads as a landmark rather
  // than another transit line.
  const south1 = {
    x: last.x - 72,
    y: last.y + Math.max(90, (main.y - last.y) * 0.38),
  };
  const south2 = {
    x: main.x - 150,
    y: main.y + 95,
  };
  const end = {
    x: main.x - 120,
    y: main.y + 230,
  };

  const commands = [`M ${north[0].x} ${north[0].y}`];
  for (let index = 1; index < north.length; index += 1) {
    const previous = north[index - 1];
    const point = north[index];
    const midY = (previous.y + point.y) / 2;
    commands.push(
      `C ${previous.x} ${midY} ${point.x} ${midY} ${point.x} ${point.y}`,
    );
  }
  commands.push(
    `C ${last.x - 30} ${last.y + 55} ${south1.x} ${south1.y - 30} ${south1.x} ${south1.y}`,
    `C ${south1.x} ${main.y - 20} ${south2.x} ${main.y + 25} ${south2.x} ${south2.y}`,
    `C ${south2.x} ${south2.y + 45} ${end.x} ${end.y - 45} ${end.x} ${end.y}`,
  );

  return {
    d: commands.join(' '),
    label: {
      x: south1.x - 8,
      y: south1.y + 28,
    },
  };
}

function renderBounds(
  graph: GraphModel,
  layout: LayoutResult,
  routePaths: RenderedRoutePath[],
  labels: LabelPlacement[],
) {
  const points: Point[] = [
    ...graph.nodes.map((node) => layout.positions[node.id]),
    ...routePaths.flatMap((path) => path.points),
  ].filter(
    (point): point is Point =>
      Boolean(point) &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y),
  );

  if (!points.length) {
    return { x: 0, y: 0, width: 1000, height: 720 };
  }

  const padding = 34;
  const minPointX = Math.min(...points.map((point) => point.x));
  const maxPointX = Math.max(...points.map((point) => point.x));
  const minPointY = Math.min(...points.map((point) => point.y));
  const maxPointY = Math.max(...points.map((point) => point.y));

  const minLabelX = labels.length
    ? Math.min(...labels.map((label) => label.rect.x))
    : minPointX;
  const maxLabelX = labels.length
    ? Math.max(
        ...labels.map(
          (label) => label.rect.x + label.rect.width,
        ),
      )
    : maxPointX;
  const minLabelY = labels.length
    ? Math.min(...labels.map((label) => label.rect.y))
    : minPointY;
  const maxLabelY = labels.length
    ? Math.max(
        ...labels.map(
          (label) => label.rect.y + label.rect.height,
        ),
      )
    : maxPointY;

  const minX = Math.min(minPointX, minLabelX) - padding;
  const maxX = Math.max(maxPointX, maxLabelX) + padding;
  const minY = Math.min(minPointY, minLabelY) - padding;
  const maxY = Math.max(maxPointY, maxLabelY) + padding;

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

interface MapPresentation {
  graph: GraphModel;
  detached: Set<string>;
  labelPlacements: LabelPlacement[];
  labelByNode: Map<string, LabelPlacement>;
  crossingGaps: ReturnType<typeof routeCrossingGaps>;
  corridorBands: ReturnType<typeof routeCorridorBands>;
}

const presentationCache = new WeakMap<LayoutResult, Map<StationVisualStyle, MapPresentation>>();

function mapPresentation(
  graph: GraphModel,
  layout: LayoutResult,
  stationStyle: StationVisualStyle,
  markerScale: number,
  routes: RenderedRoutePath[],
  routeWidth: number,
  fontSize: number,
  englishSize: number,
) {
  const styles = presentationCache.get(layout) ?? new Map<StationVisualStyle, MapPresentation>();
  const cached = styles.get(stationStyle);
  if (cached?.graph === graph) return cached;
  const sizes = new Map(graph.nodes.map(node => [node.id, markerSize(graph, node, stationStyle, markerScale)]));
  const detached = detachedMarkers(graph, layout, sizes);
  const labelPlacements = buildLabelPlacements(
    graph, layout.positions, sizes, detached, detachedAnchorSize, routes, routeWidth / 2 + 4, fontSize, englishSize,
  );
  const labelByNode = new Map(labelPlacements.map(label => [label.nodeId, label]));
  const previous = styles.values().next().value;
  const crossingGaps = previous?.crossingGaps ?? routeCrossingGaps(graph, layout.positions, routes, routeWidth);
  const corridorBands = previous?.corridorBands ?? routeCorridorBands(routes, routeWidth);
  const output = { graph, detached, labelPlacements, labelByNode, crossingGaps, corridorBands };
  styles.set(stationStyle, output);
  presentationCache.set(layout, styles);
  return output;
}

export function SvgMap({
  graph,
  layout,
  zoom = 1,
  stationStyle = 'taipei',
  sourceName = '輸入路網資料',
  focusedNodeId,
  onStationSelect,
}: SvgMapProps) {
  const isGeographic = layout.style === 'geographic';
  const stationVisualScale = isGeographic ? 0.82 : 1;
  const fontSize = isGeographic ? 13 : 14;
  const englishSize = fontSize * 0.8;
  const routeWidth = isGeographic ? 4.2 : 8;
  const routePaths = buildRenderedRoutePaths(graph, layout);
  const presentation = mapPresentation(graph, layout, stationStyle, stationVisualScale, routePaths, routeWidth, fontSize, englishSize);
  const { detached, labelPlacements, labelByNode, crossingGaps, corridorBands } = presentation;

  const taipeiRiver =
    layout.style === 'taipei'
      ? buildTaipeiRiverLandmark(graph, layout)
      : undefined;

  const concentricGuide =
    layout.style === 'concentric'
      ? (() => {
          const points = graph.nodes.map((node) => layout.positions[node.id]);
          const center = layout.radialCenter ?? {
            x: points.reduce((sum, point) => sum + point.x, 0) / Math.max(1, points.length),
            y: points.reduce((sum, point) => sum + point.y, 0) / Math.max(1, points.length),
          };
          const maxRadius = Math.max(
            1,
            ...points.map((point) =>
              Math.hypot(point.x - center.x, point.y - center.y),
            ),
          );
          return { center, maxRadius };
        })()
      : undefined;
  const bounds = renderBounds(
    graph,
    layout,
    routePaths,
    labelPlacements,
  );
  // A passenger map requires a permanent route-color key, not a control
  // visible only on the generator webpage. Keep it in exported SVG as well.
  const legendEntries = graph.lines.flatMap((line) => {
    const seen = new Set<string>();
    return line.paths.flatMap((_, index) => {
      const color = line.pathColors?.[index] ?? line.color;
      if (seen.has(color)) return [];
      seen.add(color);
      return [{
        key: `${line.id}-${index}`,
        color,
        name: index === 0
          ? (line.name || line.id)
          : `${line.name || line.id}／${line.id === 'TPE_R' ? '新北投支線' : line.id === 'TPE_G' ? '小碧潭支線' : '支線'}`,
      }];
    });
  });
  const headingByStyle = {
    geographic: '地理投影',
    taipei: '台北 45°',
    london: '倫敦 45°',
    moscow: '莫斯科環形放射',
    concentric: '同心圓',
    hex: '六角 60°',
  };
  const taipeiNetwork = graph.lines.some(line => line.id === 'TPE_BL') && graph.lines.some(line => line.id === 'TAO_A');
  const mapTitle = taipeiNetwork ? '大台北與桃園軌道路網' : '軌道路網';
  const legendWidth = Math.max(335, ...legendEntries.map(entry => 95 + Array.from(entry.name).length * 18));
  const partialRailCoverage = graph.lines.some(line => line.id === 'THSR' || line.id === 'TR');
  const missingEnglishNames = graph.nodes.filter(node => !node.nameEn?.trim()).length;
  const ordinary = graph.nodes.find(node => !isInterchangeNode(graph, node));
  const interchange = graph.nodes.find(node => isInterchangeNode(graph, node) && node.stationIds.length === 2);
  const legendX = bounds.x + Math.max(bounds.width, 300) + 22;
  const legendY = bounds.y + 48;
  const footnoteY = legendY + 53 + legendEntries.length * 31;
  const noteCount = Number(partialRailCoverage) + Number(missingEnglishNames > 0);
  const hasCorridors = corridorBands.some(bands => bands.length);
  const notesOffset = hasCorridors ? 176 : 145;
  const fullBounds = {
    x: bounds.x,
    y: bounds.y - 93,
    width: legendX - bounds.x + legendWidth + 24,
    height: Math.max(bounds.height + 93, footnoteY - bounds.y + 93 + notesOffset + 80 + noteCount * 23),
  };
  const maxGuideRadius = concentricGuide ? Math.min(
    concentricGuide.center.x - bounds.x, bounds.x + bounds.width - concentricGuide.center.x,
    concentricGuide.center.y - bounds.y, bounds.y + bounds.height - concentricGuide.center.y,
  ) : 0;
  const crossingClips = crossingGaps.map(disjointGapGroups);
  const hasCrossings = crossingClips.some(clips => clips.length);
  const clipFrame = `M ${fullBounds.x} ${fullBounds.y} h ${fullBounds.width} v ${fullBounds.height} h ${-fullBounds.width} Z`;
  const labelWidth = (node: GraphNode | undefined) => node ? markerSize(graph, node, stationStyle, stationVisualScale).width : 0;
  const symbolColumn = Math.max(labelWidth(ordinary), labelWidth(interchange), 16) / 2 + 6;
  const routeIndex = new Map(routePaths.map((path, index) => [path, index]));
  const sourceLabel = Array.from(sourceName).length > 19 ? `${Array.from(sourceName).slice(0, 18).join('')}…` : sourceName;

  return (
    <svg
      id="metro-map-svg"
      className="map-svg"
      viewBox={`${fullBounds.x} ${fullBounds.y} ${fullBounds.width} ${fullBounds.height}`}
      data-layout-valid={layout.integrity.valid ? 'true' : 'false'}
      data-layout-route-count={layout.integrity.routeCount}
      data-layout-path-count={layout.integrity.pathCount}
      data-layout-segment-count={layout.integrity.segmentCount}
      data-detail-zoom={zoom}
      data-public-use="not-verified"
      data-bilingual-ready={missingEnglishNames === 0 ? "true" : "false"}
      data-station-style={stationStyle}
      data-station-visual-scale={stationVisualScale}
      data-label-font-size={fontSize}
      data-layout-style={layout.style}
      lang="zh-Hant"
      xmlns="http://www.w3.org/2000/svg"
      role={onStationSelect ? 'group' : 'img'}
      aria-label={mapTitle}
    >
      <title>{mapTitle}</title>
      <style>{mapStyles}</style>
      <rect
        x={fullBounds.x}
        y={fullBounds.y}
        width={fullBounds.width}
        height={fullBounds.height}
        className="map-background"
      />

      <g id="map-heading" className="map-ink">
        <text x={bounds.x + 30} y={fullBounds.y + 50} fontSize="40" fontWeight="700">{mapTitle}</text>
        <text x={bounds.x + 31} y={fullBounds.y + 78} fontSize="18">{headingByStyle[layout.style]}・{taipeiNetwork ? '工作簿全路網（含規劃路線）' : '路網示意圖'}</text>
      </g>

      {taipeiRiver ? (
        <g className="taipei-river-landmark" aria-label="淡水河 Tamsui River">
          <path d={taipeiRiver.d} className="taipei-river-path" />
          <text
            x={taipeiRiver.label.x}
            y={taipeiRiver.label.y}
            className="taipei-river-label"
          >
            淡水河
          </text>
        </g>
      ) : null}

      {layout.style === 'moscow' && layout.moscowRings?.length ? (
        <g className="moscow-ring-emphasis" aria-hidden="true">
          {layout.moscowRings.map((ring) => {
            const circle = circleThroughStations(ring.nodes.map(id => layout.positions[id]));
            if (!circle) return null;
            return <circle key={ring.id} cx={circle.center.x} cy={circle.center.y}
              r={circle.radius} className="moscow-ring-halo" />;
          })}
        </g>
      ) : null}

      {concentricGuide ? (
        <g className="concentric-guides" aria-hidden="true">
          {[0.2, 0.4, 0.6, 0.8, 1].filter(ratio => concentricGuide.maxRadius * ratio <= maxGuideRadius).map((ratio) => (
            <circle
              key={ratio}
              cx={concentricGuide.center.x}
              cy={concentricGuide.center.y}
              r={concentricGuide.maxRadius * ratio}
              className="concentric-guide"
            />
          ))}
        </g>
      ) : null}

      {hasCrossings ? (
        <defs>
          {crossingClips.flatMap((clips, index) => clips.map((holes, level) => {
            const cutouts = holes.map(({ x, y, radius }) =>
              `M ${x - radius} ${y} a ${radius} ${radius} 0 1 0 ${2 * radius} 0 a ${radius} ${radius} 0 1 0 ${-2 * radius} 0 Z`,
            ).join(' ');
            return (
              <clipPath key={`${index}-${level}`} id={`crossing-gap-${index}-${level}`} clipPathUnits="userSpaceOnUse">
                <path d={`${clipFrame} ${cutouts}`} clipRule="evenodd"
                  clipPath={level > 0 ? `url(#crossing-gap-${index}-${level - 1})` : undefined} />
              </clipPath>
            );
          }))}
        </defs>
      ) : null}

      <g id="lines" data-route-count={graph.lines.length}>
        {graph.lines.map((line) => {
          const paths = routePaths.filter(
            (routePath) => routePath.lineId === line.id,
          );

          return (
            <g
              key={line.id}
              id={`route-${line.id}`}
              data-line-id={line.id}
              data-path-count={line.paths.length}
            >
              {paths.map((routePath) => {
                const index = routeIndex.get(routePath)!;
                const clipLevel = crossingClips[index].length - 1;
                return <g key={`${line.id}-${routePath.pathIndex}`}
                  clipPath={clipLevel >= 0 ? `url(#crossing-gap-${index}-${clipLevel})` : undefined}>
                  {needsDarkRouteCasing(routePath.lineColor) ? (
                    <path
                      className="route-contrast-casing"
                      d={routePath.d}
                      fill="none"
                      stroke="#334155"
                      strokeWidth={routeWidth + 3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      pointerEvents="none"
                      aria-hidden="true"
                    />
                  ) : null}
                  <path
                  data-line-id={line.id}
                  data-path-index={routePath.pathIndex}
                  data-path-id={line.pathIds?.[routePath.pathIndex] ?? routePath.pathIndex}
                  d={routePath.d}
                  fill="none"
                  stroke={routePath.lineColor}
                  strokeWidth={routeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  />
                  {corridorBands[index].map(({ casing, stripes, width }, index) => (
                    <g key={index} data-route-corridor="true" aria-hidden="true" fill="none">
                      <path d={casing} stroke="#334155" strokeWidth={stripes.length * width + 1.3} />
                      {stripes.map(({ color, d }) => (
                        <path key={color} d={d} stroke={color} strokeWidth={width - 0.35} />
                      ))}
                    </g>
                  ))}
                </g>
              })}
            </g>
          );
        })}
      </g>

      <g id="station-leaders" aria-hidden="true">
        {labelPlacements.map(({ nodeId, leader }) => leader ? (
          <line key={nodeId} className="station-leader"
            x1={leader.from.x} y1={leader.from.y} x2={leader.to.x} y2={leader.to.y} />
        ) : null)}
      </g>

      <g id="stations" data-station-style={stationStyle}>
        {graph.nodes.map((node) => {
          const point = layout.positions[node.id];

          return (
            <g
              key={node.id}
              transform={`translate(${point.x} ${point.y})`}
              data-node-id={node.id}
              data-interchange={isInterchangeNode(graph, node) ? 'true' : 'false'}
              role={onStationSelect ? 'button' : undefined}
              tabIndex={onStationSelect ? 0 : undefined}
              aria-label={onStationSelect ? `${node.name}${node.nameEn ? ` / ${node.nameEn}` : ''}（${node.stationIds.join('、')}）` : undefined}
              onClick={onStationSelect ? () => onStationSelect(node.id) : undefined}
              onKeyDown={onStationSelect ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onStationSelect(node.id);
                }
              } : undefined}
            >
              <title>{`${node.name}${node.nameEn ? ` / ${node.nameEn}` : ''}`}</title>
              {detached.has(node.id) ? (
                <>
                  <circle r={1.85} className="station-anchor" strokeWidth={1.05} />
                  <g transform={`translate(${labelByNode.get(node.id)!.badge!.x - point.x} ${labelByNode.get(node.id)!.badge!.y - point.y})`}>
                    {renderMarker(graph, node, stationStyle, stationVisualScale)}
                  </g>
                </>
              ) : renderMarker(graph, node, stationStyle, stationVisualScale)}
            </g>
          );
        })}
      </g>

      {focusedNodeId && layout.positions[focusedNodeId] ? (
        <circle
          className="station-focus-ring"
          cx={layout.positions[focusedNodeId].x}
          cy={layout.positions[focusedNodeId].y}
          r={29 * stationVisualScale}
          fill="none"
          stroke="#1d4ed8"
          strokeWidth={3 * stationVisualScale}
          strokeDasharray={`${6 * stationVisualScale} ${4 * stationVisualScale}`}
          pointerEvents="none"
        />
      ) : null}
      <g id="route-legend" className="map-ink" aria-label="路線圖例">
        <line x1={legendX - 21} y1={legendY - 28} x2={legendX - 21} y2={footnoteY + notesOffset + 30 + noteCount * 23}
          stroke="#cbd5e1" strokeWidth="1.2" />
        <text x={legendX} y={legendY} fontSize="23" fontWeight="700">路線圖例</text>
        {legendEntries.map((entry, index) => (
          <g key={entry.key} data-legend-route={entry.key}
            transform={`translate(${legendX} ${legendY + 28 + index * 31})`}>
            {needsDarkRouteCasing(entry.color) ? <line x1={3} y1={0} x2={42} y2={0} stroke="#334155" strokeWidth={12} strokeLinecap="round" /> : null}
            <line x1={3} y1={0} x2={42} y2={0} stroke={entry.color} strokeWidth={9} strokeLinecap="round" />
            <text x={57} y={6} fontSize={17} fontWeight={600}>{entry.name}</text>
          </g>
        ))}
        <g id="station-key" transform={`translate(${legendX} ${footnoteY})`} aria-label="站點符號">
          <text fontSize="21" fontWeight="700">站點符號</text>
          {ordinary ? <g transform="translate(0 28)">
            <g transform={`translate(${symbolColumn} 0)`}>{renderMarker(graph, ordinary, stationStyle, stationVisualScale)}</g>
            <text x={symbolColumn * 2 + 16} y={6} fontSize={16}>一般站</text>
          </g> : null}
          {interchange ? <g transform="translate(0 69)">
            <g transform={`translate(${symbolColumn} 0)`}>{renderMarker(graph, interchange, stationStyle, stationVisualScale)}</g>
            <text x={symbolColumn * 2 + 16} y={6} fontSize={16}>轉乘站</text>
          </g> : null}
          {hasCrossings ? <g transform="translate(0 106)">
            <path d={`M ${symbolColumn - 16} 0 h 9 m 14 0 h 9 M ${symbolColumn} -10 v 20`}
              fill="none" stroke="#475569" strokeWidth="3" strokeLinecap="round" />
            <text x={symbolColumn * 2 + 16} y={6} fontSize={16}>路線交叉，無轉乘</text>
          </g> : null}
          {hasCorridors ? <g transform={`translate(0 ${hasCrossings ? 137 : 106})`}>
            <path d={`M ${symbolColumn - 16} -2 h 32`} stroke="#0070BD" strokeWidth="3.2" />
            <path d={`M ${symbolColumn - 16} 2 h 32`} stroke="#C35617" strokeWidth="3.2" />
            <text x={symbolColumn * 2 + 16} y={6} fontSize={16}>並行路線</text>
          </g> : null}
        </g>
      </g>
      {isGeographic ? (
        <g id="north-arrow" className="map-ink" transform={`translate(${legendX + legendWidth - 14} ${legendY - 5})`}>
          <text y="-13" textAnchor="middle" fontSize="17" fontWeight="700">北</text>
          <path d="M 0 -5 L 7 16 L 0 11 L -7 16 Z" />
        </g>
      ) : null}
      <g id="map-provenance" className="map-ink" aria-label="資料來源與產製資訊"
        transform={`translate(${legendX} ${footnoteY + notesOffset})`}>
        <text y={0} fontSize={16} fontWeight={700}>
          <title>{sourceName}</title>
          資料來源　{sourceLabel}
        </text>
        {partialRailCoverage ? (
          <text y={23} fontSize={14}>台鐵／高鐵僅顯示輸入資料所列部分車站</text>
        ) : null}
        {missingEnglishNames ? (
          <text y={23 + Number(partialRailCoverage) * 23} fontSize={14}>
            英文站名缺漏：{missingEnglishNames} 站
          </text>
        ) : null}
        <text y={23 + noteCount * 23} fontSize={14} fill="#7f1d1d">規劃示意・以營運單位公告為準</text>
      </g>
      <g id="labels">
        {labelPlacements.map((label) => (
          <text
            key={label.nodeId}
            x={label.x}
            y={label.y}
            textAnchor={label.textAnchor}
            className="station-label"
            data-label-for={label.nodeId}
            fontSize={fontSize}
          >
            {label.text}
            {label.englishText ? (
              <tspan x={label.x} dy={fontSize * 1.15} fontSize={englishSize} fontWeight={500}
              >{label.englishText}</tspan>
            ) : null}
          </text>
        ))}
      </g>
    </svg>
  );
}
