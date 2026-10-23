export async function downloadExcelTemplate() {
  const [{ default: JSZip }, ExcelJS] = await Promise.all([
    import('jszip'),
    import('exceljs'),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Metro Map Generator';
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;

  const stations = workbook.addWorksheet('Stations');
  stations.columns = [
    { header: 'Station ID', key: 'id', width: 14 },
    { header: 'Station Name', key: 'name', width: 24 },
    { header: 'Latitude', key: 'lat', width: 14 },
    { header: 'Longitude', key: 'lon', width: 14 },
    { header: 'Transfer Group', key: 'transferGroup', width: 24 },
    { header: 'Transfer Validation', key: 'transferValidation', width: 30 },
  ];

  const stationRows = [
    ['G01', 'North Depot', 24.205, 120.707],
    ['G02', 'North District', 24.19, 120.699],
    ['G03', 'Songzhu', 24.181, 120.698],
    ['T01', 'Songzhu', 24.181, 120.698],
    ['G04', 'Central Park', 24.165, 120.681],
    ['G05', 'City Hall', 24.154, 120.663],
    ['B03', 'City Hall', 24.154, 120.663],
    ['G07', 'Daqing', 24.119, 120.648],
    ['T05', 'Daqing', 24.119, 120.648],
    ['G08', 'HSR Taichung', 24.112, 120.616],
    ['T06', 'Xinwuri', 24.112, 120.616],
    ['B01', 'Harbor Branch', 24.17, 120.626],
    ['B02', 'University', 24.183, 120.641],
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
        `"OK - Coordinates Match","ERROR - Coordinates Mismatch")))`,
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

  // Highlight coordinate validation failures.
  stations.addConditionalFormatting({
    ref: 'F2:F500',
    rules: [
      {
        type: 'expression',
        formulae: ['LEFT(F2,5)="ERROR"'],
        style: {
          fill: {
            type: 'pattern',
            pattern: 'solid',
            bgColor: { argb: 'FFFECACA' },
            fgColor: { argb: 'FFFECACA' },
          },
          font: {
            color: { argb: 'FF991B1B' },
            bold: true,
          },
        },
      },
      {
        type: 'expression',
        formulae: ['LEFT(F2,2)="OK"'],
        style: {
          fill: {
            type: 'pattern',
            pattern: 'solid',
            bgColor: { argb: 'FFDCFCE7' },
            fgColor: { argb: 'FFDCFCE7' },
          },
          font: {
            color: { argb: 'FF166534' },
            bold: true,
          },
        },
      },
    ],
  });

  const lines = workbook.addWorksheet('Lines');
  lines.columns = [
    { header: 'Line ID', key: 'lineId', width: 14 },
    { header: 'Line Name', key: 'lineName', width: 22 },
    { header: 'Color', key: 'color', width: 14 },
    { header: 'Path ID', key: 'pathId', width: 14 },
    { header: 'Sequence', key: 'sequence', width: 10 },
    { header: 'Station ID', key: 'stationId', width: 14 },
  ];

  [
    ['GREEN', 'Metro Green', '#16a34a', 'main', 1, 'G01'],
    ['GREEN', 'Metro Green', '#16a34a', 'main', 2, 'G02'],
    ['GREEN', 'Metro Green', '#16a34a', 'main', 3, 'G03'],
    ['GREEN', 'Metro Green', '#16a34a', 'main', 4, 'G04'],
    ['GREEN', 'Metro Green', '#16a34a', 'main', 5, 'G05'],
    ['GREEN', 'Metro Green', '#16a34a', 'main', 6, 'G07'],
    ['GREEN', 'Metro Green', '#16a34a', 'main', 7, 'G08'],
    ['RAIL', 'Regional Rail', '#2563eb', 'main', 1, 'T01'],
    ['RAIL', 'Regional Rail', '#2563eb', 'main', 2, 'T05'],
    ['RAIL', 'Regional Rail', '#2563eb', 'main', 3, 'T06'],
    ['ORANGE', 'Orange Line', '#f97316', 'main', 1, 'B01'],
    ['ORANGE', 'Orange Line', '#f97316', 'main', 2, 'B02'],
    ['ORANGE', 'Orange Line', '#f97316', 'main', 3, 'B03'],
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
    'Metro Map Generator - XLSM Input Template',
    'Stations 的 A-D 欄是使用者輸入欄位；E-F 欄由公式自動完成。',
    '同一個實體轉乘站請重複列出，每條路線保留自己的 Station ID。',
    '例如 G05 / B03 都叫 City Hall，且經緯度必須完全一致。',
    'Transfer Group：同名站出現 2 次以上時，自動填入 Station Name。',
    'Transfer Validation：同名站經緯度全部一致時顯示 OK，否則顯示 ERROR。',
    '網站匯入時仍會再次驗證同名站經緯度，避免錯誤資料進入路網。',
    'Lines 工作表使用 Line ID / Path ID / Sequence / Station ID 描述路線與 Y 型支線。',
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
  // to macro-enabled OOXML so the download is a true .xlsm container.
  const xlsxBuffer = await workbook.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(xlsxBuffer);
  const contentTypesFile = zip.file('[Content_Types].xml');

  if (!contentTypesFile) {
    throw new Error('Excel template package is missing [Content_Types].xml.');
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
  anchor.download = 'metro-map-input-template.xlsm';
  anchor.click();
  URL.revokeObjectURL(url);
}
