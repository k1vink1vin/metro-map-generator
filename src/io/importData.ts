import type { Worksheet } from 'exceljs';
import type { MoscowRingDefinition, NetworkInput, Station, TransitLine } from '../types';

type RecordRow = Record<string, string>;

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function pick(row: RecordRow, aliases: string[]): string {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];
    if (value != null && value.trim() !== '') return value.trim();
  }
  return '';
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function rowsToRecords(rows: string[][]): RecordRow[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => normalizeHeader(header));
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])),
  );
}

function stationRecordsToStations(records: RecordRow[]): Station[] {
  const meaningfulRecords = records.filter((row) => {
    const id = pick(row, ['id', 'stationId', 'station', '車站編號', '站號', '車站ID']);
    const name = pick(row, ['name', 'stationName', '車站名稱', '站名']);
    const latText = pick(row, ['lat', 'latitude', '緯度']);
    const lonText = pick(row, ['lon', 'lng', 'longitude', '經度']);

    // Ignore preformatted/template rows where only Transfer Group /
    // Transfer Validation formulas exist. A-D are the actual station inputs.
    return Boolean(id || name || latText || lonText);
  });

  return meaningfulRecords.map((row, index) => {
    const id = pick(row, [
      'id',
      'stationId',
      'station',
      '車站編號',
      '站號',
      '車站ID',
    ]);
    const name = pick(row, [
      'name',
      'stationName',
      '車站名稱',
      '站名',
    ]);
    const latText = pick(row, [
      'lat',
      'latitude',
      '緯度',
    ]);
    const lonText = pick(row, [
      'lon',
      'lng',
      'longitude',
      '經度',
    ]);
    const complexId = pick(row, [
      'complexId',
      'transferId',
      'stationComplex',
      'transferGroup',
      'transfer',
      '轉乘群組',
      '轉乘欄位',
      '轉乘',
    ]);

    const lat = Number(latText);
    const lon = Number(lonText);

    if (!id) {
      throw new Error(`車站工作表第 ${index + 2} 列：缺少車站編號。`);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(
        `車站工作表第 ${index + 2} 列：緯度 / 經度必須是數字。`,
      );
    }

    return {
      id,
      name: name || undefined,
      lat,
      lon,
      complexId: complexId || undefined,
    };
  });
}

function lineRecordsToLines(records: RecordRow[]): TransitLine[] {
  type PathBucket = {
    lineId: string;
    lineName: string;
    color: string;
    pathId: string;
    rows: Array<{ sequence: number; stationId: string; rowIndex: number }>;
  };

  const buckets = new Map<string, PathBucket>();

  records.forEach((row, index) => {
    const lineId = pick(row, [
      'lineId',
      'routeId',
      'line',
      'route',
      '路線編號',
      '路線ID',
    ]);
    const lineName = pick(row, [
      'lineName',
      'routeName',
      'name',
      '路線名稱',
      '路線名',
    ]);
    const color =
      pick(row, [
        'color',
        'lineColor',
        'routeColor',
        '顏色',
        '路線顏色',
      ]) || '#64748b';
    const pathId =
      pick(row, [
        'pathId',
        'branchId',
        'path',
        'branch',
        '路徑編號',
        '分支編號',
      ]) || 'main';
    const stationId = pick(row, [
      'stationId',
      'station',
      '車站編號',
      '站號',
    ]);
    const sequenceText = pick(row, [
      'sequence',
      'seq',
      'order',
      'stationOrder',
      '順序',
      '站序',
    ]);
    const sequence = Number(sequenceText);

    if (!lineId) {
      throw new Error(`路線工作表第 ${index + 2} 列：缺少路線編號。`);
    }
    if (!stationId) {
      throw new Error(`路線工作表第 ${index + 2} 列：缺少車站編號。`);
    }
    if (!Number.isFinite(sequence)) {
      throw new Error(`路線工作表第 ${index + 2} 列：順序必須是數字。`);
    }

    const key = `${lineId}::${pathId}`;
    const bucket = buckets.get(key) ?? {
      lineId,
      lineName,
      color,
      pathId,
      rows: [],
    };
    if (!bucket.lineName && lineName) bucket.lineName = lineName;
    if ((!bucket.color || bucket.color === '#64748b') && color) bucket.color = color;
    bucket.rows.push({ sequence, stationId, rowIndex: index + 2 });
    buckets.set(key, bucket);
  });

  const lineMap = new Map<string, TransitLine>();

  for (const bucket of buckets.values()) {
    bucket.rows.sort((a, b) => a.sequence - b.sequence || a.rowIndex - b.rowIndex);
    const path = bucket.rows.map((row) => row.stationId);
    if (path.length < 2) {
      throw new Error(`Line ${bucket.lineId}, path ${bucket.pathId}: at least two stations are required.`);
    }

    const existing = lineMap.get(bucket.lineId);
    if (existing) {
      existing.paths.push(path);
    } else {
      lineMap.set(bucket.lineId, {
        id: bucket.lineId,
        name: bucket.lineName || bucket.lineId,
        color: bucket.color || '#64748b',
        paths: [path],
      });
    }
  }

  return [...lineMap.values()];
}


function ringRecordsToDefinitions(records: RecordRow[]): MoscowRingDefinition[] {
  type RingRow = { sequence: number; stationId: string; rowIndex: number };
  const rings = new Map<string, RingRow[]>();

  records.forEach((row, index) => {
    const ringId = pick(row, ['ringId', 'ring', '環編號', '環ID']);
    const stationId = pick(row, ['stationId', 'station', '車站編號', '站號']);
    const sequenceText = pick(row, ['sequence', 'seq', 'order', '順序', '站序']);

    if (!ringId && !stationId && !sequenceText) return;
    if (!ringId) throw new Error(`莫斯科環工作表第 ${index + 2} 列：缺少環編號。`);
    if (!stationId) throw new Error(`莫斯科環工作表第 ${index + 2} 列：缺少車站編號。`);

    const sequence = Number(sequenceText);
    if (!Number.isFinite(sequence)) {
      throw new Error(`莫斯科環工作表第 ${index + 2} 列：順序必須是數字。`);
    }

    const bucket = rings.get(ringId) ?? [];
    bucket.push({ sequence, stationId, rowIndex: index + 2 });
    rings.set(ringId, bucket);
  });

  if (rings.size > 3) throw new Error('莫斯科環最多只能定義 3 個。');

  return [...rings.entries()].map(([id, rows]) => ({
    id,
    stationIds: rows
      .sort((a, b) => a.sequence - b.sequence || a.rowIndex - b.rowIndex)
      .map((row) => row.stationId),
  }));
}

export function parseStationsCsv(text: string): Station[] {
  return stationRecordsToStations(rowsToRecords(parseCsv(text)));
}

export function parseLinesCsv(text: string): TransitLine[] {
  return lineRecordsToLines(rowsToRecords(parseCsv(text)));
}

function worksheetToRows(worksheet: Worksheet): string[][] {
  const rows: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      values[columnNumber - 1] = cell.text?.trim?.() ?? String(cell.value ?? '').trim();
    });
    rows.push(values);
  });
  return rows;
}

export async function importExcelBuffer(
  data: Uint8Array,
): Promise<NetworkInput> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as never);

  const findSheet = (aliases: string[]) => {
    const normalizedAliases = new Set(
      aliases.map((name) => normalizeHeader(name)),
    );
    return workbook.worksheets.find((sheet) =>
      normalizedAliases.has(normalizeHeader(sheet.name)),
    );
  };

  const stationsSheet = findSheet(['Stations', '車站']);
  const linesSheet = findSheet(['Lines', '路線']);
  const ringsSheet = findSheet(['MoscowRings', 'Moscow Rings', '莫斯科環']);

  if (!stationsSheet || !linesSheet) {
    throw new Error(
      'Excel 必須包含「車站 / Stations」與「路線 / Lines」工作表。',
    );
  }

  const stations = stationRecordsToStations(rowsToRecords(worksheetToRows(stationsSheet)));
  const lines = lineRecordsToLines(rowsToRecords(worksheetToRows(linesSheet)));
  const moscowRings = ringsSheet
    ? ringRecordsToDefinitions(rowsToRecords(worksheetToRows(ringsSheet)))
    : [];

  if (!stations.length) throw new Error('「車站 / Stations」工作表沒有資料。');
  if (!lines.length) throw new Error('「路線 / Lines」工作表沒有資料。');

  return { stations, lines, moscowRings };
}

export async function importExcelWorkbook(file: File): Promise<NetworkInput> {
  return importExcelBuffer(
    new Uint8Array(await file.arrayBuffer()),
  );
}
