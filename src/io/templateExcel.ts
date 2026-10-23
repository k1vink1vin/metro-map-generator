export async function downloadExcelTemplate() {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Metro Map Generator';
  workbook.created = new Date();

  const stations = workbook.addWorksheet('Stations');
  stations.columns = [
    { header: 'Station ID', key: 'id', width: 14 },
    { header: 'Station Name', key: 'name', width: 24 },
    { header: 'Latitude', key: 'lat', width: 14 },
    { header: 'Longitude', key: 'lon', width: 14 },
  ];

  [
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
  ].forEach((row) => stations.addRow(row));

  stations.views = [{ state: 'frozen', ySplit: 1 }];
  stations.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  stations.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF111827' },
  };
  stations.getColumn(3).numFmt = '0.000000';
  stations.getColumn(4).numFmt = '0.000000';

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
  lines.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  lines.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF111827' },
  };

  const check = workbook.addWorksheet('TransferCheck');
  check.columns = [
    { header: 'Station ID', width: 14 },
    { header: 'Station Name', width: 24 },
    { header: 'Latitude', width: 14 },
    { header: 'Longitude', width: 14 },
    { header: 'Same-name Count', width: 16 },
    { header: 'Same-coordinate Count', width: 20 },
    { header: 'Status', width: 32 },
  ];
  check.views = [{ state: 'frozen', ySplit: 1 }];
  check.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  check.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0F766E' },
  };

  for (let row = 2; row <= 500; row += 1) {
    check.getCell(row, 1).value = { formula: `Stations!A${row}` };
    check.getCell(row, 2).value = { formula: `Stations!B${row}` };
    check.getCell(row, 3).value = { formula: `Stations!C${row}` };
    check.getCell(row, 4).value = { formula: `Stations!D${row}` };
    check.getCell(row, 5).value = {
      formula: `IF(B${row}="","",COUNTIF(Stations!$B$2:$B$500,B${row}))`,
    };
    check.getCell(row, 6).value = {
      formula:
        `IF(B${row}="","",COUNTIFS(Stations!$B$2:$B$500,B${row},` +
        `Stations!$C$2:$C$500,C${row},Stations!$D$2:$D$500,D${row}))`,
    };
    check.getCell(row, 7).value = {
      formula:
        `IF(B${row}="","",IF(E${row}=1,"單一站",` +
        `IF(E${row}=F${row},"OK - 轉乘站座標一致","ERROR - 同名站經緯度不一致")))`,
    };
  }

  const notes = workbook.addWorksheet('說明');
  [
    'Metro Map Generator - Excel Input Template',
    'Stations 工作表固定使用 4 欄：Station ID / Station Name / Latitude / Longitude。',
    '同一個實體轉乘站請重複列出，每條路線保留自己的 Station ID。',
    '例如 G05 / B03 都叫 City Hall，且經緯度必須完全一致。',
    '網站會以同名站自動判斷轉乘站；若同名站經緯度不一致，匯入會報錯。',
    'TransferCheck 工作表會用公式檢查同名站是否使用一致的經緯度。',
    '若要使用 VBA，請先將此檔另存為 .xlsm，再匯入 ValidateTransfers.bas。',
    'Lines 工作表使用 Line ID / Path ID / Sequence / Station ID 描述路線與 Y 型支線。',
  ].forEach((text) => notes.addRow([text]));
  notes.getColumn(1).width = 100;
  notes.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
  notes.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF111827' },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'metro-map-input-template.xlsx';
  anchor.click();
  URL.revokeObjectURL(url);
}
