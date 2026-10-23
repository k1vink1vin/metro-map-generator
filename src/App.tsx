import { useMemo, useRef, useState } from 'react';
import { buildGraph } from './core/graph';
import { importExcelWorkbook } from './io/importData';
import { downloadExcelTemplate } from './io/templateExcel';
import { downloadSvg } from './io/exportSvg';
import { computeLayout } from './layout';
import { SvgMap } from './renderer/SvgMap';
import { sampleNetwork } from './sample';
import type {
  GraphModel,
  LayoutResult,
  RingCandidateDiagnostic,
  Station,
  StyleId,
  TransitLine,
} from './types';

const STYLE_OPTIONS: Array<{ id: StyleId; label: string; note: string }> = [
  { id: 'geographic', label: 'Geographic', note: '真實相對位置基準' },
  { id: 'taipei', label: 'Taipei 45°', note: '地理位置權重較高' },
  { id: 'london', label: 'London 45°', note: '拓撲與等距優先' },
  { id: 'moscow', label: 'Moscow Ring', note: '先偵測候選環，再由使用者指定主環' },
  { id: 'concentric', label: 'Concentric', note: '同心圓量化' },
  { id: 'hex', label: 'Hex 60°', note: '六方向 / triangular grid' },
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

function ringOptionLabel(
  candidate: RingCandidateDiagnostic,
  index: number,
): string {
  const routes = candidate.routeIds.join('+') || 'mixed';
  return `環 ${index + 1}｜${routes}｜${candidate.nodes.length}站｜score ${candidate.score.toFixed(1)}`;
}

export function App() {
  const initial = useMemo(createInitial, []);
  const [stationsText, setStationsText] = useState(pretty(sampleNetwork.stations));
  const [linesText, setLinesText] = useState(pretty(sampleNetwork.lines));
  const [style, setStyle] = useState<StyleId>('taipei');
  const [graph, setGraph] = useState<GraphModel>(initial.graph);
  const [layout, setLayout] = useState<LayoutResult>(initial.layout);
  const [selectedRingCandidateId, setSelectedRingCandidateId] = useState('');
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
    nextStyle = style,
  ) => {
    const nextGraph = buildGraph({ stations, lines });
    const nextLayout = computeLayout(nextGraph, nextStyle);
    setGraph(nextGraph);
    setLayout(nextLayout);
    setSelectedRingCandidateId('');
    resetMapZoom();
    setError('');
    return nextGraph;
  };

  const generate = (nextStyle = style) => {
    try {
      const stations = JSON.parse(stationsText) as Station[];
      const lines = JSON.parse(linesText) as TransitLine[];
      if (!Array.isArray(stations) || !Array.isArray(lines)) {
        throw new Error('Stations and lines must both be JSON arrays.');
      }
      generateFrom(stations, lines, nextStyle);
      setNotice(
        nextStyle === 'moscow'
          ? '已偵測路網候選環。請在「主環」下拉選單選擇要正規化成環的候選。'
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
      generateFrom(network.stations, network.lines);
      setNotice(
        `Excel 匯入完成：${network.stations.length} 個車站、${network.lines.length} 條路線。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectMoscowRing = (candidateId: string) => {
    setSelectedRingCandidateId(candidateId);
    const nextLayout = computeLayout(graph, 'moscow', {
      moscowRingCandidateId: candidateId || undefined,
    });
    setLayout(nextLayout);
    setNotice(
      candidateId
        ? '已套用你選擇的 Moscow 主環。'
        : '已取消主環選擇；目前只保留候選環偵測結果。',
    );
    setError('');
  };

  const resetSample = () => {
    setStationsText(pretty(sampleNetwork.stations));
    setLinesText(pretty(sampleNetwork.lines));
    setStyle('taipei');
    setSelectedRingCandidateId('');
    const nextGraph = buildGraph(sampleNetwork);
    setGraph(nextGraph);
    setLayout(computeLayout(nextGraph, 'taipei'));
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
  const ringCandidates = layout.ringCandidates ?? [];
  const selectedCandidate = ringCandidates.find(
    (candidate) => candidate.id === layout.primaryRingCandidateId,
  );
  const suggestedCandidate = ringCandidates[0];
  const ringNames =
    layout.primaryRing?.map((nodeId) => graph.nodeById.get(nodeId)?.name ?? nodeId) ?? [];

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
                <button type="button" onClick={() => void downloadExcelTemplate()}>
                  下載 XLSM 範本（已內建 VBA）
                </button>
              </div>
              <small>
                「車站」工作表 A-D 欄是手動輸入：車站編號 / 車站名稱 / 緯度 / 經度。
                E 欄「轉乘群組」會自動產生 XFER_001 / XFER_002...，
                F 欄「轉乘驗證」會檢查同名站的經緯度是否一致。
                XLSM 已直接內建 VBA，不需要再下載第二個檔案；啟用巨集後會自動完成轉乘群組與驗證。
                topology 優先使用 XFER ID，所以日後修改站名不會破壞轉乘關係。
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
              <span>STYLE</span>
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

            {style === 'moscow' ? (
              <label className="ring-selector">
                <span>主環</span>
                <select
                  value={selectedRingCandidateId}
                  onChange={(event) => selectMoscowRing(event.target.value)}
                >
                  <option value="">
                    尚未選擇｜已偵測 {ringCandidates.length} 個候選環
                  </option>
                  {ringCandidates.map((candidate, index) => (
                    <option key={candidate.id} value={candidate.id}>
                      {ringOptionLabel(candidate, index)}
                      {index === 0 ? '｜推薦' : ''}
                    </option>
                  ))}
                </select>
              </label>
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
            <div className="zoom-controls" aria-label="地圖縮放">
              <button
                type="button"
                onClick={() => changeMapZoom(mapZoom - 0.25)}
                disabled={mapZoom <= 0.25}
                title="縮小"
              >
                −
              </button>
              <button
                type="button"
                className="zoom-readout"
                onClick={resetMapZoom}
                title="適合畫面 / 回到 100%"
              >
                {Math.round(mapZoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => changeMapZoom(mapZoom + 0.25)}
                disabled={mapZoom >= 4}
                title="放大"
              >
                +
              </button>
              <span>Ctrl + 滾輪縮放</span>
            </div>

            <div
              className="map-zoom-stage"
              style={{ width: `${mapZoom * 100}%` }}
            >
              <SvgMap graph={graph} layout={layout} zoom={mapZoom} />
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
              {style !== 'moscow' ? (
                <strong>切換到 Moscow 查看</strong>
              ) : selectedCandidate ? (
                <>
                  <strong>
                    已選環 · {selectedCandidate.nodes.length}站 · score{' '}
                    {selectedCandidate.score.toFixed(1)}
                  </strong>
                  <small>{ringNames.join(' → ')}</small>
                  <small>
                    routes {selectedCandidate.routeIds.join(' + ')} · transfers{' '}
                    {selectedCandidate.transferCount} · spokes{' '}
                    {selectedCandidate.outwardConnections} · area{' '}
                    {(selectedCandidate.areaCoverage * 100).toFixed(1)}%
                  </small>
                  <small>共偵測 {ringCandidates.length} 個候選環，可由上方下拉選單更換。</small>
                </>
              ) : (
                <>
                  <strong>已偵測 {ringCandidates.length} 個候選環，等待你選擇</strong>
                  {suggestedCandidate ? (
                    <small>
                      推薦：{suggestedCandidate.routeIds.join(' + ')} ·{' '}
                      {suggestedCandidate.nodes.length}站 · score{' '}
                      {suggestedCandidate.score.toFixed(1)}
                    </small>
                  ) : (
                    <small>目前路網沒有偵測到閉合 cycle。</small>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer>
        <span>V0.11 放大時站名字體反向縮放</span>
        <span>React · TypeScript · SVG · topology first</span>
      </footer>
    </div>
  );
}
