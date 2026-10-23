# Metro Map Generator

A browser-based schematic transit-map generator that starts from **station coordinates + route order**, including Y-shaped branches and multimodal transfer complexes.

The project is being built as a static React/TypeScript app so it can be hosted directly on GitHub Pages.

## What works in v0.1

- JSON station/route editor
- Excel (`.xlsx` / `.xlsm`) input with Chinese `車站` / `路線` worksheets
- backward-compatible import for English `Stations` / `Lines` worksheets
- downloadable `.xlsm` input template generated in the browser
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

The downloadable template is directly generated as `metro-map-input-template-zh.xlsm`. `轉乘群組 / Transfer Group` automatically generates stable `XFER_###` IDs from repeated coordinates, while `轉乘驗證 / Transfer Validation` checks same-name coordinate consistency.

The XLSM now contains its VBA project directly. When macros are enabled, `Auto_Open` reruns the transfer grouping and validation automatically; `CompleteTransfersAndValidate` can also be run manually from Excel's macro dialog.

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


## Downloadable XLSM template

The deployed app provides a generated `metro-map-input-template-zh.xlsm` containing:

- `車站` — 中文車站輸入與自動轉乘欄位,
- `路線` — 中文路線 / 路徑順序輸入,
- `說明` — 中文使用說明.

The importer accepts both Chinese and English worksheet/header names, so older workbooks remain usable.

There is no separate VBA download. GitHub Actions compiles the VBA source into `vbaProject.bin` and includes it in the deployed XLSM template.


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


## Self-contained XLSM

The download flow is intentionally a single file:

```text
metro-map-input-template-zh.xlsm
```

The workbook contains:

- visible Chinese input sheets,
- legacy-compatible formulas that auto-number repeated-coordinate transfer groups as `XFER_001 / XFER_002 / ...`,
- hidden helper columns used only for stable formula calculation,
- an embedded VBA project compiled during CI,
- `Auto_Open` to refresh transfer groups and validation when macros are enabled,
- `CompleteTransfersAndValidate` for manual reruns.

CI fails if `vbaProject.bin` cannot be compiled, so Pages will not deploy a macro-less XLSM by accident.
