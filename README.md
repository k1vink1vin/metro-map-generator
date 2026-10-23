# Metro Map Generator

A browser-based schematic transit-map generator that starts from **station coordinates + route order**, including Y-shaped branches and multimodal transfer complexes.

The project is being built as a static React/TypeScript app so it can be hosted directly on GitHub Pages.

## What works in v0.1

- JSON station/route editor
- Excel (`.xlsx` / `.xlsm`) input with Chinese `車站` / `路線` worksheets
- backward-compatible import for English `Stations` / `Lines` worksheets
- canonical `TPE_Metro.xlsm` workbook template stored at the repository root
- transfer-coordinate formula validation plus VBA embedded directly in the XLSM
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
    "lat": 24.181,
    "lon": 120.698
  }
]
```

The original IDs stay distinct for route input (`G03`, `T01`), but the topology engine automatically groups them into one transfer node when the normalized station name matches. Duplicate names must use identical coordinates; otherwise generation stops with an explicit validation error.

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


## Excel input format

The primary input is an Excel workbook with Chinese `車站` and `路線` worksheets. English `Stations` / `Lines` sheets remain supported for backward compatibility.

### 車站 / Stations

新版中文範本預設使用：

```text
車站編號,車站名稱,緯度,經度,轉乘群組,轉乘驗證
G05,市政府,24.154,120.663,XFER_001,正常 - XFER_001
B03,市政府,24.154,120.663,XFER_001,正常 - XFER_001
```

英文欄位 `Station ID / Station Name / Latitude / Longitude / Transfer Group / Transfer Validation` 也仍然可以匯入。

One physical interchange may appear multiple times with different service-specific station IDs. Users only edit columns A-D; Transfer Group and Transfer Validation are filled automatically. Transfer Group is a stable topology key such as `XFER_001`, not the station name.

Rules:

- exact duplicate coordinates across multiple station IDs create a transfer group,
- transfer groups use stable IDs such as `XFER_001 / XFER_002`,
- station names are used for validation and display, not as the topology key,
- every same-name transfer candidate must use the same latitude and longitude,
- inconsistent same-name coordinates cause graph generation/import to fail instead of silently averaging them,
- route definitions continue to reference their original station IDs,
- changing a station name does not break a transfer relationship once the XFER ID exists.

The official workbook is `TPE_Metro.xlsm` in the repository root. It is the single source of truth for workbook schema, formulas, VBA, transfer logic and Moscow-ring input.

### 路線 / Lines

新版中文範本預設使用：

```text
路線編號,路線名稱,顏色,路徑編號,順序,車站編號
GREEN,綠線,#16a34a,main,1,G01
GREEN,綠線,#16a34a,main,2,G05
ORANGE,橘線,#f97316,main,3,B03
```

英文欄位 `Line ID / Line Name / Color / Path ID / Sequence / Station ID` 也仍然可以匯入。

Rows are grouped by `Line ID + Path ID` and ordered by `Sequence`. This supports main lines and Y-shaped branches while preserving each service's own station IDs.

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


## Official XLSM template

The website download points directly to the repository-root `TPE_Metro.xlsm`.

Do not generate or maintain a second workbook template in browser code. Any workbook-format change must be made in `TPE_Metro.xlsm` first.

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


## Stable transfer IDs

Transfer topology must not depend on a mutable station name. The preferred model is:

```text
車站編號,車站名稱,緯度,經度,轉乘群組
G05,市政府,24.154,120.663,XFER_001
B03,市政府,24.154,120.663,XFER_001
```

If the user later renames both rows to `市府`, `XFER_001` remains the topology key. The website also auto-generates XFER IDs for repeated coordinates when the transfer column is blank. Existing XFER IDs take precedence, and automatically generated IDs avoid collisions with existing groups.


## Detail scale

The map control is a detail scale rather than a plain bitmap-like zoom.

- Increasing detail scale increases the screen distance between stations and route geometry.
- Route stroke width, station symbols and labels are counter-scaled so they do not grow at the same rate.
- Label collision boxes are recomputed at the current detail scale.
- SVG export preserves the current detail scale by exporting a proportionally larger natural canvas with the same counter-scaled line/station/label sizes.

This is intended to make dense urban cores readable instead of simply magnifying every overlapping element.

## XLSM-defined Moscow rings

Moscow rings are no longer auto-selected from detected cycles. Define them in the `莫斯科環` / `MoscowRings` worksheet:

```text
環編號,順序,車站編號,網站驗證
RING_1,1,G03,
RING_1,2,G04,
RING_1,3,G05,
...
```

Rules:

- maximum 3 rings,
- each ring needs at least 3 distinct topology nodes,
- every consecutive pair must be a real graph edge,
- the last station must connect directly back to the first station,
- ring sequences must not repeat a topology node,
- multiple rings currently cannot share a topology node,
- `RING_1 / RING_2 / RING_3` should be listed in inner-to-outer order.

The embedded VBA validates the ring sheet and marks rows OK/ERROR. The web importer validates again before Moscow layout is generated, so invalid ring definitions cannot silently produce a broken map.




## Passenger-map regression QA

`TPE_Metro.xlsm` is also the fixed regression fixture for layout quality.

CI runs all six styles from the real workbook:

- Geographic
- Taipei 45°
- London 45°
- Moscow
- Concentric
- Hex 60°

For each style it checks station spacing, short segments, non-transfer geometric crossings, angular error where applicable, and a composite passenger-readability score. It also renders six SVG artifacts for visual inspection.

Current baseline requirements are intentionally strict:

- passenger readability score >= 90
- minimum station-to-station distance >= 38 layout units
- short edges <= 6
- zero non-transfer crossings for all styles except Moscow
- Moscow may have at most 4 geometric crossings because the physical Taipei network contains ring/line over-under crossings that are not transfer stations
- 45° / 60° angular error <= 12°

Both CI and GitHub Pages deployment run the workbook QA, so a code change that makes the official Taipei workbook materially less readable will not deploy.
