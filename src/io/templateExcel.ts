type StationTemplateRow = [
  string,
  string,
  number,
  number,
];

function coordinateKey(lat: number, lon: number): string {
  return `${lat.toFixed(7)}|${lon.toFixed(7)}`;
}

function buildSampleTransferCache(rows: StationTemplateRow[]) {
  const counts = new Map<string, number>();
  const nameCoordinates = new Map<string, Set<string>>();

  for (const [, name, lat, lon] of rows) {
    const key = coordinateKey(lat, lon);
    counts.set(key, (counts.get(key) ?? 0) + 1);

    const normalizedName = name.normalize('NFKC').trim().toLocaleLowerCase();
    const coordinates = nameCoordinates.get(normalizedName) ?? new Set<string>();
    coordinates.add(key);
    nameCoordinates.set(normalizedName, coordinates);
  }

  const groupByCoordinate = new Map<string, string>();
  let groupNumber = 1;

  for (const [, , lat, lon] of rows) {
    const key = coordinateKey(lat, lon);
    if ((counts.get(key) ?? 0) <= 1 || groupByCoordinate.has(key)) continue;

    groupByCoordinate.set(
      key,
      `XFER_${String(groupNumber).padStart(3, '0')}`,
    );
    groupNumber += 1;
  }

  return rows.map(([, name, lat, lon]) => {
    const key = coordinateKey(lat, lon);
    const group = groupByCoordinate.get(key) ?? '';
    const normalizedName = name.normalize('NFKC').trim().toLocaleLowerCase();
    const mismatch = (nameCoordinates.get(normalizedName)?.size ?? 0) > 1;

    return {
      key,
      count: counts.get(key) ?? 0,
      transferGroup: group,
      validation: mismatch
        ? '錯誤 - 同名站座標不一致'
        : group
          ? `正常 - ${group}`
          : '',
    };
  });
}

function nextRelationshipId(xml: string): string {
  const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map((match) =>
    Number(match[1]),
  );
  return `rId${Math.max(0, ...ids) + 1}`;
}

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
    { header: '轉乘群組', key: 'transferGroup', width: 18 },
    { header: '轉乘驗證', key: 'transferValidation', width: 30 },
    { header: '_CoordinateKey', key: '_coordinateKey', width: 18 },
    { header: '_CoordinateCount', key: '_coordinateCount', width: 14 },
    { header: '_GroupStart', key: '_groupStart', width: 12 },
    { header: '_GroupNumber', key: '_groupNumber', width: 12 },
  ];

  const stationRows: StationTemplateRow[] = [
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
  const sampleCache = buildSampleTransferCache(stationRows);

  // G:J are hidden helper columns so XFER numbering works in older Excel
  // versions without LET / FILTER / UNIQUE / XMATCH.
  stations.getColumn(7).hidden = true;
  stations.getColumn(8).hidden = true;
  stations.getColumn(9).hidden = true;
  stations.getColumn(10).hidden = true;

  for (let row = 2; row <= 500; row += 1) {
    const cache = sampleCache[row - 2];

    stations.getCell(row, 7).value = {
      formula:
        `IF(OR(C${row}="",D${row}=""),"",TEXT(C${row},"0.0000000")&"|"&TEXT(D${row},"0.0000000"))`,
      result: cache?.key ?? '',
    };

    stations.getCell(row, 8).value = {
      formula:
        `IF(G${row}="","",COUNTIF($G$2:$G$500,G${row}))`,
      result: cache?.count ?? '',
    };

    stations.getCell(row, 9).value = {
      formula:
        `IF(AND(H${row}>1,COUNTIF($G$2:G${row},G${row})=1),1,0)`,
      result:
        cache && cache.count > 1
          ? sampleCache
              .slice(0, row - 2)
              .some((entry) => entry.key === cache.key)
            ? 0
            : 1
          : 0,
    };

    const groupStartsBeforeOrAtRow = sampleCache
      .slice(0, Math.max(0, row - 1))
      .filter(
        (entry, index, all) =>
          entry.count > 1 &&
          all.findIndex((candidate) => candidate.key === entry.key) === index,
      ).length;

    stations.getCell(row, 10).value = {
      formula: `SUM($I$2:I${row})`,
      result: cache ? groupStartsBeforeOrAtRow : 0,
    };

    stations.getCell(row, 5).value = {
      formula:
        `IF(H${row}<2,"","XFER_"&TEXT(INDEX($J$2:$J$500,MATCH(G${row},$G$2:$G$500,0)),"000"))`,
      result: cache?.transferGroup ?? '',
    };

    stations.getCell(row, 6).value = {
      formula:
        `IF(B${row}="","",IF(COUNTIF($B$2:$B$500,B${row})>COUNTIFS($B$2:$B$500,B${row},$C$2:$C$500,C${row},$D$2:$D$500,D${row}),"錯誤 - 同名站座標不一致",IF(E${row}<>"","正常 - "&E${row},"")))`,
      result: cache?.validation ?? '',
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

  const rings = workbook.addWorksheet('莫斯科環');
  rings.columns = [
    { header: '環編號', key: 'ringId', width: 14 },
    { header: '順序', key: 'sequence', width: 10 },
    { header: '車站編號', key: 'stationId', width: 14 },
    { header: '環驗證', key: 'validation', width: 32 },
  ];

  [
    ['RING_1', 1, 'G03', '啟用巨集或匯入網站後檢查'],
    ['RING_1', 2, 'G04', '啟用巨集或匯入網站後檢查'],
    ['RING_1', 3, 'G05', '啟用巨集或匯入網站後檢查'],
    ['RING_1', 4, 'G06', '啟用巨集或匯入網站後檢查'],
    ['RING_1', 5, 'G07', '啟用巨集或匯入網站後檢查'],
    ['RING_1', 6, 'T04', '啟用巨集或匯入網站後檢查'],
    ['RING_1', 7, 'T03', '啟用巨集或匯入網站後檢查'],
    ['RING_1', 8, 'T02', '啟用巨集或匯入網站後檢查'],
  ].forEach((row) => rings.addRow(row));

  for (let row = 2; row <= 100; row += 1) {
    rings.getCell(row, 1).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"RING_1,RING_2,RING_3"'],
    };
  }

  rings.views = [{ state: 'frozen', ySplit: 1 }];
  rings.getRow(1).font = {
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };
  rings.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF7C3AED' },
  };
  const notes = workbook.addWorksheet('說明');
  [
    'Metro Map Generator - 中文 XLSM 輸入範本',
    '「車站」工作表 A-D 欄是使用者輸入欄位；E-F 欄會自動完成。',
    '相同經緯度出現 2 個以上不同 Station ID 時，E 欄會自動產生 XFER_001 / XFER_002...。',
    'XFER 編號依轉乘群組第一次出現的順序產生，與站名無關。',
    '同名站若使用不同經緯度，F 欄會顯示錯誤。',
    '此 XLSM 已內建 VBA：開啟並允許巨集後會自動重新完成轉乘群組與驗證。',
    '若資料修改後想立即重跑，也可從 Excel 巨集清單執行 CompleteTransfersAndValidate。',
    '「路線」工作表仍使用各路線自己的車站編號。',
    '網站 topology 優先使用 XFER ID，因此改站名不會破壞已建立的轉乘關係。',
    '莫斯科風格請在「莫斯科環」工作表定義環；最多 3 個環，每個環以 環編號 + 順序 + 車站編號 列出。',
    '網站匯入後會逐段檢查環是否真的閉合；最後一站必須能直接接回第一站，最多只能使用 RING_1 / RING_2 / RING_3。',
    '網站同時相容英文工作表 Stations / Lines 與英文欄位名稱。',
  ].forEach((text) => notes.addRow([text]));

  notes.getColumn(1).width = 105;
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

  const xlsxBuffer = await workbook.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(xlsxBuffer);

  const vbaProjectUrl = new URL(
    'examples/vbaProject.bin',
    document.baseURI,
  );
  const vbaResponse = await fetch(vbaProjectUrl, {
    cache: 'no-store',
  });

  if (!vbaResponse.ok) {
    throw new Error(
      '內建 VBA 專案尚未部署完成，請重新整理頁面後再下載 XLSM 範本。',
    );
  }

  const vbaProject = await vbaResponse.arrayBuffer();
  if (vbaProject.byteLength < 1024) {
    throw new Error('內建 VBA 專案檔案無效。');
  }

  zip.file('xl/vbaProject.bin', vbaProject);

  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!contentTypesFile) {
    throw new Error('Excel 範本缺少 [Content_Types].xml。');
  }

  let contentTypes = await contentTypesFile.async('string');
  contentTypes = contentTypes.replace(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  );

  if (!contentTypes.includes('/xl/vbaProject.bin')) {
    contentTypes = contentTypes.replace(
      '</Types>',
      '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
    );
  }
  zip.file('[Content_Types].xml', contentTypes);

  const workbookRelsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbookRelsFile) {
    throw new Error('Excel 範本缺少 workbook relationships。');
  }

  let workbookRels = await workbookRelsFile.async('string');
  if (
    !workbookRels.includes(
      'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
    )
  ) {
    const relationshipId = nextRelationshipId(workbookRels);
    workbookRels = workbookRels.replace(
      '</Relationships>',
      `<Relationship Id="${relationshipId}" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>`,
    );
  }
  zip.file('xl/_rels/workbook.xml.rels', workbookRels);

  if (!zip.file('xl/vbaProject.bin')) {
    throw new Error('VBA 專案沒有成功嵌入 XLSM。');
  }

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
