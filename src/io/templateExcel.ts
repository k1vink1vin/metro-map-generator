export async function downloadExcelTemplate() {
  const [{ default: JSZip }, ExcelJS] = await Promise.all([
    import('jszip'),
    import('exceljs'),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Metro Map Generator';
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const stations = workbook.addWorksheet('車站');
  stations.columns = [
    { header: '車站編號', key: 'id', width: 14 },
    { header: '車站名稱', key: 'name', width: 24 },
    { header: '緯度', key: 'lat', width: 14 },
    { header: '經度', key: 'lon', width: 14 },
    { header: '轉乘群組', key: 'transferGroup', width: 24 },
    { header: '轉乘驗證', key: 'transferValidation', width: 30 },
  ];

  const stationRows = [
    ['G01', '北機廠', 24.205, 120.707],
    ['G02', '北區', 24.19, 120.699],
    ['G03', '松竹', 24.181, 120.698],
    ['T01', '松竹', 24.181, 120.698],
    ['G04', '中央公園', 24.165, 120.681],
    ['G05', '市政府', 24.154, 120.663],
    ['B03', '市政府', 24.154, 120.663],
    ['G07', '大慶', 24.119, 120.648],
    ['T05', '大慶', 24.119, 120.648],
    ['B01', '港區支線', 24.17, 120.626],
    ['B02', '大學', 24.183, 120.641],
  ];

  stationRows.forEach((row) => stations.addRow(row));

  // A-D are user input. E-F are system-generated formula columns.
  for (let row = 2; row <= 500; row += 1) {
    stations.getCell(row, 5).value = {
      formula:
        `IF(B${row}="","",IF(COUNTIF($B$2:$B$500,B${row})>1,B${row},""))`,
    };

    stations.getCell(row, 6).value = {
      formula:
        `IF(B${row}="","",IF(E${row}="","",` +
        `IF(COUNTIFS($B$2:$B$500,B${row},$C$2:$C$500,C${row},` +
        `$D$2:$D$500,D${row})=COUNTIF($B$2:$B$500,B${row}),` +
        `"正常 - 座標一致","錯誤 - 座標不一致")))`,
    };
  }

  stations.views = [{ state: 'frozen', ySplit: 1 }];
  stations.getRow(1).font = {
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };
  stations.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF111827' },
  };
  stations.getColumn(3).numFmt = '0.000000';
  stations.getColumn(4).numFmt = '0.000000';

  // Distinguish system-generated columns.
  for (let row = 2; row <= 500; row += 1) {
    stations.getCell(row, 5).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF1F5F9' },
    };
    stations.getCell(row, 6).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF1F5F9' },
    };
  }

  const lines = workbook.addWorksheet('路線');
  lines.columns = [
    { header: '路線編號', key: 'lineId', width: 14 },
    { header: '路線名稱', key: 'lineName', width: 22 },
    { header: '顏色', key: 'color', width: 14 },
    { header: '路徑編號', key: 'pathId', width: 14 },
    { header: '順序', key: 'sequence', width: 10 },
    { header: '車站編號', key: 'stationId', width: 14 },
  ];

  [
    ['GREEN', '綠線', '#16a34a', 'main', 1, 'G01'],
    ['GREEN', '綠線', '#16a34a', 'main', 2, 'G02'],
    ['GREEN', '綠線', '#16a34a', 'main', 3, 'G03'],
    ['GREEN', '綠線', '#16a34a', 'main', 4, 'G04'],
    ['GREEN', '綠線', '#16a34a', 'main', 5, 'G05'],
    ['GREEN', '綠線', '#16a34a', 'main', 6, 'G07'],
    ['RAIL', '台鐵', '#2563eb', 'main', 1, 'T01'],
    ['RAIL', '台鐵', '#2563eb', 'main', 2, 'T05'],
    ['ORANGE', '橘線', '#f97316', 'main', 1, 'B01'],
    ['ORANGE', '橘線', '#f97316', 'main', 2, 'B02'],
    ['ORANGE', '橘線', '#f97316', 'main', 3, 'B03'],
  ].forEach((row) => lines.addRow(row));

  lines.views = [{ state: 'frozen', ySplit: 1 }];
  lines.getRow(1).font = {
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };
  lines.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF111827' },
  };

  const notes = workbook.addWorksheet('說明');
  [
    'Metro Map Generator - 中文 XLSM 輸入範本',
    '「車站」工作表 A-D 欄是使用者輸入欄位；E-F 欄由公式自動完成。',
    '同一個實體轉乘站請重複列出，每條路線保留自己的車站編號。',
    '例如 G05 / B03 都叫「市政府」，且經緯度必須完全一致。',
    '「轉乘群組」：同名站出現 2 次以上時，自動填入車站名稱。',
    '「轉乘驗證」：同名站經緯度全部一致時顯示「正常」，否則顯示「錯誤」。',
    '網站匯入時仍會再次驗證同名站經緯度，避免錯誤資料進入路網。',
    '「路線」工作表使用 路線編號 / 路徑編號 / 順序 / 車站編號 描述主線與 Y 型支線。',
    '網站同時相容英文工作表 Stations / Lines 與英文欄位名稱。',
    '此檔案直接下載為 .xlsm，可繼續加入 VBA；另提供 ValidateTransfers.bas。',
  ].forEach((text) => notes.addRow([text]));

  notes.getColumn(1).width = 100;
  notes.getRow(1).font = {
    bold: true,
    color: { argb: 'FFFFFFFF' },
    size: 14,
  };
  notes.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF111827' },
  };

  // ExcelJS generates an XLSX package. Convert the workbook main content type
  // to macro-enabled OOXML so the download is a .xlsm container.
  const xlsxBuffer = await workbook.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(xlsxBuffer);
  const contentTypesFile = zip.file('[Content_Types].xml');

  if (!contentTypesFile) {
    throw new Error('Excel 範本缺少 [Content_Types].xml。');
  }

  const contentTypes = await contentTypesFile.async('string');
  zip.file(
    '[Content_Types].xml',
    contentTypes.replace(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
    ),
  );

  const xlsmBlob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    compression: 'DEFLATE',
  });

  const url = URL.createObjectURL(xlsmBlob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'metro-map-input-template-zh.xlsm';
  anchor.click();
  URL.revokeObjectURL(url);
}
