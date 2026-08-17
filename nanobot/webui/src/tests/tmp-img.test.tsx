import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import MarkdownTextRenderer from "../components/MarkdownTextRenderer";

// Exact backend `_format_server_section` output shape (from the backend test).
const output = [
  "## Knowledge Base: proj",
  "answer text",
  "1. [📄demo](/api/lightrag/file/proj/demo.pdf) (id:1)",
  "   Image context: 系统架构图。图中展示了系统模块之间的调用关系。",
  "   ![系统架构图](/api/lightrag/file/proj/demo.blocks.assets/image.png)",
].join("\n");

describe("retrieved RAG media render", () => {
  it("renders the parent chip and retrieved image", () => {
    render(<MarkdownTextRenderer>{output}</MarkdownTextRenderer>);

    expect(screen.getByTestId("inline-file-path")).toHaveTextContent("demo");
    expect(screen.getByRole("img", { name: "系统架构图" })).toHaveAttribute(
      "src",
      "/api/lightrag/file/proj/demo.blocks.assets/image.png",
    );
  });
});
