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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const reports = [];
try {
  for (const name of names) {
    const svg = readFileSync(`${directory}/${name}.svg`, 'utf8').replace(/^<\?xml[^>]*>\s*/, '');
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
      const labelsByCell = new Map();
      const cell = 64;
      const gap = 7;
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
      const routeLabelCollisions = new Set();
      for (const route of routeElements) {
        const lineStroke = stroke(route) + (route.parentElement.querySelector('.route-contrast-casing') ? 1.5 : 0);
        const total = route.getTotalLength();
        for (let part = 0; part < total; part += 3) {
          const { x, y } = route.getPointAtLength(part);
          for (const label of labelsByCell.get(`${Math.floor(x / cell)}/${Math.floor(y / cell)}`) ?? []) {
            if (x > label.x - lineStroke && x < label.x + label.w + lineStroke &&
                y > label.y - lineStroke && y < label.y + label.h + lineStroke) routeLabelCollisions.add(`${label.id}/${route.dataset.lineId}`);
          }
        }
      }
      const minText = Math.min(...labelElements.map(e => Number.parseFloat(getComputedStyle(e).fontSize)));
      return {
        dimensions: { width: view.width, height: view.height }, minText,
        labels: labels.length, routes: routeElements.length, crossingClips: svg.querySelectorAll('clipPath[id^="crossing-gap-"]').length,
        leaders: svg.querySelectorAll('#station-leaders line').length, missing, badCodes, badRoutes,
        labelCollisions, markerCollisions, labelMarkerCollisions, outside, routeLabelCollisions: [...routeLabelCollisions],
      };
    }, { fixture });
    // A 4.5 mm Chinese em is the minimum for this proof set. Keep the vector
    // page at the correct size instead of squeezing the whole map onto A4.
    const mmPerUnit = 4.5 / audit.minText;
    const pageMm = {
      width: Math.ceil(audit.dimensions.width * mmPerUnit + 20),
      height: Math.ceil(audit.dimensions.height * mmPerUnit + 20),
    };
    if (makePdf) {
      await page.addStyleTag({ content: `
        @page { size: ${pageMm.width}mm ${pageMm.height}mm; margin: 0; }
        body { margin: 0; width: ${pageMm.width}mm; padding: 10mm; box-sizing: border-box; }
        .map-svg { display: block; width: ${audit.dimensions.width * mmPerUnit}mm; height: ${audit.dimensions.height * mmPerUnit}mm; }
      ` });
      await page.pdf({ path: `${directory}/print/${name}.pdf`, preferCSSPageSize: true, printBackground: true });
    }
    const defects = [...audit.missing, ...audit.badCodes, ...audit.badRoutes, ...audit.labelCollisions,
      ...audit.markerCollisions, ...audit.labelMarkerCollisions, ...audit.outside, ...audit.routeLabelCollisions];
    if (pageMm.width > 2500 || pageMm.height > 2500) defects.push('proof exceeds 2500 mm at 4.5 mm station font');
    reports.push({ name, ...audit, pageMm, passed: !defects.length });
    console.log(`${name} ${pageMm.width} × ${pageMm.height} mm, ${audit.labels} labels, ${defects.length} defects`);
  }
} finally {
  await browser.close();
}

writeFileSync(`${directory}/print-audit.json`, JSON.stringify({
  workbookSha256: fixture.sha256,
  maps: reports,
}, null, 2));
if (reports.some(report => !report.passed)) {
  throw new Error(`Print audit failed. See ${directory}/print-audit.json.`);
}
