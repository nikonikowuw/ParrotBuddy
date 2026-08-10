import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  univerWorkbookToXlsxBuffer,
  xlsxBufferToUniver,
} from "@/lib/xlsx-univer";
import { bufferToBase64 } from "@/lib/binary";

async function buildSampleWorkbook(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Sheet1");
  ws.getCell("A1").value = "名称";
  ws.getCell("B1").value = "数量";
  ws.getCell("A2").value = "苹果";
  ws.getCell("B2").value = 42;
  ws.getCell("A3").value = 7;
  ws.getCell("B3").value = 3.5;
  ws.getCell("C2").value = { formula: "SUM(B2:B3)", result: 45.5 };
  ws.getCell("A1").font = { bold: true, size: 14, color: { argb: "FFFF0000" } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  ws.getCell("A1").alignment = { horizontal: "center", wrapText: true };
  ws.getCell("A1").numFmt = "0.00";
  ws.mergeCells("A1:B1");
  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = 8;
  ws.getRow(1).height = 20;
  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

describe("xlsx-univer converters", () => {
  it("round-trips values, formulas, merges, dimensions and styles", async () => {
    const source = await buildSampleWorkbook();
    const univer = await xlsxBufferToUniver(source, "report.xlsx");

    expect(univer.sheetOrder).toHaveLength(1);
    const sheet = univer.sheets[univer.sheetOrder[0]];
    expect(sheet.name).toBe("Sheet1");

    // values
    expect(sheet.cellData?.[0]?.[0]?.v).toBe("名称");
    expect(sheet.cellData?.[1]?.[1]?.v).toBe(42);
    // formula preserved
    expect(sheet.cellData?.[1]?.[2]?.f).toBe("SUM(B2:B3)");
    // merge (0-based)
    expect(sheet.mergeData).toEqual([
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 },
    ]);
    // dimensions
    expect(sheet.columnData?.[0]?.w).toBe(12 * 7);
    expect(sheet.rowData?.[0]?.h).toBe(Math.round(20 * (96 / 72)));

    // styles survive the import
    expect(sheet.cellData?.[0]?.[0]?.s).toMatchObject({
      bl: 1,
      fs: 14,
      ht: 2, // center
      tb: 3, // wrap
      n: { pattern: "0.00" },
    });

    // convert back and re-read with exceljs
    const outBuffer = await univerWorkbookToXlsxBuffer(univer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(outBuffer);
    const outSheet = workbook.getWorksheet("Sheet1")!; // created above

    expect(outSheet.getCell("A1").value).toBe("名称");
    expect(outSheet.getCell("B2").value).toBe(42);
    expect(outSheet.getCell("C2").value).toMatchObject({ formula: "SUM(B2:B3)" });
    expect(outSheet.model.merges).toEqual(["A1:B1"]);
    expect(outSheet.getColumn(1).width).toBe(12);
    expect(outSheet.getRow(1).height).toBeCloseTo(20, 0); // pixel rounding may drift ±0.5pt
    // style round trip
    expect(outSheet.getCell("A1").font?.bold).toBe(true);
    expect(outSheet.getCell("A1").font?.size).toBe(14);
    expect(outSheet.getCell("A1").alignment?.horizontal).toBe("center");
    expect(outSheet.getCell("A1").alignment?.wrapText).toBe(true);
    expect(outSheet.getCell("A1").numFmt).toBe("0.00");
  });

  it("maps booleans and skips blank cells", async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("S");
    ws.getCell("A1").value = true;
    const buffer = await workbook.xlsx.writeBuffer();
    const univer = await xlsxBufferToUniver(buffer as ArrayBuffer, "b");

    const sheet = univer.sheets[univer.sheetOrder[0]];
    expect(sheet.cellData?.[0]?.[0]).toMatchObject({ v: true });
    // blank cells are not materialized
    expect(sheet.cellData?.[1]?.[1]).toBeUndefined();

    const out = await univerWorkbookToXlsxBuffer(univer);
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(out);
    expect(reread.getWorksheet("S")!.getCell("A1").value).toBe(true);
  });

  it("does not duplicate content of merged slave cells on export", async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("S");
    ws.getCell("A1").value = "master";
    ws.getCell("B1").value = "slave";
    ws.mergeCells("A1:B1");
    const buffer = await workbook.xlsx.writeBuffer();
    const univer = await xlsxBufferToUniver(buffer as ArrayBuffer, "m");

    // only the master cell carries the value
    expect(univer.sheets[univer.sheetOrder[0]].cellData?.[0]?.[0]?.v).toBe("master");
    expect(univer.sheets[univer.sheetOrder[0]].cellData?.[0]?.[1]).toBeUndefined();
  });

  it("encodes ArrayBuffer to base64", () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    const b64 = bufferToBase64(bytes.buffer);
    expect(b64).toBe("UEsDBAEC");
    const decoded = atob(b64);
    expect([...decoded].map((c) => c.charCodeAt(0))).toEqual([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
  });
});
