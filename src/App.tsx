import { useMemo, useState } from 'react';
import { buildGraph } from './core/graph';
import {
  importExcelWorkbook,
  parseLinesCsv,
  parseStationsCsv,
} from './io/importData';
import { downloadSvg } from './io/exportSvg';
import { computeLayout } from './layout';
import { SvgMap } from './renderer/SvgMap';
import { sampleNetwork } from './sample';
import type {
  GraphModel,
  LayoutResult,
  Station,
  StyleId,
  TransitLine,
} from './types';

const STYLE_OPTIONS: Array<{ id: StyleId; label: string; note: string }> = [
  { id: 'geographic', label: 'Geographic', note: '真實相對位置基準' },
  { id: 'taipei', label: 'Taipei 45°', note: '地理位置權重較高' },
  { id: 'london', label: 'London 45°', note: '拓撲與等距優先' },
  { id: 'moscow', label: 'Moscow Ring', note: '從整體路網自動評分候選環' },
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

export function App() {
  const initial = useMemo(createInitial, []);
  const [stationsText, setStationsText] = useState(pretty(sampleNetwork.stations));
  const [linesText, setLinesText] = useState(pretty(sampleNetwork.lines));
  const [style, setStyle] = useState<StyleId>('taipei');
  const [graph, setGraph] = useState<GraphModel>(initial.graph);
  const [layout, setLayout] = useState<LayoutResult>(initial.layout);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dataOpen, setDataOpen] = useState(true);

  const generateFrom = (
    stations: Station[],
    lines: TransitLine[],
    nextStyle = style,
  ) => {
    const nextGraph = buildGraph({ stations, lines });
    const nextLayout = computeLayout(nextGraph, nextStyle);
    setGraph(nextGraph);
    setLayout(nextLayout);
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
      setNotice('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importStationsFile = async (file?: File) => {
    if (!file) return;
    try {
      const stations = parseStationsCsv(await file.text());
      setStationsText(pretty(stations));
      setNotice(`已匯入 ${stations.length} 個車站。請按 Generate 套用。`);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importLinesFile = async (file?: File) => {
    if (!file) return;
    try {
      const lines = parseLinesCsv(await file.text());
      setLinesText(pretty(lines));
      setNotice(`已匯入 ${lines.length} 條路線。請按 Generate 套用。`);
      setError('');
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

  const resetSample = () => {
    setStationsText(pretty(sampleNetwork.stations));
    setLinesText(pretty(sampleNetwork.lines));
    setStyle('taipei');
    const nextGraph = buildGraph(sampleNetwork);
    setGraph(nextGraph);
    setLayout(computeLayout(nextGraph, 'taipei'));
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
      setNotice(`SVG 完整性驗證通過：${graph.lines.length} 條路線皆已包含。`);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectedStyle = STYLE_OPTIONS.find((option) => option.id === style)!;
  const stationCount = safeArrayLength(stationsText);
  const ringNames =
    layout.primaryRing?.map((nodeId) => graph.nodeById.get(nodeId)?.name ?? nodeId) ?? [];
  const primaryCandidate = layout.ringCandidates?.[0];

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
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
              <strong>CSV / Excel Input</strong>
              <div className="import-actions">
                <label className="mini-file-button">
                  Stations CSV
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => {
                      void importStationsFile(event.currentTarget.files?.[0]);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
                <label className="mini-file-button">
                  Lines CSV
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => {
                      void importLinesFile(event.currentTarget.files?.[0]);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>
              <small>
                Excel 需包含 Stations、Lines 兩個工作表；CSV 則分開匯入車站與路線。
              </small>
            </div>

            <section>
              <div className="section-heading">
                <div>
                  <span className="step">01</span>
                  <h2>Stations</h2>
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
                  <h2>Lines & Paths</h2>
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

          <div className="canvas-frame">
            <SvgMap graph={graph} layout={layout} />
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
            <div className="ring-status">
              <span>Detected ring</span>
              <strong>
                {ringNames.length
                  ? `${ringNames.length} nodes · score ${primaryCandidate?.score.toFixed(1) ?? '—'}`
                  : '—'}
              </strong>
              {ringNames.length ? <small>{ringNames.join(' → ')}</small> : null}
              {primaryCandidate ? (
                <small>
                  routes {primaryCandidate.routeIds.join(' + ')} · transfers{' '}
                  {primaryCandidate.transferCount} · spokes{' '}
                  {primaryCandidate.outwardConnections} · area{' '}
                  {(primaryCandidate.areaCoverage * 100).toFixed(1)}%
                </small>
              ) : null}
              {layout.ringCandidates?.length ? (
                <small>{layout.ringCandidates.length} candidate cycle(s) evaluated</small>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      <footer>
        <span>V0.2 input + export validation + ring diagnostics</span>
        <span>React · TypeScript · SVG · topology first</span>
      </footer>
    </div>
  );
}
