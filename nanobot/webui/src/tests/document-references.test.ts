import { describe, expect, it } from "vitest";
import {
  extractDocumentReferencesFromMessages,
  extractDocumentReferencesFromText,
  fileReferenceFromUrl,
} from "@/lib/document-references";
import type { UIMessage } from "@/lib/types";

describe("document-references", () => {
  it("parses LightRAG document URL correctly", () => {
    const res = fileReferenceFromUrl(
      "http://127.0.0.1:9621/documents/file/%E5%8F%91%E7%A5%A8%E6%96%87%E4%BB%B6.pdf?api_key=secret",
    );
    expect(res).not.toBeNull();
    expect(res?.name).toBe("发票文件.pdf");
    expect(res?.fullPath).toBe("发票文件.pdf");
  });

  it("parses gateway-proxied LightRAG document URL correctly", () => {
    const res = fileReferenceFromUrl(
      "/api/lightrag/file/KB-1/%E5%8F%91%E7%A5%A8%E6%96%87%E4%BB%B6.pdf",
    );
    expect(res).not.toBeNull();
    expect(res?.name).toBe("发票文件.pdf");
    expect(res?.fullPath).toBe("发票文件.pdf");
  });

  it("parses nested gateway LightRAG document URLs", () => {
    const res = fileReferenceFromUrl(
      "/api/lightrag/file/proj1/docs/rag.pdf",
    );
    expect(res).toEqual({ name: "rag.pdf", fullPath: "docs/rag.pdf", rewrittenHref: "/api/lightrag/file/proj1/docs/rag.pdf" });
  });

  it("does not treat external URLs as file references", () => {
    expect(
      fileReferenceFromUrl("https://arxiv.org/pdf/2401.00001.pdf"),
    ).toBeNull();
    expect(fileReferenceFromUrl("https://example.com/report.pdf")).toBeNull();
    expect(fileReferenceFromUrl("https://evil.example/documents/file/report.pdf")).toBeNull();
    expect(fileReferenceFromUrl("https://evil.example/api/lightrag/file/proj/report.pdf")).toBeNull();
    expect(
      fileReferenceFromUrl(
        "https://github.com/user/repo/blob/main/docs/spec.md",
      ),
    ).toBeNull();
    expect(fileReferenceFromUrl("https://example.com/logo.png")).toBeNull();
    expect(fileReferenceFromUrl("https://example.com/page")).toBeNull();
  });


  it("keeps a compact PDF citation label separate from its source path", () => {
    const refs = extractDocumentReferencesFromText(
      "1. [📄Original Paper (1706.03762v7)](/api/lightrag/file/proj/papers/Original%20Paper%20%281706.03762v7%29.pdf) (id:1)",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      name: "Original Paper (1706.03762v7)",
      fullPath: "papers/Original Paper (1706.03762v7).pdf",
      href: "/api/lightrag/file/proj/papers/Original%20Paper%20%281706.03762v7%29.pdf",
    });
  });

  it("unescapes the backend's markdown escapes in citation labels", () => {
    // ``_`` arrives backslash-escaped from the backend; the extracted
    // label must match what the markdown renderer shows (parentheses stay
    // literal, so ``\(" math never enters the picture).
    const refs = extractDocumentReferencesFromText(
      "1. [📄my\\_report (draft v2)](/api/lightrag/file/proj/my_report%20%28draft%20v2%29.pdf) (id:1)",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      name: "my_report (draft v2)",
      fullPath: "my_report (draft v2).pdf",
      href: "/api/lightrag/file/proj/my_report%20%28draft%20v2%29.pdf",
    });
  });

  it("does not collect external URLs as document references", () => {
    const text =
      "See https://arxiv.org/pdf/2401.00001.pdf and https://example.com/report.pdf";
    const refs = extractDocumentReferencesFromText(text);
    expect(refs).toHaveLength(0);
  });

  it("extracts labels containing escaped closing brackets", () => {
    const refs = extractDocumentReferencesFromText(
      "1. [📄file[name\\].pdf](/api/lightrag/file/proj/file%5Bname%5D.pdf) (id:1)",
    );
    expect(refs).toEqual([{
      name: "file[name].pdf",
      fullPath: "file[name].pdf",
      href: "/api/lightrag/file/proj/file%5Bname%5D.pdf",
    }]);
  });

  it("extracts gateway LightRAG references from numbered lines", () => {
    const text =
      "## Knowledge Base: KB-1\n1. [发票文件.pdf](/api/lightrag/file/KB-1/%E5%8F%91%E7%A5%A8%E6%96%87%E4%BB%B6.pdf) (id:1)";
    const refs = extractDocumentReferencesFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      name: "发票文件.pdf",
      fullPath: "发票文件.pdf",
      href: "/api/lightrag/file/KB-1/%E5%8F%91%E7%A5%A8%E6%96%87%E4%BB%B6.pdf",
    });
  });

  it("extracts document references from Markdown links and standalone URLs", () => {
    const text = `
      1. [/docs/rag.pdf](http://127.0.0.1:9621/documents/file/docs/rag.pdf?api_key=lk) (id:1)
      Also check http://127.0.0.1:9621/documents/file/sub/report.xlsx
    `;
    const refs = extractDocumentReferencesFromText(text);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      name: "/docs/rag.pdf",
      fullPath: "docs/rag.pdf",
      href: "/api/lightrag/file/default/docs/rag.pdf",
    });
    expect(refs[1]).toEqual({
      name: "report.xlsx",
      fullPath: "sub/report.xlsx",
      href: "/api/lightrag/file/default/sub/report.xlsx",
    });
  });

  it("extracts document references from toolEvents when traces are not present", () => {
    const activityMessages: UIMessage[] = [
      {
        id: "1",
        role: "tool",
        kind: "trace",
        content: "used 2 tools",
        toolEvents: [
          {
            name: "lightrag_query",
            phase: "end",
            result: "## Knowledge Base: KB-1\n1. [发票文件.pdf](http://127.0.0.1:9621/documents/file/%E5%8F%91%E7%A5%A8%E6%96%87%E4%BB%B6.pdf) (id:1)",
          },
        ],
        createdAt: Date.now(),
      },
    ];

    const refs = extractDocumentReferencesFromMessages(activityMessages);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("发票文件.pdf");
    expect(refs[0].fullPath).toBe("发票文件.pdf");
  });

  it("extracts plain file path references without URLs from LightRAG tool output", () => {
    const text = "## Knowledge Base: KB-1\n1. 发票文件.pdf (id:1)";
    const refs = extractDocumentReferencesFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("发票文件.pdf");
    expect(refs[0].fullPath).toBe("发票文件.pdf");
  });
});

  it("does not treat retrieved media image lines as document references", () => {
    // The formatter emits the parent as a numbered link and each retrieved
    // image as an indented, unnumbered Markdown image line. Only the parent
    // may become a document-reference chip.
    const text =
      "## Knowledge Base: proj\n" +
      "1. [demo.pdf](/api/lightrag/file/proj/demo.pdf) (id:1)\n" +
      "   Image context: 系统架构图。图中展示了系统模块之间的调用关系。\n" +
      "   ![系统架构图](/api/lightrag/file/proj/demo.blocks.assets/image.png)";
    const refs = extractDocumentReferencesFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("demo.pdf");
    expect(refs[0].fullPath).toBe("demo.pdf");
  });

  it("extracts the parent reference when multiple media lines follow it", () => {
    const text =
      "1. [demo.pdf](/api/lightrag/file/proj/demo.pdf) (id:1)\n" +
      "   Image context: 图A。模块关系\n" +
      "   ![图A](/api/lightrag/file/proj/demo.blocks.assets/image.png)\n" +
      "   Image context: 图B。流程说明\n" +
      "   ![图B](/api/lightrag/file/proj/demo.blocks.assets/flow.png)";
    const refs = extractDocumentReferencesFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("demo.pdf");
  });
