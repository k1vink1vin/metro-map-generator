export interface ExpectedSvgRoute {
  id: string;
  pathCount: number;
}

function verifySvgCompleteness(
  svg: SVGSVGElement,
  expectedRoutes: ExpectedSvgRoute[],
) {
  const routeGroups = Array.from(
    svg.querySelectorAll<SVGGElement>('g[data-line-id][data-path-count]'),
  );
  const routeMap = new Map(
    routeGroups.map((group) => [group.dataset.lineId ?? '', group]),
  );

  const missing: string[] = [];
  const incomplete: string[] = [];

  for (const route of expectedRoutes) {
    const group = routeMap.get(route.id);
    if (!group) {
      missing.push(route.id);
      continue;
    }

    const paths = Array.from(group.querySelectorAll<SVGPathElement>('path[data-path-index]'));
    if (paths.length !== route.pathCount) {
      incomplete.push(`${route.id} (${paths.length}/${route.pathCount} paths)`);
    }
  }

  if (routeMap.size !== expectedRoutes.length) {
    const expected = new Set(expectedRoutes.map((route) => route.id));
    for (const id of routeMap.keys()) {
      if (!expected.has(id)) incomplete.push(`unexpected route ${id}`);
    }
  }

  if (missing.length || incomplete.length) {
    const details = [
      missing.length ? `missing routes: ${missing.join(', ')}` : '',
      incomplete.length ? `path mismatch: ${incomplete.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');

    throw new Error(`SVG export validation failed: ${details}`);
  }
}

export function downloadSvg(
  elementId = 'metro-map-svg',
  expectedRoutes: ExpectedSvgRoute[] = [],
) {
  const svg = document.getElementById(elementId);
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error('SVG map is not available.');
  }

  verifySvgCompleteness(svg, expectedRoutes);

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const metadata = document.createElementNS('http://www.w3.org/2000/svg', 'metadata');
  metadata.textContent = JSON.stringify({
    generator: 'metro-map-generator',
    exportedAt: new Date().toISOString(),
    routes: expectedRoutes,
  });
  clone.insertBefore(metadata, clone.firstChild);

  const css = Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((rule) => rule.cssText);
      } catch {
        return [];
      }
    })
    .join('\n');

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);

  const content =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    new XMLSerializer().serializeToString(clone);
  const blob = new Blob([content], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'metro-map.svg';
  anchor.click();
  URL.revokeObjectURL(url);
}
