import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildGraph } from './core/graph';
import { validateMoscowRings } from './core/moscowRings';
import { defaultConcentricCenter } from './core/workbookPresentation';
import { importExcelWorkbook } from './io/importData';
import { downloadSvg } from './io/exportSvg';
import { computeLayout } from './layout';
import { SvgMap } from './renderer/SvgMap';
import { sampleNetwork } from './sample';
import type {
  GraphModel,
  LayoutResult,
  MoscowRingDefinition,
  Point,
  ValidatedMoscowRing,
  Station,
  StationVisualStyle,
  StyleId,
  TransitLine,
} from './types';

const STATION_STYLE_OPTIONS: Array<{
  id: StationVisualStyle;
  label: string;
}> = [
  { id: 'taipei', label: '台北捷運風' },
  { id: 'tokyo', label: '東京地下鐵風' },
  { id: 'osaka', label: '大阪地鐵風' },
  { id: 'moscow', label: '莫斯科風' },
];

const STYLE_OPTIONS: Array<{ id: StyleId; label: string; note: string }> = [
  { id: 'geographic', label: 'Geographic', note: '純經緯度等比例投影 / north-up，不做拓樸修形' },
  { id: 'taipei', label: 'Taipei 45°', note: '硬性 0/45/90/135° + 相對地理 + 台北路網淡水河地標' },
  { id: 'london', label: 'London 45°', note: '硬性 45° 拓撲：等距、轉乘與中心可讀性優先' },
  { id: 'moscow', label: 'Moscow Ring', note: '獨立多圓心正圓環線 + 非環段硬性 45° 輻射語彙' },
  { id: 'concentric', label: 'Concentric', note: '可指定圓心車站；路徑只允許同心圓弧或放射直線' },
  { id: 'hex', label: 'Hex 60°', note: '硬性 0/60/120° 三軸網格 + 拓樸保護' },
];

const STYLE_GROUPS: Array<{
  label: string;
  ids: StyleId[];
}> = [
  { label: '基準', ids: ['geographic'] },
  {
    label: '三大城市風格',
    ids: ['taipei', 'london', 'moscow'],
  },
  {
    label: '兩種構圖網格',
    ids: ['concentric', 'hex'],
  },
];

const MIN_MAP_ZOOM = 0.5;
const MAX_MAP_ZOOM = 32;
const MIN_READING_ZOOM = 8;
const READING_LABEL_PIXELS = 14;

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function safeArrayLength(text: string): number | null {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.length : null;
  } catch {
    return null;
  }
}

function createInitial() {
  const graph = buildGraph(sampleNetwork);
  const layout = computeLayout(graph, 'taipei');
  return { graph, layout };
}

function canvasCenter(frame: HTMLDivElement) {
  const bounds = frame.getBoundingClientRect();
  return new DOMPoint(
    bounds.left + frame.clientLeft + frame.clientWidth / 2,
    bounds.top + frame.clientTop + frame.clientHeight / 2,
  );
}

function centerMapPoint(frame: HTMLDivElement, svg: SVGSVGElement, point: Point) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const target = new DOMPoint(point.x, point.y).matrixTransform(matrix);
  const center = canvasCenter(frame);
  frame.scrollBy(target.x - center.x, target.y - center.y);
}

function zoomForReading(frame: HTMLDivElement | null) {
  const svg = frame?.querySelector<SVGSVGElement>('svg.map-svg');
  if (!frame?.clientWidth || !svg) return MIN_READING_ZOOM;
  const fittedLabelPixels = Number(svg.dataset.labelFontSize) * frame.clientWidth / svg.viewBox.baseVal.width;
  if (!(fittedLabelPixels > 0)) return MIN_READING_ZOOM;
  const readingZoom = Math.ceil(READING_LABEL_PIXELS / fittedLabelPixels * 4) / 4;
  return Math.min(MAX_MAP_ZOOM, Math.max(MIN_READING_ZOOM, readingZoom));
}

export function App() {
  const initial = useMemo(createInitial, []);
  const [stationsText, setStationsText] = useState(pretty(sampleNetwork.stations));
  const [linesText, setLinesText] = useState(pretty(sampleNetwork.lines));
  const [stationStyle, setStationStyle] =
    useState<StationVisualStyle>('taipei');
  const [graph, setGraph] = useState<GraphModel>(initial.graph);
  const [layout, setLayout] = useState<LayoutResult>(initial.layout);
  const [moscowRingDefinitions, setMoscowRingDefinitions] = useState<MoscowRingDefinition[]>(sampleNetwork.moscowRings ?? []);
  const [validatedMoscowRings, setValidatedMoscowRings] = useState<ValidatedMoscowRing[]>(() => validateMoscowRings(initial.graph, sampleNetwork.moscowRings ?? []));
  const [concentricCenterNodeId, setConcentricCenterNodeId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dataOpen, setDataOpen] = useState(true);
  const [mapZoom, setMapZoom] = useState(1);
  const [sourceName, setSourceName] = useState('內建測試資料');
  const [draftEdited, setDraftEdited] = useState(false);
  const [focusedStationId, setFocusedStationId] = useState('');
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<Point | null>(null);
  const importVersion = useRef(0);
  const style = layout.style;
  const currentStyle = useRef(style);
  useLayoutEffect(() => {
    currentStyle.current = style;
  }, [style]);

  // Recenter after React applies the new SVG dimensions and viewBox.
  useLayoutEffect(() => {
    const frame = canvasRef.current;
    const svg = frame?.querySelector<SVGSVGElement>('svg.map-svg');
    const focused = focusedStationId ? layout.positions[focusedStationId] : undefined;
    const point = focused ?? zoomAnchor.current;
    zoomAnchor.current = null;
    if (!frame || !svg || !point) return;

    const center = () => centerMapPoint(frame, svg, point);
    center();
    if (!focused) return;
    const resize = new ResizeObserver(center);
    resize.observe(frame);
    return () => resize.disconnect();
  }, [focusedStationId, mapZoom, layout, stationStyle]);

  const changeMapZoom = useCallback((nextZoom: number) => {
    const next = Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, nextZoom));
    if (next === mapZoom) return;

    const frame = canvasRef.current;
    const svg = frame?.querySelector<SVGSVGElement>('svg.map-svg');
    const matrix = svg?.getScreenCTM();
    if (!focusedStationId && frame && svg && matrix) {
      const center = canvasCenter(frame).matrixTransform(matrix.inverse());
      const viewBox = svg.viewBox.baseVal;
      zoomAnchor.current = {
        x: Math.max(viewBox.x, Math.min(center.x, viewBox.x + viewBox.width)),
        y: Math.max(viewBox.y, Math.min(center.y, viewBox.y + viewBox.height)),
      };
    }
    setMapZoom(next);
  }, [focusedStationId, mapZoom]);

  useEffect(() => {
    const frame = canvasRef.current;
    if (!frame) return;
    const zoomOnWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      changeMapZoom(mapZoom + (event.deltaY < 0 ? 0.25 : -0.25));
    };
    frame.addEventListener('wheel', zoomOnWheel, { passive: false });
    return () => frame.removeEventListener('wheel', zoomOnWheel);
  }, [changeMapZoom, mapZoom]);

  const focusStation = (stationId: string) => {
    setFocusedStationId(stationId);
    if (!graph.nodeById.has(stationId)) return;
    const detailZoom = zoomForReading(canvasRef.current);
    setMapZoom((current) => Math.max(detailZoom, current));
    canvasRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const resetMapZoom = () => {
    zoomAnchor.current = null;
    setMapZoom(1);
    setFocusedStationId('');
    canvasRef.current?.scrollTo(0, 0);
  };

  const generateFrom = (
    stations: Station[],
    lines: TransitLine[],
    rings: MoscowRingDefinition[] = moscowRingDefinitions,
    nextStyle = style,
    fromWorkbook = false,
  ) => {
    const nextGraph = buildGraph({ stations, lines });
    const nextRings = validateMoscowRings(nextGraph, rings);
    const center = fromWorkbook
      ? defaultConcentricCenter(nextGraph)
      : concentricCenterNodeId;
    const selectedConcentricCenter = center && nextGraph.nodeById.has(center) ? center : undefined;
    const nextLayout = computeLayout(nextGraph, nextStyle, {
      moscowRings: nextRings,
      concentricCenterNodeId: selectedConcentricCenter,
    });
    setGraph(nextGraph);
    setConcentricCenterNodeId(selectedConcentricCenter ?? '');
    setLayout(nextLayout);
    setMoscowRingDefinitions(rings);
    setValidatedMoscowRings(nextRings);
    resetMapZoom();
    setError('');
    return { graph: nextGraph, rings: nextRings };
  };

  const generate = (nextStyle = style) => {
    try {
      const stations = JSON.parse(stationsText) as Station[];
      const lines = JSON.parse(linesText) as TransitLine[];
      if (!Array.isArray(stations) || !Array.isArray(lines)) {
        throw new Error('Stations and lines must both be JSON arrays.');
      }
      const generated = generateFrom(
        stations,
        lines,
        moscowRingDefinitions,
        nextStyle,
      );
      if (draftEdited) {
        setSourceName('手動編輯資料');
        setDraftEdited(false);
      }
      setNotice(
        nextStyle === 'moscow'
          ? `莫斯科環驗證通過：${generated.rings.length} 個環。`
          : '',
      );
    } catch (cause) {
      setNotice('');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const editData = (setText: (value: string) => void, value: string) => {
    importVersion.current += 1;
    setText(value);
    setDraftEdited(true);
    setNotice('');
  };

  const importExcelFile = async (file?: File) => {
    if (!file) return;
    const version = ++importVersion.current;
    setError('');
    setNotice('正在匯入 Excel…');
    try {
      const network = await importExcelWorkbook(file);
      if (version !== importVersion.current) return;
      generateFrom(
        network.stations,
        network.lines,
        network.moscowRings ?? [],
        currentStyle.current,
        true,
      );
      setStationsText(pretty(network.stations));
      setLinesText(pretty(network.lines));
      setSourceName(file.name);
      setDraftEdited(false);
      setNotice(
        `Excel 匯入完成：${network.stations.length} 個車站、${network.lines.length} 條路線、${network.moscowRings?.length ?? 0} 個莫斯科環；環閉合驗證通過。`,
      );
    } catch (cause) {
      if (version !== importVersion.current) return;
      setNotice('');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const resetSample = () => {
    importVersion.current += 1;
    setSourceName('內建測試資料');
    setStationsText(pretty(sampleNetwork.stations));
    setLinesText(pretty(sampleNetwork.lines));
    setDraftEdited(false);
    setStationStyle('taipei');
    setConcentricCenterNodeId('');
    setMoscowRingDefinitions(sampleNetwork.moscowRings ?? []);
    const nextGraph = buildGraph(sampleNetwork);
    setGraph(nextGraph);
    const rings = validateMoscowRings(nextGraph, sampleNetwork.moscowRings ?? []);
    setValidatedMoscowRings(rings);
    setLayout(
      computeLayout(nextGraph, 'taipei', {
        moscowRings: rings,
      }),
    );
    resetMapZoom();
    setNotice('');
    setError('');
  };

  const exportSvg = () => {
    try {
      downloadSvg(
        'metro-map-svg',
        graph.lines.map((line) => ({
          id: line.id,
          pathCount: line.paths.length,
        })),
      );
      setNotice(
        `SVG 完整性驗證通過：${layout.integrity.routeCount} 條路線、${layout.integrity.pathCount} 個 paths、${layout.integrity.segmentCount} 個 segments 皆已包含且位於 viewBox 內。`,
      );
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectedStyle = STYLE_OPTIONS.find((option) => option.id === style)!;
  const stationCount = safeArrayLength(stationsText);
  const ringNames = validatedMoscowRings.map((ring) => ({
    id: ring.id,
    names: ring.nodes.map(
      (nodeId) => graph.nodeById.get(nodeId)?.name ?? nodeId,
    ),
  }));

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <div className="eyebrow">SCHEMATIC TRANSIT LAB</div>
          <h1>Metro Map Generator</h1>
          <p>
            從經緯度與路線順序，自動建立 45°、60°、環形與同心圓路線圖。
          </p>
        </div>
        <div className="header-actions">
          <label className="button secondary file-button">
            匯入 Excel
            <input
              type="file"
              accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12"
              onChange={(event) => {
                void importExcelFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
          </label>
          <button className="button secondary" onClick={() => setDataOpen((value) => !value)}>
            {dataOpen ? '隱藏資料' : '編輯資料'}
          </button>
          <button className="button secondary" onClick={resetSample}>
            載入範例
          </button>
          <button className="button primary" onClick={exportSvg}>
            匯出 SVG
          </button>
        </div>
      </header>

      <main className={`workspace ${dataOpen ? '' : 'data-collapsed'}`}>
        {dataOpen ? (
          <aside className="data-panel">
            <div className="import-box">
              <strong>Excel 輸入</strong>
              <div className="example-links">
                <a
                  href="https://github.com/k1vink1vin/metro-map-generator/raw/refs/heads/main/TPE_Metro.xlsm"
                >
                  下載 TPE_Metro.xlsm 範本
                </a>
              </div>
              <small>
                「車站」工作表 A-D 欄是手動輸入：車站編號 / 車站名稱 / 緯度 / 經度。
                E 欄「轉乘群組」會自動產生 XFER_001 / XFER_002...，
                F 欄「轉乘驗證」會檢查同名站的經緯度是否一致。
                XLSM 已直接內建 VBA，不需要再下載第二個檔案；啟用巨集後會自動完成轉乘群組與驗證。
                topology 優先使用 XFER ID，所以日後修改站名不會破壞轉乘關係。
                Moscow 環請直接在 XLSM「莫斯科環」工作表定義，最多 3 個；匯入網站後會檢查每一段與首尾是否真正閉合。
              </small>
            </div>

            <section>
              <div className="section-heading">
                <div>
                  <span className="step">01</span>
                  <h2>車站</h2>
                </div>
                <span>{stationCount ?? '—'}</span>
              </div>
              <textarea
                value={stationsText}
                onChange={(event) => editData(setStationsText, event.target.value)}
                spellCheck={false}
                aria-label="Stations JSON"
              />
            </section>

            <section>
              <div className="section-heading">
                <div>
                  <span className="step">02</span>
                  <h2>路線與路徑</h2>
                </div>
              </div>
              <textarea
                value={linesText}
                onChange={(event) => editData(setLinesText, event.target.value)}
                spellCheck={false}
                aria-label="Lines JSON"
              />
            </section>
          </aside>
        ) : null}

        <section className="map-panel">
          <div className="toolbar">
            <label>
              <span>路網風格</span>
              <select
                value={style}
                onChange={(event) => generate(event.target.value as StyleId)}
              >
                {STYLE_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.ids.map((styleId) => {
                      const option = STYLE_OPTIONS.find(
                        (item) => item.id === styleId,
                      );
                      if (!option) return null;
                      return (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
            </label>

            <label>
              <span>車站風格</span>
              <select
                value={stationStyle}
                onChange={(event) =>
                  setStationStyle(
                    event.target.value as StationVisualStyle,
                  )
                }
              >
                {STATION_STYLE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {style === 'moscow' ? (
              <div className="ring-selector">
                <span>莫斯科環</span>
                <strong>{validatedMoscowRings.length}/3 個環已由 XLSM 定義並通過閉合驗證</strong>
              </div>
            ) : null}

            {style === 'concentric' ? (
              <label className="ring-selector">
                <span>同心圓圓心車站</span>
                <select
                  value={concentricCenterNodeId}
                  onChange={(event) => {
                    const next = event.target.value;
                    setConcentricCenterNodeId(next);
                    setLayout(
                      computeLayout(graph, 'concentric', {
                        moscowRings: validatedMoscowRings,
                        concentricCenterNodeId:
                          next || undefined,
                      }),
                    );
                    resetMapZoom();
                  }}
                >
                  <option value="">自動（路網幾何中心）</option>
                  {[...graph.nodes]
                    .sort((a, b) =>
                      a.name.localeCompare(b.name, 'zh-Hant'),
                    )
                    .map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name} · {node.stationIds.join('/')}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}

            <label className="station-finder">
              <span>定位車站（進入清晰閱讀模式）</span>
              <select
                value={focusedStationId}
                onChange={(event) => focusStation(event.target.value)}
                aria-label="定位車站"
              >
                <option value="">選擇車站</option>
                {[...graph.nodes]
                  .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
                  .map((node) => (
                    <option key={node.id} value={node.id}>{node.name}{node.nameEn ? ` / ${node.nameEn}` : ''}</option>
                  ))}
              </select>
            </label>
            <div className="style-description">
              <strong>{selectedStyle.label}</strong>
              <span>{selectedStyle.note}</span>
            </div>

            <button className="button generate" onClick={() => generate()}>
              Generate
            </button>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
          {notice ? <div className="notice-banner">{notice}</div> : null}

          <div className="map-viewport">
            <div className="zoom-controls" role="group" aria-label="地圖細節倍率">
              <button
                type="button"
                className="zoom-detail"
                onClick={() => changeMapZoom(Math.max(mapZoom, zoomForReading(canvasRef.current)))}
                title="放大地圖以閱讀車站名稱"
              >清晰閱讀</button>
              <button
                type="button"
                onClick={() => changeMapZoom(mapZoom - 0.25)}
                disabled={mapZoom <= MIN_MAP_ZOOM}
                title="降低細節倍率"
              >
                −
              </button>
              <button
                type="button"
                className="zoom-readout"
                onClick={resetMapZoom}
                title="回到 100% 細節倍率"
              >
                {Math.round(mapZoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => changeMapZoom(mapZoom + 0.25)}
                disabled={mapZoom >= MAX_MAP_ZOOM}
                title="提高細節倍率"
              >
                +
              </button>
              <span>Ctrl + 滾輪調整細節倍率</span>
            </div>

            <div ref={canvasRef} className="canvas-frame">
              <div className="map-zoom-stage" style={{ width: `${mapZoom * 100}%` }}>
                <SvgMap
                  graph={graph}
                  layout={layout}
                  zoom={mapZoom}
                  stationStyle={stationStyle}
                  sourceName={sourceName}
                  focusedNodeId={focusedStationId}
                  onStationSelect={focusStation}
                />
              </div>
            </div>
          </div>

          <div className="status-grid">
            <div>
              <span>Nodes</span>
              <strong>{graph.nodes.length}</strong>
            </div>
            <div>
              <span>Edges</span>
              <strong>{graph.edges.length}</strong>
            </div>
            <div>
              <span>Routes</span>
              <strong>{graph.lines.length}</strong>
            </div>
            <div className="coverage-status">
              <span>Route coverage</span>
              <strong>
                {layout.integrity.valid
                  ? `${layout.integrity.routeCount}/${graph.lines.length}`
                  : 'ERROR'}
              </strong>
              <small>
                {layout.integrity.pathCount} paths · {layout.integrity.segmentCount} segments
              </small>
              {layout.integrity.repairedNodeCount ||
              layout.integrity.separatedNodePairs ? (
                <small>
                  repaired {layout.integrity.repairedNodeCount} nodes · separated{' '}
                  {layout.integrity.separatedNodePairs} overlaps
                </small>
              ) : null}
            </div>
            <div className="ring-status">
              <span>Moscow rings</span>
              <strong>{validatedMoscowRings.length}/3 已驗證</strong>
              {ringNames.length ? (
                ringNames.map((ring) => (
                  <small key={ring.id}>
                    {ring.id}: {ring.names.join(' → ')} → {ring.names[0]}
                  </small>
                ))
              ) : (
                <small>請在 XLSM「莫斯科環」工作表定義環。</small>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer>
        <span>Station-anchored curves · independent circular rings · topology QA</span>
        <span>React · TypeScript · SVG · topology first</span>
      </footer>
    </div>
  );
}
