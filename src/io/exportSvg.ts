export interface ExpectedSvgRoute {
  id: string;
  pathCount: number;
}

function verifyPathInsideViewBox(
  path: SVGPathElement,
  svg: SVGSVGElement,
): string | null {
  const viewBox = svg.viewBox.baseVal;
  if (!viewBox || viewBox.width <= 0 || viewBox.height <= 0) {
    return 'invalid SVG viewBox';
  }

  try {
    const box = path.getBBox();
    const tolerance = 0.5;
    const outside =
      box.x < viewBox.x - tolerance ||
      box.y < viewBox.y - tolerance ||
      box.x + box.width > viewBox.x + viewBox.width + tolerance ||
      box.y + box.height > viewBox.y + viewBox.height + tolerance;

    return outside ? 'geometry outside viewBox' : null;
  } catch {
    // Some browsers can temporarily deny getBBox() while a document is
    // transitioning. The structural/d-path validation below still applies.
    return null;
  }
}

function verifySvgCompleteness(
  svg: SVGSVGElement,
  expectedRoutes: ExpectedSvgRoute[],
) {
  const failures: string[] = [];

  if (svg.dataset.layoutValid !== 'true') {
    failures.push('layout integrity flag is not valid');
  }

  const routeGroups = Array.from(
    svg.querySelectorAll<SVGGElement>(
      '#lines > g[data-line-id][data-path-count]',
    ),
  );
  const routeMap = new Map(
    routeGroups.map((group) => [group.dataset.lineId ?? '', group]),
  );

  for (const route of expectedRoutes) {
    const group = routeMap.get(route.id);
    if (!group) {
      failures.push(`${route.id}: missing route group`);
      continue;
    }

    const declaredPathCount = Number(group.dataset.pathCount);
    if (declaredPathCount !== route.pathCount) {
      failures.push(
        `${route.id}: group declares ${declaredPathCount}/${route.pathCount} paths`,
      );
    }

    const paths = Array.from(
      group.querySelectorAll<SVGPathElement>('path[data-path-index]'),
    );

    if (paths.length !== route.pathCount) {
      failures.push(
        `${route.id}: rendered ${paths.length}/${route.pathCount} paths`,
      );
    }

    const indexes = new Set<number>();

    for (const path of paths) {
      const pathIndex = Number(path.dataset.pathIndex);
      indexes.add(pathIndex);

      const d = path.getAttribute('d')?.trim() ?? '';
      if (!d || !/[LlQqCcAa]/.test(d)) {
        failures.push(
          `${route.id} path ${pathIndex}: empty or non-drawable path data`,
        );
        continue;
      }

      const boundsFailure = verifyPathInsideViewBox(path, svg);
      if (boundsFailure) {
        failures.push(
          `${route.id} path ${pathIndex}: ${boundsFailure}`,
        );
      }
    }

    for (let index = 0; index < route.pathCount; index += 1) {
      if (!indexes.has(index)) {
        failures.push(`${route.id}: missing path index ${index}`);
      }
    }
  }

  const expectedIds = new Set(expectedRoutes.map((route) => route.id));
  for (const lineId of routeMap.keys()) {
    if (!expectedIds.has(lineId)) {
      failures.push(`unexpected route group: ${lineId}`);
    }
  }

  const expectedPathTotal = expectedRoutes.reduce(
    (sum, route) => sum + route.pathCount,
    0,
  );
  const renderedPathTotal = svg.querySelectorAll(
    '#lines path[data-line-id][data-path-index]',
  ).length;

  if (renderedPathTotal !== expectedPathTotal) {
    failures.push(
      `rendered path total ${renderedPathTotal}/${expectedPathTotal}`,
    );
  }

  if (failures.length) {
    throw new Error(
      `SVG export validation failed: ${failures.slice(0, 10).join('; ')}` +
        (failures.length > 10
          ? `; +${failures.length - 10} more`
          : ''),
    );
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

  const detailZoom = Math.max(
    0.25,
    Number(svg.dataset.detailZoom || '1'),
  );
  const viewBox = svg.viewBox.baseVal;
  clone.setAttribute(
    'width',
    String(Math.round(viewBox.width * detailZoom)),
  );
  clone.setAttribute(
    'height',
    String(Math.round(viewBox.height * detailZoom)),
  );
  clone.setAttribute('data-export-detail-zoom', String(detailZoom));

  const metadata = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'metadata',
  );
  metadata.textContent = JSON.stringify({
    generator: 'metro-map-generator',
    exportedAt: new Date().toISOString(),
    routeCount: expectedRoutes.length,
    pathCount: expectedRoutes.reduce(
      (sum, route) => sum + route.pathCount,
      0,
    ),
    routes: expectedRoutes,
    detailZoom,
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

  const style = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'style',
  );
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);

  const content =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    new XMLSerializer().serializeToString(clone);
  const blob = new Blob(
    [content],
    { type: 'image/svg+xml;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'metro-map.svg';
  anchor.click();
  URL.revokeObjectURL(url);
}
