# Algorithm notes

This project separates **topology**, **layout geometry**, and **rendering geometry**.

## Data model

Input routes keep their original station order and may contain multiple paths for Y-shaped branches. Stations may declare a shared `complexId`; all stations in the same complex become one topology node. This is necessary for multimodal rings such as a metro corridor plus a regional-rail corridor that close a cycle only through transfer complexes.

## Current baseline (v0.1)

### Geographic projection

Latitude/longitude is first transformed to a local equirectangular plane around the network centroid, then fitted into the SVG canvas. Geographic coordinates are retained as the layout anchor.

### Taipei / London 45°

Both modes currently share an iterative octilinear relaxation baseline:

1. Start from projected geographic positions.
2. For each graph edge, snap the current edge heading to the nearest 45° direction.
3. Estimate a desired edge length.
4. Accumulate candidate positions from adjacent edges.
5. Blend candidates with the original geographic anchor.
6. Repeat with cooling.

Taipei uses a stronger geography anchor. London uses a weaker geography anchor and stronger equal-spacing pressure.

This is intentionally the **interactive baseline**, not the final exact optimizer. The next quality layer is a candidate-grid router using A*/shortest path plus crossing, bend, spacing and obstacle costs.

### Hex 60°

The 60° mode uses the same relaxation framework but snaps to six directions on a triangular/hexilinear axis system.

### Moscow ring-radial

Moscow mode does **not** ask whether one route is a loop. It searches the union transit graph for bounded simple cycles. Transfer records sharing a `complexId` are merged first, so a ring may be composed of multiple routes or transport modes.

Every candidate is scored with inspectable metrics:

- geographic enclosed area relative to the whole network,
- polygon fill/shape quality,
- ellipse aspect quality,
- radial consistency,
- outward radial connections,
- cycle node coverage,
- minimum route-switch count around the closed cycle.

Route diversity itself is not a requirement and is not rejected: a two-service ring is valid, but excessive route switching is penalized. The selected cycle is regularized to an ellipse while preserving cycle order. Non-ring nodes are assigned inward or outward radial positions according to geography and graph-hop distance from the ring.

Cycle enumeration is bounded because enumerating all simple cycles can grow exponentially. A future quality pass should add biconnected-component decomposition, minimum/chordless cycle candidates and disjoint-path ring candidates, plus manual ring override.

### Concentric

Concentric mode quantizes each station's radial distance from the geographic centroid onto a small number of rings while preserving geographic angle. The current renderer still connects nodes with rounded polylines. True arc+spoke orthoradial routing is a planned next step.

## Shared-route offset

Topology edges record all route IDs using that edge. Rendering then computes a stable offset per route and applies the segment-normal displacement before rounded-corner path generation.

This is separated from line ordering. The current ordering is deterministic by route ID; a later pass will minimize line crossings at junctions (MLCM-style ordering).

## Hard invariants

Layout code must never:

- reorder stations inside an input path,
- silently delete a branch,
- connect unrelated station complexes,
- change route membership,
- collapse distinct topology nodes merely because they overlap visually.

## Planned quality optimizer

The target cost function is:

```text
Cost =
    Wgeo      * geographic distortion
  + Wangle    * angular error
  + Wbend     * bend cost
  + Wcross    * crossing cost
  + Wspacing  * station spacing error
  + Wlength   * path length cost
  + Wbundle   * shared-corridor cost
  + Wlabel    * label collision
```

The browser UI can keep the current fast relaxation for live preview while a Web Worker runs the quality optimizer.
