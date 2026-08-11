import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LightRagEmbeddedView } from "@/components/lightrag/LightRagEmbeddedView";
import type { SettingsPayload } from "@/lib/types";

const STORAGE_KEY = "nanobot-webui.lightrag-embedded-server";

function payload(lightrag: SettingsPayload["lightrag"]): SettingsPayload {
  return { lightrag } as SettingsPayload;
}

const TWO_SERVERS = payload({
  enabled: true,
  servers: [
    {
      name: "docs",
      api_base: "http://127.0.0.1:9621",
      default_query_mode: "mix",
      include_references: true,
      include_chunk_content: false,
    },
    {
      name: "prod",
      api_base: "https://rag.example.com",
      api_key_hint: "sk-…",
      default_query_mode: "hybrid",
      default_top_k: 20,
      timeout: 60,
      include_references: true,
      include_chunk_content: false,
    },
  ],
  default_workspace: "docs",
});

const NO_DEFAULT = payload({
  enabled: true,
  servers: [
    {
      name: "alpha",
      api_base: "http://127.0.0.1:9700",
      default_query_mode: "mix",
      include_references: true,
      include_chunk_content: false,
    },
  ],
  default_workspace: null,
});

const NO_SERVERS = payload({
  enabled: true,
  servers: [],
  default_workspace: null,
});

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("LightRagEmbeddedView", () => {
  it("loads the default workspace server in a documents iframe", () => {
    render(<LightRagEmbeddedView settings={TWO_SERVERS} tab="documents" theme="dark" />);
    const frame = screen.getByTitle("docs — LightRAG");
    expect(frame).toHaveAttribute(
      "src",
      "http://127.0.0.1:9621/webui/?embedded=1&tab=documents&theme=dark",
    );
  });

  it("falls back to the first server when no default workspace is configured", () => {
    render(<LightRagEmbeddedView settings={NO_DEFAULT} tab="knowledge-graph" theme="light" />);
    const frame = screen.getByTitle("alpha — LightRAG");
    expect(frame).toHaveAttribute(
      "src",
      "http://127.0.0.1:9700/webui/?embedded=1&tab=knowledge-graph&theme=light",
    );
  });

  it("prefers the last browser-selected server over the default workspace", () => {
    window.localStorage.setItem(STORAGE_KEY, "prod");
    render(<LightRagEmbeddedView settings={TWO_SERVERS} tab="documents" theme="light" />);
    const frame = screen.getByTitle("prod — LightRAG");
    expect(frame).toHaveAttribute(
      "src",
      "https://rag.example.com/webui/?embedded=1&tab=documents&theme=light",
    );
  });

  it("falls back to a valid server when the stored selection no longer exists", () => {
    window.localStorage.setItem(STORAGE_KEY, "gone");
    render(<LightRagEmbeddedView settings={TWO_SERVERS} tab="documents" theme="light" />);
    expect(screen.getByTitle("docs — LightRAG")).toBeInTheDocument();
  });

  it("persists a server switch made through the selector", async () => {
    render(<LightRagEmbeddedView settings={TWO_SERVERS} tab="documents" theme="light" />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "docs" }));
    const prod = await screen.findByRole("menuitem", { name: /prod/ });
    fireEvent.click(prod);
    expect(screen.getByTitle("prod — LightRAG")).toHaveAttribute(
      "src",
      "https://rag.example.com/webui/?embedded=1&tab=documents&theme=light",
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("prod");
  });

  it("shows an empty state when no server is configured", () => {
    render(<LightRagEmbeddedView settings={NO_SERVERS} tab="documents" theme="light" />);
    expect(
      screen.getByText(/No LightRAG server is configured/),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/LightRAG/)).not.toBeInTheDocument();
  });
});
