import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright';
import { preview } from 'vite';

async function workbookFile({ blankCoordinate, blankSequence, blankRingSequence } = {}) {
  const workbook = new ExcelJS.Workbook();
  const stations = workbook.addWorksheet('Stations');
  stations.addRow(['Station ID', 'Station Name', 'Latitude', 'Longitude', 'Transfer Validation']);
  stations.addRow(['A01', 'Origin', 0, 0]);
  stations.getCell('E4').value = { formula: '1+1', result: 2 };
  stations.getRow(7).values = ['A02', 'Terminus', 1, blankCoordinate ? undefined : 1];
  const lines = workbook.addWorksheet('Lines');
  lines.addRow(['Line ID', 'Sequence', 'Station ID']);
  lines.addRow(['TEST', 0, 'A01']);
  lines.getRow(5).values = ['TEST', blankSequence ? undefined : 1, 'A02'];
  if (blankRingSequence) {
    const rings = workbook.addWorksheet('MoscowRings');
    rings.addRow(['Ring ID', 'Sequence', 'Station ID']);
    rings.getRow(6).values = ['R1', undefined, 'A01'];
  }
  return {
    name: 'fixture.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  };
}

const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { port } = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${port}${server.config.base}`);

  const svg = page.locator('svg.map-svg');
  const layoutStyle = page.getByLabel('路網風格');
  const error = page.locator('.error-banner');
  const fileInput = page.locator('input[type=file]');
  const imported = page.getByText('Excel 匯入完成', { exact: false });
  const stationEditor = page.getByLabel('Stations JSON');
  const zoom = page.locator('.zoom-readout');
  const source = page.locator('#map-provenance text').first();

  await layoutStyle.selectOption('geographic');
  const originalStations = await stationEditor.inputValue();
  await stationEditor.fill('{invalid');
  await layoutStyle.selectOption('london');
  await error.waitFor();
  assert.equal(await layoutStyle.inputValue(), 'geographic');
  assert.equal(await svg.getAttribute('data-layout-style'), 'geographic');
  assert.match(await source.textContent(), /內建測試資料/);
  await stationEditor.fill(`${originalStations}\n`);
  await layoutStyle.selectOption('london');
  assert.equal(await svg.getAttribute('data-layout-style'), 'london');
  assert.match(await source.textContent(), /手動編輯資料/);
  assert.equal(await error.count(), 0);

  for (const [options, expected] of [
    [{ blankCoordinate: true }, /車站工作表第 7 列/],
    [{ blankSequence: true }, /路線工作表第 5 列/],
    [{ blankRingSequence: true }, /莫斯科環工作表第 6 列/],
  ]) {
    await fileInput.setInputFiles(await workbookFile(options));
    await error.waitFor();
    assert.match(await error.textContent(), expected);
    assert.match(await source.textContent(), /手動編輯資料/);
  }

  // Keep a real file read pending while the user switches layouts.
  const gate = await page.evaluateHandle(() => {
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      File.prototype.arrayBuffer = read;
      return ready.then(() => read.call(this));
    };
    return { release };
  });
  await fileInput.setInputFiles(await workbookFile());
  await page.getByText('正在匯入 Excel…').waitFor();
  await layoutStyle.selectOption('geographic');
  await gate.evaluate(({ release }) => release());
  await gate.dispose();
  await imported.waitFor();
  assert.equal(await svg.getAttribute('data-layout-style'), 'geographic');
  assert.deepEqual(JSON.parse(await stationEditor.inputValue()).map(({ lat, lon }) => [lat, lon]), [[0, 0], [1, 1]]);
  const routeEditor = page.getByLabel('Lines JSON');
  assert.deepEqual(JSON.parse(await routeEditor.inputValue())[0].paths, [['A01', 'A02']]);

  await layoutStyle.selectOption('concentric');
  assert.equal(await svg.getAttribute('data-concentric-center'), null);
  await fileInput.setInputFiles({
    name: 'TPE_Metro (1).xlsm',
    mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    buffer: await readFile(new URL('../TPE_Metro.xlsm', import.meta.url)),
  });
  await imported.waitFor({ timeout: 120_000 });
  assert.match(await svg.locator('#map-heading').textContent(), /中心 台北車站/);
  await layoutStyle.selectOption('geographic');
  assert.equal(await svg.locator('#labels > text').count(), 270);
  assert.equal(await svg.locator('#lines path[data-path-index]').count(), 21);
  const finder = page.getByLabel('定位車站', { exact: true });
  const focus = { label: '台北車站' };
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await zoom.click();
    await finder.selectOption(focus);
    await page.waitForFunction(() => {
      const frame = document.querySelector('.canvas-frame');
      const ring = frame.querySelector('.station-focus-ring')?.getBoundingClientRect();
      const view = frame.getBoundingClientRect();
      return ring && ring.top >= 0 && ring.bottom <= innerHeight &&
        Math.abs(ring.x + ring.width / 2 - view.x - frame.clientWidth / 2) < 2 &&
        Math.abs(ring.y + ring.height / 2 - view.y - frame.clientHeight / 2) < 2;
    });
    const controls = await page.getByRole('group', { name: '地圖細節倍率' }).boundingBox();
    assert.ok(controls.x >= 0 && controls.x + controls.width <= viewport.width);
    const labelPixels = await svg.evaluate(map => Number(map.dataset.labelFontSize) * map.getScreenCTM().a);
    assert.ok(labelPixels >= 13, `Station labels are only ${labelPixels}px at ${viewport.width}px`);
  }
  const scale = Number(await svg.getAttribute('data-detail-zoom'));
  const wheelCancelled = await page.locator('.canvas-frame').evaluate(frame =>
    !frame.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -30, cancelable: true })),
  );
  assert.ok(wheelCancelled, 'Ctrl+wheel must be handled by the map instead of browser zoom');
  await page.waitForFunction(expected =>
    Number(document.querySelector('.map-svg').dataset.detailZoom) === expected, scale + 0.25,
  );

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出 SVG' }).click();
  const download = await downloading;
  const contents = await readFile(await download.path(), 'utf8');
  const exported = await page.evaluate(text => {
    const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
    return {
      tag: root.localName,
      labels: root.querySelectorAll('#labels > text').length,
      paths: root.querySelectorAll('#lines path[data-path-index]').length,
      focus: root.querySelectorAll('.station-focus-ring').length,
      zoom: Number(root.getAttribute('data-export-detail-zoom')),
    };
  }, contents);
  assert.deepEqual(exported, { tag: 'svg', labels: 270, paths: 21, focus: 0, zoom: scale + 0.25 });
  assert.deepEqual(pageErrors, []);
  console.log('Browser QA passed: workbook validation, draft and layout state, desktop/mobile station focus, zoom and SVG download.');
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
