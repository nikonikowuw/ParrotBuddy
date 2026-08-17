import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import MarkdownTextRenderer from "../components/MarkdownTextRenderer";

const backendOutput =
  "1. [📄Original Paper (1706.03762v7)](/api/lightrag/file/proj/papers/Original%20Paper%20%281706.03762v7%29.pdf)";

describe("citation display", () => {
  it("keeps the complete title while preserving the source path", () => {
    render(<MarkdownTextRenderer>{backendOutput}</MarkdownTextRenderer>);
    const chip = screen.getByTestId("inline-file-path");

    expect(chip).toHaveTextContent("Original Paper (1706.03762v7)");
    expect(chip).not.toHaveTextContent("\\");
    expect(chip).toHaveAttribute(
      "aria-label",
      "papers/Original Paper (1706.03762v7).pdf",
    );
  });
});
