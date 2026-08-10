import { CellValueType, HorizontalAlign, LocaleType, VerticalAlign, WrapStrategy } from "@univerjs/presets";
import type { ICellData, IStyleData, IWorkbookData, IWorksheetData } from "@univerjs/presets";
import ExcelJS from "exceljs";

/**
 * Converters between exceljs workbooks and Univer spreadsheet snapshots.
 *
 * The WebUI editor mounts Univer (community preset) for editing and uses
 * exceljs for the xlsx round trip: read the on-disk file into Univer, let
 * the user edit, then snapshot back out and serialize with exceljs. A
 * pragmatic subset of cell attributes survives (values, types, formulas,
 * merges, column widths / row heights, and common text styles: bold /
 * italic / size / color / fill / alignment / wrap / number format). The
 * round trip is best-effort by design — exotic OOXML features are not mapped.
 */

const CHARS_TO_PX = 7; // exceljs width (characters) ≈ 7px per char in Univer
const POINTS_TO_PX = 96 / 72; // exceljs row height (points) → pixels

/** Excel serial date epoch offset: 1899-12-30 (UTC) in ms since Unix epoch. */
const EXCEL_DATE_EPOCH_MS = -2209161600000;

function dateToExcelSerial(date: Date): number {
  return (date.getTime() - EXCEL_DATE_EPOCH_MS) / 86_400_000;
}

/** Normalize an 8-hex ARGB (``FFRRGGBB``) to ``#RRGGBB`` for Univer. */
function argbToRgb(argb: string): string {
  return `#${argb.replace(/^#/, "").slice(-6)}`;
}

/** Normalize a ``#RRGGBB`` Univer color to an 8-hex ARGB for exceljs. */
function rgbToArgb(rgb: string): string {
  return `FF${rgb.replace(/^#/, "").slice(0, 6)}`;
}

function excelJsStyleToUniver(cell: ExcelJS.Cell): IStyleData | undefined {
  const out: IStyleData = {};
  const font = cell.font;
  if (font) {
    if (font.bold) out.bl = 1;
    if (font.italic) out.it = 1;
    if (font.size) out.fs = font.size;
    if (font.name) out.ff = font.name;
    if (font.color?.argb) out.cl = { rgb: argbToRgb(font.color.argb) };
  }
  const fill = cell.fill;
  if (fill && fill.type === "pattern" && fill.pattern === "solid" && fill.fgColor?.argb) {
    out.bg = { rgb: argbToRgb(fill.fgColor.argb) };
  }
  const alignment = cell.alignment;
  if (alignment) {
    if (alignment.horizontal === "left") out.ht = HorizontalAlign.LEFT;
    else if (alignment.horizontal === "center") out.ht = HorizontalAlign.CENTER;
    else if (alignment.horizontal === "right") out.ht = HorizontalAlign.RIGHT;
    if (alignment.vertical === "top") out.vt = VerticalAlign.TOP;
    else if ((alignment.vertical as string) === "middle") out.vt = VerticalAlign.MIDDLE;
    else if (alignment.vertical === "bottom") out.vt = VerticalAlign.BOTTOM;
    if (alignment.wrapText) out.tb = WrapStrategy.WRAP;
  }
  if (cell.numFmt && cell.numFmt !== "General") out.n = { pattern: cell.numFmt };
  return Object.keys(out).length > 0 ? out : undefined;
}

function isFormulaValue(value: ExcelJS.CellValue): value is ExcelJS.CellFormulaValue {
  return typeof value === "object" && value !== null && !(value instanceof Date) && "formula" in value;
}

function excelJsCellToUniver(cell: ExcelJS.Cell): ICellData | undefined {
  const value = cell.value;
  if (value === null || value === undefined) return undefined;
  const out: ICellData = {};
  if (isFormulaValue(value)) {
    out.f = value.formula;
    const result = value.result;
    if (typeof result === "number") {
      out.v = result;
      out.t = CellValueType.NUMBER;
    } else if (typeof result === "boolean") {
      out.v = result;
      out.t = CellValueType.BOOLEAN;
    } else if (typeof result === "string") {
      out.v = result;
      out.t = CellValueType.STRING;
    } else {
      out.v = result === null || result === undefined ? 0 : String(result);
      out.t = CellValueType.NUMBER;
    }
  } else if (typeof value === "number") {
    out.v = value;
    out.t = CellValueType.NUMBER;
  } else if (typeof value === "boolean") {
    out.v = value;
    out.t = CellValueType.BOOLEAN;
  } else if (value instanceof Date) {
    out.v = dateToExcelSerial(value);
    out.t = CellValueType.NUMBER;
  } else if (typeof value === "string") {
    out.v = value;
    out.t = CellValueType.STRING;
  } else if (Array.isArray((value as { richText?: { text: string }[] }).richText)) {
    out.v = (value as { richText: { text: string }[] }).richText.map((part) => part.text).join("");
    out.t = CellValueType.STRING;
  } else {
    return undefined;
  }
  const style = excelJsStyleToUniver(cell);
  if (style) out.s = style;
  return out;
}

/** Parse an exceljs merge range string like ``A1:B1`` into 0-based indexes. */
function decodeMergeRange(range: string): { startRow: number; endRow: number; startColumn: number; endColumn: number } | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range.trim());
  if (!match) return null;
  return {
    startRow: Number(match[2]) - 1,
    endRow: Number(match[4]) - 1,
    startColumn: colLettersToIndex(match[1]),
    endColumn: colLettersToIndex(match[3]),
  };
}

function colLettersToIndex(letters: string): number {
  let index = 0;
  for (let i = 0; i < letters.length; i += 1) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

/**
 * Convert an ``.xlsx`` ArrayBuffer into a Univer workbook snapshot.
 * ``workbookName`` becomes the Univer workbook id/name.
 */
export async function xlsxBufferToUniver(buffer: ArrayBuffer, workbookName: string): Promise<IWorkbookData> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheetOrder: string[] = [];
  const sheets: Record<string, Partial<IWorksheetData>> = {};
  const workbookData: IWorkbookData = {
    id: workbookName,
    name: workbookName,
    appVersion: "0.0.1",
    locale: LocaleType.EN_US,
    styles: {},
    sheetOrder,
    sheets,
  };
  workbook.worksheets.forEach((worksheet, index) => {
    const sheetId = `s${index + 1}`;
    sheetOrder.push(sheetId);
    const cellData: Record<number, Record<number, ICellData>> = {};
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        // Only the master cell of a merged range carries the content.
        if (cell.isMerged && cell.master && cell.master.address !== cell.address) return;
        const converted = excelJsCellToUniver(cell);
        if (!converted) return;
        if (!cellData[rowNumber - 1]) cellData[rowNumber - 1] = {};
        cellData[rowNumber - 1][colNumber - 1] = converted;
      });
    });
    const mergeData: IWorksheetData["mergeData"] = [];
    for (const range of worksheet.model.merges ?? []) {
      const decoded = decodeMergeRange(String(range));
      if (decoded) mergeData.push(decoded);
    }
    const columnData: Record<number, { w: number }> = {};
    (worksheet.columns ?? []).forEach((column, colIndex) => {
      if (column && typeof column.width === "number" && column.width > 0) {
        columnData[colIndex] = { w: Math.round(column.width * CHARS_TO_PX) };
      }
    });
    const rowData: Record<number, { h: number }> = {};
    worksheet.eachRow((row, rowNumber) => {
      if (row && typeof row.height === "number" && row.height > 0) {
        rowData[rowNumber - 1] = { h: Math.round(row.height * POINTS_TO_PX) };
      }
    });
    sheets[sheetId] = {
      id: sheetId,
      name: (worksheet.name ?? "Sheet").slice(0, 31),
      rowCount: Math.max(worksheet.actualRowCount, 100),
      columnCount: Math.max(worksheet.actualColumnCount, 26),
      cellData,
      mergeData,
      columnData,
      rowData,
      defaultColumnWidth: 96,
      defaultRowHeight: 24,
    };
  });
  return workbookData;
}

function univerStyleToExcelJs(
  style: IStyleData | string | null | undefined | void,
  styles: Record<string, IStyleData | null | undefined | void>,
): IStyleData | undefined {
  const resolved = typeof style === "string" ? styles[style] : style;
  if (!resolved) return undefined;
  return resolved;
}

function univerCellToExcelJsValue(
  cell: ICellData,
): ExcelJS.CellValue {
  const raw = cell.v;
  const value: ExcelJS.CellValue =
    cell.t === CellValueType.NUMBER
      ? (typeof raw === "number" ? raw : 0)
      : cell.t === CellValueType.BOOLEAN
        ? Boolean(raw)
        : (raw == null ? "" : String(raw));
  if (cell.f) {
    return { formula: cell.f, result: value } as ExcelJS.CellValue;
  }
  return value;
}

function applyStyleToExcelJsCell(
  excelCell: ExcelJS.Cell,
  style: IStyleData,
): void {
  const font: Partial<ExcelJS.Font> = {};
  if (style.bl) font.bold = true;
  if (style.it) font.italic = true;
  if (style.fs) font.size = style.fs;
  if (style.ff) font.name = style.ff;
  if (style.cl?.rgb) font.color = { argb: rgbToArgb(style.cl.rgb) };
  if (Object.keys(font).length > 0) excelCell.font = font as ExcelJS.Font;

  if (style.bg?.rgb) {
    excelCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: rgbToArgb(style.bg.rgb) },
    };
  }

  const alignment: Partial<ExcelJS.Alignment> = {};
  if (style.ht === HorizontalAlign.LEFT) alignment.horizontal = "left";
  else if (style.ht === HorizontalAlign.CENTER) alignment.horizontal = "center";
  else if (style.ht === HorizontalAlign.RIGHT) alignment.horizontal = "right";
  if (style.vt === VerticalAlign.TOP) alignment.vertical = "top";
  else if (style.vt === VerticalAlign.MIDDLE) alignment.vertical = "middle";
  else if (style.vt === VerticalAlign.BOTTOM) alignment.vertical = "bottom";
  if (style.tb === WrapStrategy.WRAP) alignment.wrapText = true;
  if (Object.keys(alignment).length > 0) excelCell.alignment = alignment as ExcelJS.Alignment;

  if (style.n?.pattern) excelCell.numFmt = style.n.pattern;
}

/**
 * Convert a Univer workbook snapshot back into an ``.xlsx`` ArrayBuffer
 * (via exceljs, which writes the full style subset back to disk).
 */
export async function univerWorkbookToXlsxBuffer(snapshot: IWorkbookData): Promise<ArrayBuffer> {
  const styles = snapshot.styles ?? {};
  const workbook = new ExcelJS.Workbook();
  const sheetOrder = snapshot.sheetOrder ?? Object.keys(snapshot.sheets ?? {});
  for (const sheetId of sheetOrder) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet) continue;
    const worksheet = workbook.addWorksheet((sheet.name ?? "Sheet").slice(0, 31));
    for (const rowKey of Object.keys(sheet.cellData ?? {})) {
      const row = Number(rowKey);
      const rowCells = sheet.cellData?.[row] ?? {};
      for (const colKey of Object.keys(rowCells)) {
        const col = Number(colKey);
        const cell = rowCells[col];
        if (!cell) continue;
        const excelCell = worksheet.getCell(row + 1, col + 1);
        excelCell.value = univerCellToExcelJsValue(cell);
        const style = univerStyleToExcelJs(cell.s, styles);
        if (style) applyStyleToExcelJsCell(excelCell, style);
      }
    }
    for (const merge of sheet.mergeData ?? []) {
      worksheet.mergeCells(
        merge.startRow + 1,
        merge.startColumn + 1,
        merge.endRow + 1,
        merge.endColumn + 1,
      );
    }
    for (const colKey of Object.keys(sheet.columnData ?? {})) {
      const width = sheet.columnData?.[Number(colKey)]?.w;
      if (typeof width === "number" && width > 0) {
        worksheet.getColumn(Number(colKey) + 1).width = width / CHARS_TO_PX;
      }
    }
    for (const rowKey of Object.keys(sheet.rowData ?? {})) {
      const height = sheet.rowData?.[Number(rowKey)]?.h;
      if (typeof height === "number" && height > 0) {
        worksheet.getRow(Number(rowKey) + 1).height = height / POINTS_TO_PX;
      }
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  // writeBuffer returns a Node Buffer in tests and a Uint8Array/ArrayBuffer
  // in browsers; normalize to a detached ArrayBuffer either way.
  if (buffer instanceof ArrayBuffer) return buffer;
  const view = new Uint8Array(buffer as ArrayBuffer);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}