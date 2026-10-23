# Metro Map Generator

A browser-based schematic transit-map generator that starts from **station coordinates + route order**, including Y-shaped branches and multimodal transfer complexes.

The project is being built as a static React/TypeScript app so it can be hosted directly on GitHub Pages.

## What works in v0.1

- JSON station/route editor
- CSV import for stations and route rows
- downloadable example CSV files in `public/examples/`
- Excel (.xlsx) import with `Stations` and `Lines` worksheets
- latitude/longitude projection
- Y-shaped routes through multiple `paths`
- automatic transfer-station grouping across different station IDs
- optional `complexId` manual override for exceptional transfers
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

Stations may repeat one physical interchange with different IDs:

```json
[
  {
    "id": "G03",
    "name": "Songzhu",
    "lat": 24.181,
    "lon": 120.698
  },
  {
    "id": "T01",
    "name": "Songzhu",
    "lat": 24.1815,
    "lon": 120.699
  }
]
```

The original IDs stay distinct for route input (`G03`, `T01`), but the topology engine automatically groups them into one transfer node because the normalized station name matches and the coordinates are nearby.

`complexId` remains optional as a manual override. Use it when two services refer to the same physical transfer with different names, such as `HSR Taichung` and `Xinwuri`, or to explicitly prevent two nearby same-name records from being merged by assigning different complex IDs.

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
G02,Transfer B,24.1240,120.4570,
T02,Transfer B,24.1242,120.4571,
H01,HSR Taichung,24.1120,120.6160,X_HSR
T06,Xinwuri,24.1110,120.6150,X_HSR
```

The intended input model is **one row per service-specific station ID**, even when several IDs represent the same physical interchange.

Automatic grouping rules are conservative:

- stations within about 25 m are treated as the same physical point,
- stations with the same normalized name within about 450 m are treated as the same transfer complex,
- two different explicit `complexId` values are never auto-merged,
- the same explicit `complexId` always forces grouping.

Routes still reference the original service-specific IDs. The grouping only happens internally when building the union transit graph.

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

The detector ranks all candidate cycles, but it does **not** automatically force the highest-scoring cycle to become the map ring. In Moscow mode, the UI lists detected candidates and the user explicitly chooses which cycle becomes the visual backbone. The top-scoring cycle is only marked as a recommendation.

The UI shows each selected ring's score, route IDs, route-change count, outward connections, area coverage, and station chain.


## Downloadable CSV examples

The deployed app exposes these ready-to-import examples:

- `public/examples/stations.csv`
- `public/examples/lines.csv`

They demonstrate transfer complexes, a Y-shaped branch using multiple `pathId` values, and a composite ring candidate formed across different services.


## Route completeness invariant

Every layout style must preserve the complete transit graph on screen and in SVG export.

The shared post-layout finalizer is applied to Geographic, Taipei 45°, London 45°, Moscow, Concentric and Hex 60°. It:

- repairs any missing/non-finite node position from the geographic reference,
- separates distinct topology nodes that collapse onto the same visible point,
- fits all node geometry into the working canvas,
- validates every route, path and adjacent station segment before rendering.

The SVG renderer then performs a second visibility pass:

- shared topology edges are offset by route,
- accidentally coincident geometric segments from different routes are also bundled and offset,
- the SVG viewBox is calculated from the actual offset route geometry rather than a fixed canvas,
- SVG download is blocked if a route/path is missing, has non-drawable path data, or falls outside the exported viewBox.

This is a hard invariant: a layout that cannot represent every route/path is not considered a valid output.
