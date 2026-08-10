import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewPanel } from "@/components/FilePreviewPanel";
import { fetchFilePreview } from "@/lib/api";
import { fetchWithTimeout } from "@/lib/http";
import { renderAsync } from "docx-preview";
import { xlsx2Html } from "xlsx-preview";
import { init as initPptx } from "pptx-preview";

vi.mock("@/components/CodeBlock", () => ({
  CodeBlock: ({
    code,
    language,
    highlight,
  }: {
    code: string;
    language?: string;
    highlight?: boolean;
  }) => (
    <pre
      data-testid="mock-code-block"
      data-language={language}
      data-highlight={String(highlight)}
    >
      {code}
    </pre>
  ),
}));

vi.mock("@/lib/http", () => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("docx-preview", () => ({
  renderAsync: vi.fn(async (_data: unknown, container: HTMLElement) => {
    const div = document.createElement("div");
    div.dataset.testid = "docx-rendered";
    div.textContent = "rendered";
    container.appendChild(div);
  }),
}));

vi.mock("xlsx-preview", () => ({
  xlsx2Html: vi.fn(async () => [
    "<table data-testid=\"xlsx-sheet-html\"><tbody><tr><td>A1</td></tr></tbody></table>",
    "<table data-testid=\"xlsx-sheet-html\"><tbody><tr><td>B1</td></tr></tbody></table>",
  ]),
}));

vi.mock("exceljs", () => {
  class MockWorkbook {
    worksheets = [{ name: "Data" }, { name: "Summary" }];
    xlsx = {
      load: async () => undefined,
    };
  }
  return { Workbook: MockWorkbook };
});

vi.mock("pptx-preview", () => ({
  init: vi.fn(() => ({
    preview: vi.fn(async () => undefined),
    destroy: vi.fn(),
  })),
}));

vi.mock("@/components/UniverSheetsEditor", () => ({
  UniverSheetsEditor: ({
    fileName,
    onSave,
    onBack,
    onSaved,
  }: {
    fileName: string;
    onSave: (contentBase64: string) => Promise<void>;
    onBack: () => void;
    onSaved: () => void;
  }) => (
    <div data-testid="mock-sheets-editor">
      <span>{fileName}</span>
      <button
        type="button"
        onClick={() => {
          void onSave("QkFTRTY0Q09OVEVOVA==").then(onSaved);
        }}
      >
        save-spy
      </button>
      <button type="button" onClick={onBack}>
        back-spy
      </button>
    </div>
  ),
}));

vi.mock("@/components/SobreeDocxEditor", () => ({
  SobreeDocxEditor: ({
    fileName,
    onSave,
    onBack,
    onSaved,
  }: {
    fileName: string;
    onSave: (contentBase64: string) => Promise<void>;
    onBack: () => void;
    onSaved: () => void;
  }) => (
    <div data-testid="mock-docx-editor">
      <span>{fileName}</span>
      <button
        type="button"
        onClick={() => {
          void onSave("UEsDBApEQ09OQ09OVEVOVA==").then(onSaved);
        }}
      >
        save-spy
      </button>
      <button type="button" onClick={onBack}>
        back-spy
      </button>
    </div>
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchFilePreview: vi.fn(),
  };
});

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function docxPayload() {
  return {
    kind: "binary" as const,
    path: "/Users/hr/workspace/report.docx",
    display_path: "report.docx",
    project_path: "/Users/hr/workspace",
    filename: "report.docx",
    mime_type: DOCX_MIME,
    size: 12_345,
  };
}

function xlsxPayload() {
  return {
    kind: "binary" as const,
    path: "/Users/hr/workspace/sales.xlsx",
    display_path: "sales.xlsx",
    project_path: "/Users/hr/workspace",
    filename: "sales.xlsx",
    mime_type: XLSX_MIME,
    size: 20_480,
  };
}

function pptxPayload() {
  return {
    kind: "binary" as const,
    path: "/Users/hr/workspace/deck.pptx",
    display_path: "deck.pptx",
    project_path: "/Users/hr/workspace",
    filename: "deck.pptx",
    mime_type: PPTX_MIME,
    size: 30_720,
  };
}

function mockDocxFetch() {
  vi.mocked(fetchWithTimeout).mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["PK\u0003\u0004fake-docx"], { type: DOCX_MIME }),
  } as unknown as Response);
}

function mockBlobFetch(mime: string) {
  vi.mocked(fetchWithTimeout).mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["PK\u0003\u0004fake-file"], { type: mime }),
  } as unknown as Response);
}

describe("FilePreviewPanel", () => {
  beforeEach(() => {
    vi.mocked(fetchFilePreview).mockReset();
    vi.mocked(fetchWithTimeout).mockReset();
    vi.mocked(renderAsync).mockClear();
    vi.mocked(xlsx2Html).mockClear();
    vi.mocked(initPptx).mockClear();
  });

  it("shows a compact breadcrumb with one file name and a visible close action", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(fetchFilePreview).mockResolvedValue({
      kind: "text" as const,
      path: "/Users/hr/workspace/quicksort.py",
      display_path: "quicksort.py",
      project_path: "/Users/hr/workspace",
      language: "python",
      content: "print('ok')",
      size: 42,
      truncated: false,
    });

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="quicksort.py"
        token="tok"
        onClose={onClose}
      />,
    );

    const codeBlock = await screen.findByTestId("mock-code-block");
    expect(codeBlock).toHaveTextContent("print('ok')");
    expect(codeBlock).toHaveAttribute("data-language", "python");
    expect(codeBlock).toHaveAttribute("data-highlight", "true");
    expect(screen.getByTestId("file-preview-breadcrumb")).toHaveTextContent("...");
    expect(screen.getByTestId("file-preview-breadcrumb")).toHaveTextContent("workspace");
    expect(screen.getByTestId("file-preview-title")).toHaveTextContent("quicksort.py");
    expect(screen.getAllByText("quicksort.py")).toHaveLength(1);

    const closeButton = screen.getByRole("button", { name: "Close file preview" });
    expect(closeButton).toBeVisible();

    await user.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders binary images inline with the raw file URL", async () => {
    vi.mocked(fetchFilePreview).mockResolvedValue({
      kind: "binary",
      path: "/Users/hr/workspace/chart.png",
      display_path: "chart.png",
      project_path: "/Users/hr/workspace",
      filename: "chart.png",
      mime_type: "image/png",
      size: 2048,
    });

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="chart.png"
        token="tok"
        onClose={vi.fn()}
      />,
    );

    const image = await screen.findByRole("img");
    expect(image).toHaveAttribute("alt", "chart.png");
    expect(image).toHaveAttribute(
      "src",
      "/api/sessions/websocket%3Achat-1/file?path=%2FUsers%2Fhr%2Fworkspace%2Fchart.png&token=tok",
    );
    expect(screen.queryByTestId("mock-code-block")).not.toBeInTheDocument();
  });

  it("renders PDFs in a non-sandboxed iframe", async () => {
    vi.mocked(fetchFilePreview).mockResolvedValue({
      kind: "binary",
      path: "/Users/hr/workspace/report.pdf",
      display_path: "report.pdf",
      project_path: "/Users/hr/workspace",
      filename: "report.pdf",
      mime_type: "application/pdf",
      size: 4096,
    });

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="report.pdf"
        token="tok"
        onClose={vi.fn()}
      />,
    );

    const frame = (await screen.findByTitle("Document preview")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.src).toContain("/api/sessions/websocket%3Achat-1/file?");
    expect(frame.hasAttribute("sandbox")).toBe(false);
  });

  it("offers open and download actions for non-renderable documents", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.mocked(fetchFilePreview).mockResolvedValue({
      kind: "binary",
      path: "/Users/hr/workspace/old.doc",
      display_path: "old.doc",
      project_path: "/Users/hr/workspace",
      filename: "old.doc",
      mime_type: "application/msword",
      size: 12_345,
    });

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="old.doc"
        token="tok"
        onClose={vi.fn()}
      />,
    );

    const openButton = await screen.findByRole("button", { name: "Open in new tab" });
    expect(screen.getByTestId("file-preview-title")).toHaveTextContent("old.doc");
    expect(screen.getByText(/12\.1 KB/)).toBeInTheDocument();

    const downloadLink = screen.getByRole("link", { name: "Download" });
    expect(downloadLink).toHaveAttribute("download", "old.doc");
    expect(downloadLink.getAttribute("href")).toContain("/api/sessions/websocket%3Achat-1/file?");

    await userEvent.click(openButton);
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/websocket%3Achat-1/file?"),
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("renders .docx documents inline via docx-preview", async () => {
    mockDocxFetch();
    vi.mocked(fetchFilePreview).mockResolvedValue(docxPayload());

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="report.docx"
        token="tok"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("docx-rendered")).toBeInTheDocument();
    expect(renderAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Open in new tab" })).not.toBeInTheDocument();
    const downloadLink = screen.getByRole("link", { name: /Download/ });
    expect(downloadLink).toHaveAttribute("download", "report.docx");
  });

  it("reports the rendered docx content width so the host can auto-fit the panel", async () => {
    mockDocxFetch();
    vi.mocked(fetchFilePreview).mockResolvedValue(docxPayload());
    const onAutoFitWidth = vi.fn();

    // Make the mocked docx-preview render a page wider than the panel so the
    // container overflows horizontally (docx-preview renders at fixed 100%).
    // jsdom does not lay out, so stub the measured dimensions explicitly.
    vi.mocked(renderAsync).mockImplementationOnce(
      async (_data: unknown, container: HTMLElement) => {
        const wide = document.createElement("div");
        wide.style.width = "1000px";
        wide.dataset.testid = "docx-rendered";
        container.appendChild(wide);
        Object.defineProperty(container, "clientWidth", {
          configurable: true,
          value: 720,
        });
        Object.defineProperty(container, "scrollWidth", {
          configurable: true,
          value: 1000,
        });
      },
    );

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="report.docx"
        token="tok"
        onClose={vi.fn()}
        onAutoFitWidth={onAutoFitWidth}
      />,
    );

    await screen.findByTestId("docx-rendered");
    await waitFor(() => expect(onAutoFitWidth).toHaveBeenCalled());
    expect(onAutoFitWidth.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it("scales docx pages down to fit the container when it is narrower than the content", async () => {
    mockDocxFetch();
    vi.mocked(fetchFilePreview).mockResolvedValue(docxPayload());
    const onAutoFitWidth = vi.fn();

    // Render a realistic docx-preview DOM: a .docx-wrapper holding fixed-
    // width .docx pages, with the container narrower than the content.
    vi.mocked(renderAsync).mockImplementationOnce(
      async (_data: unknown, container: HTMLElement) => {
        const wrapper = document.createElement("div");
        wrapper.className = "docx-wrapper";
        const section = document.createElement("section");
        section.className = "docx";
        section.style.width = "794px";
        wrapper.appendChild(section);
        container.appendChild(wrapper);
        Object.defineProperty(wrapper, "scrollWidth", { configurable: true, value: 854 });
        Object.defineProperty(container, "clientWidth", { configurable: true, value: 720 });
        Object.defineProperty(container, "scrollWidth", { configurable: true, value: 854 });
      },
    );

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="report.docx"
        token="tok"
        onClose={vi.fn()}
        onAutoFitWidth={onAutoFitWidth}
      />,
    );

    await waitFor(() => {
      const section = document.querySelector(".docx");
      expect(section).not.toBeNull();
      expect((section as HTMLElement).style.zoom).not.toBe("");
    });
    // Narrow container still reports so the host can try to widen the panel.
    await waitFor(() => expect(onAutoFitWidth).toHaveBeenCalled());
  });

  it("falls back to open/download actions when a .docx fails to render", async () => {
    mockDocxFetch();
    vi.mocked(fetchFilePreview).mockResolvedValue(docxPayload());
    vi.mocked(renderAsync).mockRejectedValueOnce(new Error("corrupt document"));

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="report.docx"
        token="tok"
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Open in new tab" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toBeInTheDocument();
    expect(screen.queryByTestId("docx-rendered")).not.toBeInTheDocument();
  });

  it("renders .xlsx spreadsheets in a sandboxed frame with sheet tabs", async () => {
    mockBlobFetch(XLSX_MIME);
    vi.mocked(fetchFilePreview).mockResolvedValue(xlsxPayload());

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="sales.xlsx"
        token="tok"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summary" })).toBeInTheDocument();
    expect(xlsx2Html).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ separateSheets: true }),
    );
    // The sheet HTML is rendered inside a fully sandboxed iframe (no scripts,
    // opaque origin), never injected via innerHTML, so attacker-controlled cell
    // markup cannot execute in the WebUI origin.
    const frame = screen.getByTestId("xlsx-preview-frame");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcDoc")).toContain("A1");
    expect(screen.queryByRole("button", { name: "Open in new tab" })).not.toBeInTheDocument();

    // Switching tabs swaps the sandboxed sheet.
    await userEvent.click(screen.getByRole("button", { name: "Summary" }));
    expect(screen.getByTestId("xlsx-preview-frame").getAttribute("srcDoc")).toContain("B1");
  });

  it("renders .pptx presentations via pptx-preview in list mode", async () => {
    mockBlobFetch(PPTX_MIME);
    vi.mocked(fetchFilePreview).mockResolvedValue(pptxPayload());

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="deck.pptx"
        token="tok"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(initPptx).toHaveBeenCalledTimes(1));
    expect(initPptx).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ mode: "list" }),
    );
    const viewer = vi.mocked(initPptx).mock.results[0].value as {
      preview: ReturnType<typeof vi.fn>;
    };
    expect(viewer.preview).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(screen.getByRole("link", { name: /Download/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in new tab" })).not.toBeInTheDocument();
  });

  it("hides the spreadsheet edit action when no save path is wired", async () => {
    mockBlobFetch(XLSX_MIME);
    vi.mocked(fetchFilePreview).mockResolvedValue(xlsxPayload());

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="sales.xlsx"
        token="tok"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Data" })).toBeInTheDocument();
    expect(screen.queryByTestId("file-preview-edit")).not.toBeInTheDocument();
  });

  it("opens the spreadsheet editor and saves edits back through onSaveFile", async () => {
    mockBlobFetch(XLSX_MIME);
    const saveFile = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetchFilePreview).mockResolvedValue(xlsxPayload());

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="sales.xlsx"
        token="tok"
        onClose={vi.fn()}
        onSaveFile={saveFile}
      />,
    );

    // Edit action is only offered for spreadsheets when a save path exists.
    expect(await screen.findByTestId("file-preview-edit")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("file-preview-edit"));

    // The editor mounts in place (mock) and receives the resolved file path.
    expect(await screen.findByTestId("mock-sheets-editor")).toBeInTheDocument();

    // Saving hands the base64 content + original path to the host callback.
    await userEvent.click(screen.getByRole("button", { name: "save-spy" }));
    expect(saveFile).toHaveBeenCalledWith(
      "/Users/hr/workspace/sales.xlsx",
      "QkFTRTY0Q09OVEVOVA==",
    );

    // After the save resolves the panel returns to the read-only preview.
    await waitFor(() => expect(screen.queryByTestId("mock-sheets-editor")).not.toBeInTheDocument());
  });

  it("does not offer edit for non-editable binaries (ppt)", async () => {
    mockBlobFetch(PPTX_MIME);
    vi.mocked(fetchFilePreview).mockResolvedValue(pptxPayload());

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="deck.pptx"
        token="tok"
        onClose={vi.fn()}
        onSaveFile={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(initPptx).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("file-preview-edit")).not.toBeInTheDocument();
  });

  it("opens the Word editor for .docx files and saves edits back", async () => {
    mockDocxFetch();
    const saveFile = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetchFilePreview).mockResolvedValue(docxPayload());

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="report.docx"
        token="tok"
        onClose={vi.fn()}
        onSaveFile={saveFile}
      />,
    );

    expect(await screen.findByTestId("file-preview-edit")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("file-preview-edit"));

    expect(await screen.findByTestId("mock-docx-editor")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "save-spy" }));
    expect(saveFile).toHaveBeenCalledWith(
      "/Users/hr/workspace/report.docx",
      "UEsDBApEQ09OQ09OVEVOVA==",
    );
    await waitFor(() => expect(screen.queryByTestId("mock-docx-editor")).not.toBeInTheDocument());
  });
});
