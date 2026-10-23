# Metro Map Generator

A browser-based schematic transit-map generator that starts from **station coordinates + route order**, including Y-shaped branches and multimodal transfer complexes.

The project is being built as a static React/TypeScript app so it can be hosted directly on GitHub Pages.

## What works in v0.1

- JSON station/route editor
- CSV import for stations and route rows
- Excel (.xlsx) import with `Stations` and `Lines` worksheets
- latitude/longitude projection
- Y-shaped routes through multiple `paths`
- transfer-complex merging through `complexId`
- Geographic reference view
- Taipei-inspired 45° layout
- London-inspired 45° layout
- Hex / 60° layout
- Moscow ring-radial baseline
  - detects cycles in the **union network**, not only single-route loops
  - supports composite rings made from different routes/modes
- Concentric radial placement
- shared-corridor route offsets
- rounded SVG bends
- SVG export with route/path completeness validation
- GitHub Pages deployment workflow

## Input

Stations:

```json
[
  {
    "id": "G03",
    "name": "Songzhu",
    "lat": 24.181,
    "lon": 120.698,
    "complexId": "X_SONGZHU"
  },
  {
    "id": "T01",
    "name": "Songzhu",
    "lat": 24.1815,
    "lon": 120.699,
    "complexId": "X_SONGZHU"
  }
]
```

Two records with the same `complexId` are treated as one transfer node by the topology/layout engine.

Routes:

```json
[
  {
    "id": "GREEN",
    "name": "Metro Green",
    "color": "#16a34a",
    "paths": [
      ["G01", "G02", "G03", "G04", "G05"],
      ["G03", "G04", "G05", "B01", "B02"]
    ]
  }
]
```

Multiple paths let the input describe a Y-shaped network without the generator having to guess the branch topology.

## Development

```bash
npm install
npm run dev
npm run build
```

## Architecture

```text
Input JSON
   ↓
Transfer complexes
   ↓
Union transit graph
   ↓
Projection
   ↓
Layout strategy
   ├─ Geographic
   ├─ Octilinear 45° (Taipei / London presets)
   ├─ Hexilinear 60°
   └─ Ring/radial (Moscow / Concentric)
   ↓
Shared-edge line offset
   ↓
Rounded SVG renderer
   ↓
SVG export
```

See [docs/ALGORITHM.md](docs/ALGORITHM.md) for the current algorithm boundary and planned quality optimizer.

## Important algorithm note

The current 45°/60° implementation is a fast interactive angular-grid relaxation baseline. It preserves topology and gives us a working browser product, but it is **not yet the final A*/candidate-grid quality solver** described in the research plan. That solver will be added as a separate quality optimization stage so the UI can remain responsive.

The Moscow model already uses the correct network-level concept: a visual ring may be formed by several different services, as long as their union graph forms a meaningful cycle through transfer complexes.

## GitHub Pages

The repository includes a Pages workflow. After the first merge to `main`, set **Settings → Pages → Source** to **GitHub Actions** if the repository is not already configured that way.

The Vite base path is set to:

```text
/metro-map-generator/
```


## CSV / Excel import format

### Stations

Use these columns in `Stations.csv` or the Excel worksheet named `Stations`:

```text
id,name,lat,lon,complexId
G01,Station A,24.123,120.456,
G02,Transfer B,24.124,120.457,X_B
T02,Transfer B,24.1242,120.4571,X_B
```

`complexId` is optional. Give records from different services the same `complexId` when they should behave as one transfer complex in topology.

### Lines

Use long-form rows in `Lines.csv` or the Excel worksheet named `Lines`:

```text
lineId,lineName,color,pathId,sequence,stationId
GREEN,Green Line,#16a34a,main,1,G01
GREEN,Green Line,#16a34a,main,2,G02
GREEN,Green Line,#16a34a,branchA,1,G02
GREEN,Green Line,#16a34a,branchA,2,G08
RAIL,Regional Rail,#2563eb,main,1,T02
```

Rows are grouped by `lineId + pathId` and ordered by `sequence`. This lets one line contain multiple paths for Y-shaped branches.

## SVG completeness guarantee

Each route is rendered inside its own SVG group with `data-line-id`, and each route path carries `data-path-index`. Before download, the exporter compares the rendered route/path manifest with the graph model. If any route or path is missing, export is blocked with an error instead of silently producing an incomplete SVG.

## How Moscow ring detection works

Moscow mode searches the **union transit graph**, not individual route loops. Transfer records sharing a `complexId` are merged before cycle detection, so a metro corridor and a railway corridor can jointly form a valid ring.

For every candidate cycle, the current scorer considers:

- geographic enclosed area relative to the whole network,
- polygon fill/shape quality,
- ellipse aspect quality,
- radial consistency,
- number of outward connections (spokes),
- fraction of network nodes on the cycle,
- minimum number of route changes needed to travel around the cycle.

The highest-scoring candidate becomes the visual backbone. The UI shows its score, route IDs, route-change count, outward connections, area coverage, and number of candidate cycles evaluated. Automatic selection is therefore inspectable rather than a hidden `route.isLoop` rule.
