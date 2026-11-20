import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const directory = process.env.METRO_ARTIFACTS ?? 'qa-artifacts';
const fixture = JSON.parse(readFileSync(`${directory}/workbook-manifest.json`, 'utf8'));
const styleIds = ['geographic', 'taipei', 'london', 'moscow', 'concentric', 'hex'];
const markerStyles = ['taipei', 'tokyo', 'osaka', 'moscow'];
const requested = process.argv.slice(2);
const names = styleIds.filter(style => !requested.length || requested.includes(style))
  .flatMap(style => markerStyles.map(marker => `${style}--stations-${marker}`));
if (!names.length) throw new Error('No matching workbook layout styles.');
const makePdf = process.env.METRO_PRINT_PDF === '1';
if (makePdf) mkdirSync(`${directory}/print`, { recursive: true });
const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const reports = [];
try {
  for (const name of names) {
    const sourceSvg = readFileSync(`${directory}/${name}.svg`, 'utf8');
    const svg = sourceSvg.replace(/^<\?xml[^>]*>\s*/, '');
    await page.setContent(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><body style="margin:0">${svg}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const audit = await page.evaluate(({ fixture }) => {
      const svg = document.querySelector('svg');
      const view = svg.viewBox.baseVal;
      const rootMatrix = svg.getCTM().inverse();
      function box(element, margin = 0) {
        const b = element.getBBox();
        const m = rootMatrix.multiply(element.getCTM());
        return { x: b.x * m.a + m.e - margin, y: b.y * m.d + m.f - margin,
          w: b.width * m.a + 2 * margin, h: b.height * m.d + 2 * margin };
      }
      function stroke(element) {
        const value = getComputedStyle(element);
        return value.stroke === 'none' ? 0 : Number.parseFloat(value.strokeWidth) / 2;
      }
      function overlaps(a, b) {
        return a.x + a.w > b.x && b.x + b.w > a.x && a.y + a.h > b.y && b.y + b.h > a.y;
      }
      function glyphsOverlap(a, b) {
        if (!overlaps(a, b)) return false;
        if (!a.circle && !b.circle) return true;
        if (a.circle && b.circle) {
          return Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) < (a.w + b.w) / 2 - 0.01;
        }
        const circle = a.circle ? a : b;
        const rect = a.circle ? b : a;
        const cx = circle.x + circle.w / 2;
        const cy = circle.y + circle.h / 2;
        const x = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
        const y = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
        return Math.hypot(cx - x, cy - y) < circle.w / 2 - 0.01;
      }
      const labelElements = [...svg.querySelectorAll('#labels > text')];
      const stationElements = [...svg.querySelectorAll('#stations > g[data-node-id]')];
      const labels = labelElements.map(element => ({ ...box(element, 0.5), id: element.dataset.labelFor }));
      const badges = stationElements.flatMap(element =>
        [...element.querySelectorAll('circle,rect')].map(glyph =>
          ({ ...box(glyph, stroke(glyph)), circle: glyph.localName === 'circle', id: element.dataset.nodeId })),
      );
      const labelsByNode = new Map(labelElements.map(element => [element.dataset.labelFor, element]));
      const stationsById = new Map(stationElements.map(element => [element.dataset.nodeId, element]));
      const missing = [];
      if (svg.dataset.layoutStyle === 'concentric' &&
          svg.dataset.concentricCenter !== fixture.concentricCenterNodeId) missing.push('incorrect concentric centre');
      const badCodes = [];
      for (const station of fixture.stations) {
        const label = labelsByNode.get(station.id);
        const marker = stationsById.get(station.id);
        if (!marker || label?.textContent !== station.name + (station.nameEn ?? '')) missing.push(station.id);
        if (svg.dataset.stationStyle !== 'moscow' && marker) {
          const codes = [...marker.querySelectorAll('[data-station-code]')].map(item => item.dataset.stationCode.replace(/[-_ ]/g, ''));
          for (const code of station.stationIds) {
            if (!codes.includes(code.toUpperCase().replace(/[-_ ]/g, ''))) badCodes.push(code);
          }
        }
      }
      if (labelElements.length !== fixture.stations.length || stationElements.length !== fixture.stations.length) {
        missing.push('station or label count differs from workbook');
      }
      const routeElements = [...svg.querySelectorAll('#lines path[data-path-index]')];
      const routeByKey = new Map(routeElements.map(path => [`${path.dataset.lineId}/${path.dataset.pathIndex}`, path]));
      const expectedPathCount = fixture.routes.reduce((count, route) => count + route.paths.length, 0);
      const badRoutes = fixture.routes.flatMap(route => route.paths.flatMap((path, index) => {
        const drawn = routeByKey.get(`${route.id}/${index}`);
        if (drawn?.dataset.pathId === path.id && drawn.getAttribute('stroke') === path.color && drawn.getTotalLength() > 0) return [];
        return [`${route.id}/${path.id}`];
      }));
      if (routeElements.length !== expectedPathCount || routeByKey.size !== expectedPathCount) {
        badRoutes.push('route path count differs from workbook');
      }

      const labelCollisions = labels.flatMap((a, i) => labels.slice(i + 1).filter(b => overlaps(a, b)).map(b => [a.id, b.id]));
      const markerCollisions = [...new Set(badges.flatMap((a, i) => badges.slice(i + 1)
        .filter(b => a.id !== b.id && glyphsOverlap(a, b)).map(b => [a.id, b.id].sort().join('/'))))];
      const labelMarkerCollisions = labels.filter(label => badges.some(badge => glyphsOverlap(label, badge))).map(label => label.id);
      const outside = [...svg.querySelectorAll('text, #stations rect, #stations circle, #lines path, #station-leaders line, .moscow-ring-halo, .taipei-river-path, .concentric-guide')]
        .filter(element => {
          const b = box(element, stroke(element));
          return b.x < view.x - 0.5 || b.y < view.y - 0.5 || b.x + b.w > view.x + view.width + 0.5 || b.y + b.h > view.y + view.height + 0.5;
        }).map(element => element.dataset.lineId || element.textContent || element.getAttribute('class'));
      const panel = svg.querySelector('#map-legend-panel > rect');
      const panelBox = panel && box(panel);
      const legendCollisions = panelBox ? [...labels, ...badges]
        .filter(item => overlaps(item, panelBox)).map(item => item.id) : [];
      const labelsByCell = new Map();
      const cell = 64;
      const visiblePaths = [...svg.querySelectorAll('#lines path')];
      const referenceDefects = [];
      const guide = svg.querySelector('.concentric-guides > circle');
      const guideKey = svg.querySelector('#concentric-guide-key line');
      if (Boolean(guide) !== Boolean(guideKey) || (guideKey && getComputedStyle(guideKey).strokeDasharray === 'none')) {
        referenceDefects.push('concentric guide legend differs from rendered map');
      }
      if (visiblePaths.some(path => getComputedStyle(path).strokeDasharray !== 'none')) {
        referenceDefects.push('route strokes must be solid');
      }
      let geographicScale = null;
      if (svg.dataset.layoutStyle === 'geographic') {
        const scale = svg.querySelector('#geographic-scale');
        const scaleLine = scale?.querySelector('line');
        const stations = fixture.stations.filter(station => stationsById.has(station.id));
        stations.sort((a, b) => a.lat - b.lat);
        const south = stations[0];
        const north = stations.at(-1);
        if (scaleLine && south && north) {
          const y = station => rootMatrix.multiply(stationsById.get(station.id).getCTM()).f;
          const spanKm = (north.lat - south.lat) * 111.195;
          const km = Number(scale.dataset.km);
          const measuredKm = box(scaleLine).w * spanKm / Math.abs(y(north) - y(south));
          geographicScale = { km, measuredKm };
          if (!(km > 0 && Math.abs(measuredKm / km - 1) < 0.0001)) {
            referenceDefects.push('geographic scale disagrees with projected stations');
          }
        } else {
          referenceDefects.push('geographic scale could not be measured');
        }
      }
      const gap = Math.max(7, ...visiblePaths.map(path => stroke(path))) + 3;
      for (const label of labels) {
        for (let x = Math.floor((label.x - gap) / cell); x <= Math.floor((label.x + label.w + gap) / cell); x++) {
          for (let y = Math.floor((label.y - gap) / cell); y <= Math.floor((label.y + label.h + gap) / cell); y++) {
            const id = `${x}/${y}`;
            const bucket = labelsByCell.get(id) ?? [];
            bucket.push(label);
            labelsByCell.set(id, bucket);
          }
        }
      }

      function segmentHitsBox(a, b, box, margin) {
        let start = 0;
        let end = 1;
        for (const [origin, delta, min, max] of [
          [a.x, b.x - a.x, box.x - margin, box.x + box.w + margin],
          [a.y, b.y - a.y, box.y - margin, box.y + box.h + margin],
        ]) {
          if (Math.abs(delta) < 1e-9) {
            if (origin < min || origin > max) return false;
            continue;
          }
          const entry = (min - origin) / delta;
          const exit = (max - origin) / delta;
          start = Math.max(start, Math.min(entry, exit));
          end = Math.min(end, Math.max(entry, exit));
          if (end < start) return false;
        }
        return true;
      }

      const routeLabelCollisions = new Set();
      const routeLegendCollisions = new Set();
      for (const route of visiblePaths) {
        const lineStroke = stroke(route);
        const lineId = route.closest('[data-line-id]')?.dataset.lineId ?? 'unknown';
        const total = route.getTotalLength();
        let prev = route.getPointAtLength(0);
        for (let part = 3; ; part += 3) {
          const point = route.getPointAtLength(Math.min(part, total));
          for (const label of labelsByCell.get(`${Math.floor(point.x / cell)}/${Math.floor(point.y / cell)}`) ?? []) {
            if (segmentHitsBox(prev, point, label, lineStroke)) routeLabelCollisions.add(`${label.id}/${lineId}`);
          }
          if (panelBox && segmentHitsBox(prev, point, panelBox, lineStroke)) routeLegendCollisions.add(lineId);
          if (part >= total) break;
          prev = point;
        }
      }

      const leaderLabelCollisions = [];
      for (const leader of svg.querySelectorAll('#station-leaders line')) {
        const from = { x: leader.x1.baseVal.value, y: leader.y1.baseVal.value };
        const to = { x: leader.x2.baseVal.value, y: leader.y2.baseVal.value };
        for (const label of labels) {
          if (label.id === leader.dataset.leaderFor) continue;
          if (segmentHitsBox(from, to, label, stroke(leader))) leaderLabelCollisions.push(`${leader.dataset.leaderFor}/${label.id}`);
        }
      }
      const minText = Math.min(...labelElements.map(e => Number.parseFloat(getComputedStyle(e).fontSize)));
      return {
        dimensions: { width: view.width, height: view.height }, minText,
        labels: labels.length, routes: routeElements.length, crossingClips: svg.querySelectorAll('clipPath[id^="crossing-gap-"]').length,
        leaders: new Set([...svg.querySelectorAll('#station-leaders line')].map(line => line.dataset.leaderFor)).size, missing, badCodes, badRoutes,
        labelCollisions, markerCollisions, labelMarkerCollisions, outside, routeLabelCollisions: [...routeLabelCollisions],
        legendPlacement: panel?.parentElement.dataset.placement, legendCollisions,
        routeLegendCollisions: [...routeLegendCollisions], leaderLabelCollisions,
        geographicScale, referenceDefects,
      };
    }, { fixture });
    // A 4.5 mm Chinese em is the minimum for this proof set. Keep the vector
    // page at the correct size instead of squeezing the whole map onto A4.
    const mmPerUnit = 4.5 / audit.minText;
    const pageMm = {
      width: Math.ceil(audit.dimensions.width * mmPerUnit + 20),
      height: Math.ceil(audit.dimensions.height * mmPerUnit + 20),
    };
    let pdfSha256;
    if (makePdf) {
      await page.addStyleTag({ content: `
        @page { size: ${pageMm.width}mm ${pageMm.height}mm; margin: 0; }
        body { margin: 0; width: ${pageMm.width}mm; padding: 10mm; box-sizing: border-box; }
        .map-svg { display: block; width: ${audit.dimensions.width * mmPerUnit}mm; height: ${audit.dimensions.height * mmPerUnit}mm; }
      ` });
      const pdf = await page.pdf({ path: `${directory}/print/${name}.pdf`, preferCSSPageSize: true, printBackground: true });
      pdfSha256 = sha256(pdf);
    }
    const defects = [...audit.missing, ...audit.badCodes, ...audit.badRoutes, ...audit.labelCollisions,
      ...audit.markerCollisions, ...audit.labelMarkerCollisions, ...audit.outside, ...audit.routeLabelCollisions,
      ...audit.legendCollisions, ...audit.routeLegendCollisions, ...audit.leaderLabelCollisions, ...audit.referenceDefects];
    reports.push({ name, svgSha256: sha256(sourceSvg), pdfSha256, ...audit, pageMm, passed: !defects.length });
    console.log(`${name} ${pageMm.width} × ${pageMm.height} mm, ${audit.labels} labels, ${defects.length} defects`);
  }
} finally {
  await browser.close();
}

writeFileSync(`${directory}/print-audit.json`, JSON.stringify({
  workbookSha256: fixture.sha256,
  sourceRevision: process.env.METRO_SOURCE_REVISION,
  maps: reports,
}, null, 2));
if (reports.some(report => !report.passed)) {
  throw new Error(`Print audit failed. See ${directory}/print-audit.json.`);
}
