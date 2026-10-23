import { useMemo, useRef, useState } from 'react';
import { buildGraph } from './core/graph';
import { validateMoscowRings } from './core/moscowRings';
import { importExcelWorkbook } from './io/importData';
import { downloadSvg } from './io/exportSvg';
import { computeLayout } from './layout';
import { SvgMap } from './renderer/SvgMap';
import { sampleNetwork } from './sample';
import type {
  GraphModel,
  LayoutResult,
  MoscowRingDefinition,
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
  { id: 'geographic', label: 'Geographic', note: '真實相對位置基準 / north-up' },
  { id: 'taipei', label: 'Taipei 45°', note: '45° 折衷：地理優先、走廊整線' },
  { id: 'london', label: 'London 45°', note: '45° 拓撲：中心放大、等距與轉乘優先' },
  { id: 'moscow', label: 'Moscow Ring', note: '獨立正圓環線 + 平滑放射 / 切向接入' },
  { id: 'concentric', label: 'Concentric', note: '真正 radial shells：同心圓分層與角度避碰' },
  { id: 'hex', label: 'Hex 60°', note: '60° 三軸網格：路徑整線、抑制 zig-zag' },
];

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

export function App() {
  const initial = useMemo(createInitial, []);
  const [stationsText, setStationsText] = useState(pretty(sampleNetwork.stations));
  const [linesText, setLinesText] = useState(pretty(sampleNetwork.lines));
  const [style, setStyle] = useState<StyleId>('taipei');
  const [stationStyle, setStationStyle] =
    useState<StationVisualStyle>('taipei');
  const [graph, setGraph] = useState<GraphModel>(initial.graph);
  const [layout, setLayout] = useState<LayoutResult>(initial.layout);
  const [moscowRingDefinitions, setMoscowRingDefinitions] = useState<MoscowRingDefinition[]>(sampleNetwork.moscowRings ?? []);
  const [validatedMoscowRings, setValidatedMoscowRings] = useState<ValidatedMoscowRing[]>(() => validateMoscowRings(initial.graph, sampleNetwork.moscowRings ?? []));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dataOpen, setDataOpen] = useState(true);
  const [mapZoom, setMapZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);

  const changeMapZoom = (nextZoom: number) => {
    const next = Math.min(4, Math.max(0.25, nextZoom));
    if (next === mapZoom) return;

    const frame = canvasRef.current;
    const centerX = frame
      ? (frame.scrollLeft + frame.clientWidth / 2) / Math.max(1, frame.scrollWidth)
      : 0.5;
    const centerY = frame
      ? (frame.scrollTop + frame.clientHeight / 2) / Math.max(1, frame.scrollHeight)
      : 0.5;

    setMapZoom(next);

    if (frame) {
      requestAnimationFrame(() => {
        frame.scrollLeft =
          centerX * frame.scrollWidth - frame.clientWidth / 2;
        frame.scrollTop =
          centerY * frame.scrollHeight - frame.clientHeight / 2;
      });
    }
  };

  const resetMapZoom = () => {
    setMapZoom(1);
    requestAnimationFrame(() => {
      if (!canvasRef.current) return;
      canvasRef.current.scrollLeft = 0;
      canvasRef.current.scrollTop = 0;
    });
  };

  const generateFrom = (
    stations: Station[],
    lines: TransitLine[],
    rings: MoscowRingDefinition[] = moscowRingDefinitions,
    nextStyle = style,
  ) => {
    const nextGraph = buildGraph({ stations, lines });
    const nextRings = validateMoscowRings(nextGraph, rings);
    const nextLayout = computeLayout(nextGraph, nextStyle, {
      moscowRings: nextRings,
    });
    setGraph(nextGraph);
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
      setNotice(
        nextStyle === 'moscow'
          ? `莫斯科環驗證通過：${generated.rings.length} 個環。`
          : '',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importExcelFile = async (file?: File) => {
    if (!file) return;
    try {
      const network = await importExcelWorkbook(file);
      setStationsText(pretty(network.stations));
      setLinesText(pretty(network.lines));
      generateFrom(
        network.stations,
        network.lines,
        network.moscowRings ?? [],
      );
      setNotice(
        `Excel 匯入完成：${network.stations.length} 個車站、${network.lines.length} 條路線、${network.moscowRings?.length ?? 0} 個莫斯科環；環閉合驗證通過。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const resetSample = () => {
    setStationsText(pretty(sampleNetwork.stations));
    setLinesText(pretty(sampleNetwork.lines));
    setStyle('taipei');
    setStationStyle('taipei');
    setMoscowRingDefinitions(sampleNetwork.moscowRings ?? []);
    const nextGraph = buildGraph(sampleNetwork);
    setGraph(nextGraph);
    const rings = validateMoscowRings(nextGraph, sampleNetwork.moscowRings ?? []);
    setValidatedMoscowRings(rings);
    setLayout(computeLayout(nextGraph, 'taipei', { moscowRings: rings }));
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
                onChange={(event) => setStationsText(event.target.value)}
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
                onChange={(event) => setLinesText(event.target.value)}
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
                onChange={(event) => {
                  const next = event.target.value as StyleId;
                  setStyle(next);
                  generate(next);
                }}
              >
                {STYLE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
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

          <div
            ref={canvasRef}
            className="canvas-frame"
            onWheel={(event) => {
              if (!event.ctrlKey) return;
              event.preventDefault();
              changeMapZoom(
                mapZoom + (event.deltaY < 0 ? 0.25 : -0.25),
              );
            }}
          >
            <div className="zoom-controls" aria-label="地圖細節倍率">
              <button
                type="button"
                onClick={() => changeMapZoom(mapZoom - 0.25)}
                disabled={mapZoom <= 0.25}
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
                disabled={mapZoom >= 4}
                title="提高細節倍率"
              >
                +
              </button>
              <span>Ctrl + 滾輪調整細節倍率</span>
            </div>

            <div
              className="map-zoom-stage"
              style={{ width: `${mapZoom * 100}%` }}
            >
              <SvgMap
                graph={graph}
                layout={layout}
                zoom={mapZoom}
                stationStyle={stationStyle}
              />
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
        <span>V0.17 Osaka 車站風格 + station suffix 優化 + Moscow corridor cleanup</span>
        <span>React · TypeScript · SVG · topology first</span>
      </footer>
    </div>
  );
}
