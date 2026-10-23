import type { Worksheet } from 'exceljs';
import type { NetworkInput, Station, TransitLine } from '../types';

type RecordRow = Record<string, string>;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
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
  return records.map((row, index) => {
    const id = pick(row, ['id', 'stationId', 'station']);
    const name = pick(row, ['name', 'stationName']);
    const latText = pick(row, ['lat', 'latitude']);
    const lonText = pick(row, ['lon', 'lng', 'longitude']);
    const complexId = pick(row, [
      'complexId',
      'transferId',
      'stationComplex',
      'transferGroup',
      'transfer',
    ]);

    const lat = Number(latText);
    const lon = Number(lonText);

    if (!id) throw new Error(`Stations row ${index + 2}: id is required.`);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Stations row ${index + 2}: lat/lon must be numbers.`);
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
    const lineId = pick(row, ['lineId', 'routeId', 'line', 'route']);
    const lineName = pick(row, ['lineName', 'routeName', 'name']);
    const color = pick(row, ['color', 'lineColor', 'routeColor']) || '#64748b';
    const pathId = pick(row, ['pathId', 'branchId', 'path', 'branch']) || 'main';
    const stationId = pick(row, ['stationId', 'station']);
    const sequenceText = pick(row, ['sequence', 'seq', 'order', 'stationOrder']);
    const sequence = Number(sequenceText);

    if (!lineId) throw new Error(`Lines row ${index + 2}: lineId is required.`);
    if (!stationId) throw new Error(`Lines row ${index + 2}: stationId is required.`);
    if (!Number.isFinite(sequence)) {
      throw new Error(`Lines row ${index + 2}: sequence/order must be a number.`);
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

export async function importExcelWorkbook(file: File): Promise<NetworkInput> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const data = new Uint8Array(await file.arrayBuffer());
  await workbook.xlsx.load(data as never);

  const findSheet = (name: string) =>
    workbook.worksheets.find((sheet) => sheet.name.trim().toLowerCase() === name);

  const stationsSheet = findSheet('stations');
  const linesSheet = findSheet('lines');

  if (!stationsSheet || !linesSheet) {
    throw new Error('Excel must contain worksheets named "Stations" and "Lines".');
  }

  const stations = stationRecordsToStations(rowsToRecords(worksheetToRows(stationsSheet)));
  const lines = lineRecordsToLines(rowsToRecords(worksheetToRows(linesSheet)));

  if (!stations.length) throw new Error('Stations worksheet is empty.');
  if (!lines.length) throw new Error('Lines worksheet is empty.');

  return { stations, lines };
}
