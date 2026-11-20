export const mapStyles = `
.map-background {
  fill: #ffffff;
}

.taipei-river-path {
  fill: none;
  stroke: #bfdbfe;
  stroke-width: 22;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.62;
  pointer-events: none;
}

.taipei-river-label {
  fill: #5b9bd5;
  stroke: #ffffff;
  stroke-width: 3px;
  paint-order: stroke;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
  pointer-events: none;
}

.moscow-ring-halo {
  fill: none;
  stroke: #d8dee8;
  stroke-width: 16;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.72;
  pointer-events: none;
}

.moscow-ring-halo[data-emphasis="primary"] {
  stroke: #cbd5e1;
  stroke-width: 18;
  opacity: 0.9;
}

.moscow-ring-halo[data-emphasis="secondary"] {
  stroke-width: 11;
  opacity: 0.54;
}

.concentric-guide {
  fill: none;
  stroke: #dbe4ee;
  stroke-width: 1.2;
  stroke-dasharray: 5 9;
  pointer-events: none;
}

.tokyo-badge-shell {
  fill: #9ca3af;
  stroke: #30343b;
}

.tokyo-badge-inner,
.taipei-code-badge {
  fill: #ffffff;
}

.taipei-transfer-shell {
  fill: #9ca3af;
  stroke: #30343b;
}

.station-code-prefix,
.station-code-number {
  fill: #111827;
  stroke: none;
  font-weight: 900;
  dominant-baseline: alphabetic;
  pointer-events: none;
}

.osaka-code-badge {
  stroke: #ffffff;
}

.osaka-code-text {
  fill: #ffffff;
  stroke: none;
  font-weight: 900;
  pointer-events: none;
  dominant-baseline: alphabetic;
  letter-spacing: 0.01em;
}

.osaka-transfer-shell {
  fill: #ffffff;
  stroke: #4b5563;
}

.moscow-station,
.moscow-transfer-ring {
  fill: #ffffff;
}

.moscow-transfer-base {
  fill: #ffffff;
  stroke: #222222;
}

.station-label {
  fill: #111827;
  font-weight: 700;
  paint-order: stroke;
  stroke: #ffffff;
  stroke-width: 2.2px;
  stroke-linejoin: round;
}


.map-svg {
  font-family: Arial, "Noto Sans TC", "Noto Sans CJK TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
}
.tokyo-transfer-shell { fill: #fff; stroke: #30343b; }
.station-anchor { fill: #fff; stroke: #111827; }
.station-leader { stroke: #586372; stroke-width: 1.1; pointer-events: none; }
.map-ink { fill: #111827; }
`;
