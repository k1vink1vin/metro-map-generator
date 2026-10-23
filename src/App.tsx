import { useMemo, useState } from 'react';
import { buildGraph } from './core/graph';
import { downloadSvg } from './io/exportSvg';
import { computeLayout } from './layout';
import { SvgMap } from './renderer/SvgMap';
import { sampleNetwork } from './sample';
import type { GraphModel, LayoutResult, Station, StyleId, TransitLine } from './types';

const STYLE_OPTIONS: Array<{ id: StyleId; label: string; note: string }> = [
  { id: 'geographic', label: 'Geographic', note: '真實相對位置基準' },
  { id: 'taipei', label: 'Taipei 45°', note: '地理位置權重較高' },
  { id: 'london', label: 'London 45°', note: '拓撲與等距優先' },
  { id: 'moscow', label: 'Moscow Ring', note: '自動偵測跨路線視覺環' },
  { id: 'concentric', label: 'Concentric', note: '同心圓量化' },
  { id: 'hex', label: 'Hex 60°', note: '六方向 / triangular grid' },
];

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
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
  const [dataOpen, setDataOpen] = useState(true);

  const generate = (nextStyle = style) => {
    try {
      const stations = JSON.parse(stationsText) as Station[];
      const lines = JSON.parse(linesText) as TransitLine[];
      if (!Array.isArray(stations) || !Array.isArray(lines)) {
        throw new Error('Stations and lines must both be JSON arrays.');
      }

      const nextGraph = buildGraph({ stations, lines });
      const nextLayout = computeLayout(nextGraph, nextStyle);
      setGraph(nextGraph);
      setLayout(nextLayout);
      setError('');
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
    setError('');
  };

  const selectedStyle = STYLE_OPTIONS.find((option) => option.id === style)!;
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
          <button className="button secondary" onClick={() => setDataOpen((value) => !value)}>
            {dataOpen ? '隱藏資料' : '編輯資料'}
          </button>
          <button className="button secondary" onClick={resetSample}>
            載入範例
          </button>
          <button className="button primary" onClick={() => downloadSvg()}>
            匯出 SVG
          </button>
        </div>
      </header>

      <main className={`workspace ${dataOpen ? '' : 'data-collapsed'}`}>
        {dataOpen ? (
          <aside className="data-panel">
            <section>
              <div className="section-heading">
                <div>
                  <span className="step">01</span>
                  <h2>Stations</h2>
                </div>
                <span>{JSON.parse(stationsText || '[]').length || 0}</span>
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
              <strong>{ringNames.length ? `${ringNames.length} nodes` : '—'}</strong>
              {ringNames.length ? <small>{ringNames.join(' → ')}</small> : null}
            </div>
          </div>
        </section>
      </main>

      <footer>
        <span>V0.1 algorithm baseline</span>
        <span>React · TypeScript · SVG · topology first</span>
      </footer>
    </div>
  );
}
