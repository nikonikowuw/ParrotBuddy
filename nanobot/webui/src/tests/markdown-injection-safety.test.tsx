import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { remarkTexMath } from "../lib/remark-tex-math";
import { extractDocumentReferencesFromText } from "../lib/document-references";

// The LightRAG backend backslash-escapes untrusted labels/descriptions with
// ``_md_safe_text``: ``]`` is escaped while ``[``/``(``/``)`` stay literal (see
// the backend docstring for why).  These tests lock the security/display
// contract against the *real* plugin stack (gfm + tex-math + katex): an
// injected ``[...](url)`` / ``![...](url)`` must never become a link or
// image, and a citation label containing parentheses must render in full
// instead of being swallowed as LaTeX math.
const plugins = [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkTexMath] as const;

const noEvil = (n: string, line: string) => {
  it(n, () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={plugins} rehypePlugins={[rehypeKatex]}>
        {line}
      </ReactMarkdown>,
    );
    expect(container.querySelector('a[href="http://evil"]')).toBeNull();
    expect(container.querySelector('img[src="http://evil"]')).toBeNull();
  });
};

describe("e2e security + display (real backend output)", () => {
  noEvil("desc injection neutralized", "Image context: 图\\![x\\](http://evil)");
  noEvil("desc link injection neutralized", "Image context: desc [link\\](http://evil)");
  noEvil("ref label injection neutralized", "1. [\\](http://evil)](/api/lightrag/file/proj/real.pdf) (id:1)");

  it("common paper citation shows the full title (no math truncation)", () => {
    render(
      <ReactMarkdown remarkPlugins={plugins} rehypePlugins={[rehypeKatex]}>
        {"1. [📄Original Paper (1706.03762v7)](/api/lightrag/file/proj/papers/Original%20Paper%20%281706.03762v7%29.pdf)"}
      </ReactMarkdown>,
    );
    expect(screen.getByText("📄Original Paper (1706.03762v7)")).toBeTruthy();
  });

  it("extractor and renderer agree on the same real output", () => {
    const line = "1. [📄Original Paper (1706.03762v7)](/api/lightrag/file/proj/papers/Original%20Paper%20%281706.03762v7%29.pdf) (id:1)";
    const refs = extractDocumentReferencesFromText(line);
    expect(refs[0]).toEqual({
      name: "Original Paper (1706.03762v7)",
      fullPath: "papers/Original Paper (1706.03762v7).pdf",
      href: "/api/lightrag/file/proj/papers/Original%20Paper%20%281706.03762v7%29.pdf",
    });
  });
});
