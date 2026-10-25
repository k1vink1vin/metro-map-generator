# Layout and rendering review (2026-10-24)

## Design evidence

- [KIT: Metro Maps](https://i11www.iti.kit.edu/en/projects/geovis/metro): input topology, minimum edge length and octolinearity are hard criteria; bends and geographical similarity are optimization objectives.
- [Nöllenburg and Wolff, Drawing and Labeling High-Quality Metro Maps](https://i11www.iti.kit.edu/extra/publications/nw-dlhqm-10.pdf): jointly optimize geometry and labels under hard constraints. The application uses heuristics, not this paper's exact mixed-integer solver.
- [TfL: Our brand assets](https://madeby.tfl.gov.uk/2024/06/07/our-brand-assets/): horizontal, vertical and 45-degree lines, with clear interchange points.
- [London Museum: Harry Beck](https://www.londonmuseum.org.uk/collections/london-stories/harry-beck-revolutionised-tube-map/): schematic circuit-like geometry and tight curves, rather than literal distances.
- [Taipei Metro official route map](https://www.metro.taipei/cp.aspx?n=73B51F32ED23C5E1): visual reference for local routes, geography and interchange presentation.
- [Moscow Metro, July 2025 design update](https://www.mosmetro.ru/news/details/7469): smooth lines without sharp corners.
- [Nickel and Nöllenburg: multilinear maps](https://arxiv.org/abs/1904.03039): arbitrary direction families are possible; choosing 60 degrees does not by itself guarantee fewer crossings.
- [Batik et al.: shape-guided mixed maps](https://arxiv.org/abs/2208.14261): selected shapes and the remaining network need coordinated deformation and alignment.

These are design references, not official approval of generated maps. Concentric and hexagonal layouts are composition systems, not official city signage specifications.

## Style rules and current implementation

| Layout | Geometry | Geographic treatment | Distinguishing constraints |
| --- | --- | --- | --- |
| Taipei | 45-degree corridor targets; topology sections and anchored endpoints | Strong geography tether | Preserve branch order and transfer identity; clear short zigzags after fitting |
| London | 45-degree corridors; central inflation and near-equal spacing | Weaker geography tether | Topological scaffold, route straightness and interchange readability |
| Moscow | Exact circular arcs on each declared ring; station-interpolating connectors | Separate circle centers and regional placement | Pin ring stations during zigzag reduction; do not force rings to be concentric |
| Concentric | Radial shell targets, cyclic angle spacing | Blend shells with geography to avoid artificial crossings | Shared focus; outer spacing and topology take precedence over perfect shell snapping |
| Hex | Three undirected axes: 0/60/120 degrees | Moderate geography tether | Corridor-based zigzag reduction, shared topology and station clearance |

The angular solvers still have nonzero direction error: station relaxation and topology protection are soft compromises. They are not exact octilinear/hexilinear constraint solvers. Concentric is a shell-guided compromise, not a guarantee that every station lies exactly on a quantized radius. Taipei currently has no georeferenced river input or river deformation model; no invented Tamsui River is drawn. London still uses geography as an initial scaffold, not a geography-free graph embedding. These limits must not be described as fully compliant style engines.

## Defects found

1. The previous `roundedPath` replaced each station vertex with a quadratic corner, cutting away from the station. Completeness QA checked IDs and coordinates, not whether the rendered line actually passed through a station.
2. Moscow stations were circular but the route and halo between stations were rounded polygon chords. Radius CV at stations alone could not detect this.
3. Smoothing was unvalidated against neighboring topology edges and could create visual connectivity ambiguities.
4. Short zigzags survived because optimization ran before passenger-canvas scaling. A small coordinate shift can be a large visible saw-tooth.
5. Tokyo suffixes were rendered as small separate annotations rather than the complete lower-row code requested by the user.
6. SVG QA files lacked the SVG namespace, so opening them directly in a browser produced an XML tree rather than the map.

## Changes

- Interpolate station anchors with bounded cubic controls; shorter neighboring edges limit handles. Reject sampled smoothing candidates that introduce crossings against nonincident topology edges or reduce clearance at unrelated station markers. Unsafe smoothing falls back to the original straight segment.
- Render ring edges with SVG `A` arcs and ring halos with `circle`. Recover each circle from non-collinear station coordinates after fitting. Check all ring stations against that circle before using it; preserve separate centers.
- Apply an additional topology-aware four-station zigzag pass in display coordinates to Taipei/London/Hex. Preserve at least 50-unit spacing for moved London/Hex stations. Clear Moscow non-ring zigzags in display coordinates with all ring stations pinned. Clear local concentric zigzags conservatively in display coordinates.
- Cache route geometry by immutable layout identity. Zoom and station-symbol changes reuse the same route geometry.
- Keep station code backgrounds white for Taipei/Tokyo; show complete numeric suffix on one baseline. Keep Osaka codes horizontal.
- Add regression tests for station interpolation, exact rendered ring radius, independent centers and degenerate inputs. Render QA checks sampled route self-crossings, in addition to all 24 layout/symbol combinations.

## Acceptance and limits

Run `npm run build`, `npm run qa:geometry`, `npm run qa:layouts`, and `npm run qa:render`. Review full maps and crowded details separately. Rendered curves are sampled for intersection checks; this is a numerical regression test, not a mathematical proof of continuous-curve planarity. Existing inter-route crossings are not automatically transfers. Circular arcs can differ from the polygon crossings measured by layout QA. Font metrics, labels against all rendered lines, accessible contrast, print scale and operator signage rules still require a dedicated publication review.

Do not equate a green CI run, radius CV at stations, or a low crossing count with passenger-ready official signage. Report actual measured improvements and remaining defects.

## Measured result on repository TPE_Metro.xlsm

247 topology nodes, 275 edges, 12 routes, two declared Moscow rings. Compared with checkout `f8a3eac` (before this change):

| Layout | Sharp turns before → after | Zigzags before → after | Self-crossings after | Crossings after | Minimum station distance after |
| --- | --- | --- | --- | --- | --- |
| Taipei | 21 → 8 | 26 → 11 | 0 | 2 | 29.0 |
| London | 55 → 37 | 94 → 48 | 0 | 9 | 50.2 |
| Moscow | 20 → 8 | 47 → 10 | 0 | 12 | 36.4 |
| Concentric | 55 → 47 | 61 → 38 | 0 | 19 | 52.2 |
| Hex | 62 → 35 | 112 → 64 | 0 | 5 | 50.2 |

These are station-center polyline measurements, not counts of visibly sharp corners after interpolation. Sharp turns mean heading changes above 100 degrees; zigzags require adjacent turns of opposite signs above 24 degrees. The two Moscow centers remain 1161.1 display units apart. Angular mean error remains 5.6 degrees (Taipei), 6.8 degrees (London), and 8.2 degrees (Hex); exact direction-family compliance is still incomplete.

Validation: production build, geometry regression tests, layout QA, 24 rendered SVG combinations, and a targeted four-symbol Moscow re-render after adding parallel circular lanes. Browser review covered the 24-output overview, full Moscow map, style selection and generation. This is an overview and representative-detail review, not a claim that every label at every print scale has received manual approval.

## Second review: sharp turns and Moscow geographic order

The first release still had visibly tight London/Hex corners and actual Moscow geographic inversions. Its north/east percentage was insufficient evidence of geographic correctness.

London and Hex now solve complete topology sections before a longer-range corner relaxation in final display units. Section moves protect route self-crossings and external crossings. Rendering uses longer bounded interpolation handles (0.38 rather than 0.18), retaining collision checks and straight fallbacks. Eliminating all interior shape controls was tested and rejected: it increased sharp turns and reduced London station spacing. Two major controls remain per section.

Compared with `a332218`, station-center sharp-turn counts improve from 37 to 12 for London, and 35 to 10 for Hex. These are not zero; station-center polyline counters are distinct from the actual interpolated SVG curves. Do not describe this as proof that every angular or curvature constraint is met.

Moscow now gives independent circles more room in the geographic frame, optimizes their rotation and individual station angles against significant geographic ordering, and pins those stations during non-ring corrections. Non-ring ordering is repaired only with station-clearance and route-crossing checks; short corridors can move atomically when an individual station cannot move safely. The passenger canvas grows to preserve readable station spacing instead of allowing the larger geographic frame to shrink all markers together.

`qa:geography` compares 48,179 north/south and east/west relationships, using the existing 45-unit significance threshold in the original geographic projection. For this workbook, that is approximately 2.7945 km on either axis. The accepted result has zero inversions in those comparisons. It does NOT certify exact geographic distances, nearest-neighbor directions, or ordering of pairs below that threshold. The full report is `qa-artifacts/moscow-geography.json`, uploaded alongside SVGs by CI. Any significant inversion fails the new test.

The accepted Moscow result retains independent perfect circles, zero route self-crossings, one inter-route crossing and minimum station spacing 32.2 display units. Exact rendered circular arcs remain separately regression-tested. Build, geometry tests, geographic-order test and the 24-combination render test are required before deployment. Angular layouts remain heuristic and have nonzero mean axis error.

## Third review: eliminate remaining acute angular corners

The second review reduced acute turns but left 12 London and 10 Hex station-center heading changes above 100 degrees. The previous midpoint-only relaxer can stall at interchanges: different route directions cancel in the average, and scoring only the moved station can transfer a kink to its neighbor.

The new local search considers each route midpoint and a two-dimensional neighborhood. It scores all affected station occurrences and only accepts candidates that improve the neighborhood, preserve at least 40 display-unit station separation, do not increase incident crossings, and do not introduce route self-crossings. On the canonical workbook, London and Hex now have zero heading changes above 100 degrees. CI's acute-turn budgets are zero for both styles, rather than accepting a smaller nonzero count. This metric still permits normal schematic corners; it is not a claim that every curve has an operator-approved minimum radius.

Smaller positive interpolation handles are tried before falling back to a straight segment, reducing abrupt joins where larger curves conflict with nearby routes. Existing curve-crossing and station-clearance checks remain active.

The specifically requested Huilong/Taoyuan check is now independent of the 45-unit geographic significance threshold:

| Station | Latitude | Longitude | SVG x | SVG y |
| --- | --- | --- | --- | --- |
| 迴龍 (O21/LG21) | 25.021862 | 121.411270 | 2092.6281 | 2481.0544 |
| 桃園車站 (GR07) | 24.9887887 | 121.3136967 | 1628.6149 | 2774.6531 |

Huilong is northeast of Taoyuan Station in both the workbook and the actual exported SVG (SVG y increases downward). This pair was already correctly ordered in `826d80ed`; no station coordinates were changed merely to agree with the reported suspicion. `qa:geography` now explicitly asserts both axes for this pair. Render QA also writes `moscow--huilong-taoyuan-detail.svg`, a crop of the full map with the two actual station anchors highlighted. Schematic distances and bearings are not exact survey geometry.

## Passenger route review: excessive bending after acute-angle repair

The previous zero >100-degree-turn result was insufficient. London still had
35 alternating bends and Hex 42. This is not equivalent to passenger-signage
quality. London Museum describes Beck's diagram as straight horizontal,
vertical and 45-degree lines joined by local curves:
https://www.londonmuseum.org.uk/collections/london-stories/harry-beck-revolutionised-tube-map/

Changes in this review:
- Refine all route bends, not only acute vertices. Score the affected route
  neighborhood, penalise total turning and squared turn magnitude, retain
  angular attraction, and bound station displacement to 120 display units.
- Each accepted move retains station clearance and does not increase incident
  edge crossings or route self-crossings. Graph identities, paths, station
  sequence and interchange grouping are unchanged.
- London/Hex SVG corridors now have straight portions and short, tangent
  continuous cubic transitions through station anchors. Moscow circle arcs
  are unchanged. Smoothing still undergoes obstacle and sampled crossing tests.
- Add near-marker label positions, include the station's own marker in
  obstacle tests, and revisit initial greedy choices against the complete
  label set. Keep names near stations rather than pushing them far away.

Canonical TPE_Metro.xlsm measurements (heading changes between station anchors):

| Metric | London before | London after | Hex before | Hex after |
| --- | ---: | ---: | ---: | ---: |
| Maximum turn | 99.1° | 55.7° | 99.5° | 59.8° |
| Turns >70° | 19 | 0 | 29 | 0 |
| Alternating adjacent turns, both >24° | 35 | 1 | 42 | 2 |
| Sum of absolute turns | 7674° | 2642° | 8344° | 2846° |
| Route self-crossings | 0 | 0 | 0 | 0 |

Remaining alternating bends: Danhai's 新市一路–淡水行政中心–濱海濱海義山–濱海沙崙
in both styles; 古亭–中正紀念堂–小南門–西門 in Hex. The duplicated character
sequence in 濱海濱海義山 is from the workbook, not silently renamed here.

Regression gates now require no >70° turns and total turning <=3000° in these
canonical London/Hex outputs, and at most 1/2 alternating bends respectively.
These are project regression thresholds, not a transit operator's specification.
Angular attraction remains heuristic (mean axis errors 9.9°/12.4°); exact
45°/60° grids, uniformly spaced stations, globally collision-free labels and
operator-approved signage are NOT certified by these tests. The geographic,
Taipei, Moscow and concentric geometry have not been redesigned in this pass.
