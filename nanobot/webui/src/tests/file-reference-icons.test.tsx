import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  FileReferenceChip,
  FileReferenceIcon,
  fileKindForPath,
} from "@/components/FileReferenceChip";

describe("fileKindForPath office mapping", () => {
  it("maps word documents to the word kind", () => {
    expect(fileKindForPath("/Users/hr/报告.docx")).toBe("word");
    expect(fileKindForPath("archive.doc")).toBe("word");
    expect(fileKindForPath("resume.wps")).toBe("word");
  });

  it("maps spreadsheets to the excel kind", () => {
    expect(fileKindForPath("/Users/hr/data.xlsx")).toBe("excel");
    expect(fileKindForPath("ledger.xls")).toBe("excel");
    expect(fileKindForPath("export.csv")).toBe("excel");
    expect(fileKindForPath("data.tsv")).toBe("excel");
  });

  it("maps presentations to the powerpoint kind", () => {
    expect(fileKindForPath("/Users/hr/deck.pptx")).toBe("powerpoint");
    expect(fileKindForPath("slides.ppt")).toBe("powerpoint");
  });

  it("maps pdfs to the pdf kind", () => {
    expect(fileKindForPath("/Users/hr/manual.pdf")).toBe("pdf");
  });

  it("keeps code and unknown files on their existing kinds", () => {
    expect(fileKindForPath("/Users/hr/app.py")).toBe("python");
    expect(fileKindForPath("/Users/hr/archive.zip")).toBe("default");
  });
});

describe("FileReferenceIcon office rendering", () => {
  it("renders distinct Word / Excel / PowerPoint / PDF icons with brand colors", () => {
    const { container } = render(
      <div>
        <FileReferenceIcon kind="word" />
        <FileReferenceIcon kind="excel" />
        <FileReferenceIcon kind="powerpoint" />
        <FileReferenceIcon kind="pdf" />
      </div>,
    );
    const svgs = Array.from(container.querySelectorAll("svg"));
    expect(svgs).toHaveLength(4);
    // each brand icon carries its Office brand color
    const colors = svgs.map((el) => el.getAttribute("color"));
    expect(colors).toEqual(["#2B579A", "#217346", "#B7472A", "#D93025"]);
  });
});

describe("FileReferenceChip office references", () => {
  it("renders an office file reference as a chip with a branded icon", () => {
    render(<FileReferenceChip path="/Users/hr/report.docx" display="name" />);
    const chip = screen.getByTestId("inline-file-path");
    expect(chip).toHaveTextContent("report.docx");
    expect(chip.querySelector("svg")?.getAttribute("color")).toBe("#2B579A");
  });
});
