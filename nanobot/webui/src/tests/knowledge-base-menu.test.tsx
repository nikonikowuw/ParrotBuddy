import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_KB_SENTINEL,
  KnowledgeBaseMenu,
} from "@/components/thread/KnowledgeBaseMenu";

const TRIGGER_NAME = /knowledge base selector/i;

describe("KnowledgeBaseMenu", () => {
  it("always renders the Default option even with an empty allowlist", () => {
    render(
      <KnowledgeBaseMenu options={[]} selected={[]} isHero={false} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: TRIGGER_NAME })).toBeInTheDocument();
    expect(screen.getByText("Knowledge base")).toBeInTheDocument();
  });

  it("shows the default label when nothing is selected", () => {
    render(
      <KnowledgeBaseMenu
        options={["notes", "code"]}
        selected={[]}
        isHero={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Knowledge base")).toBeInTheDocument();
  });

  it("shows 'Default' when the Default sentinel is selected", () => {
    render(
      <KnowledgeBaseMenu
        options={["notes", "code"]}
        selected={[DEFAULT_KB_SENTINEL]}
        isHero={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("selecting Default clears any named workspaces (exclusive)", async () => {
    const onChange = vi.fn();
    render(
      <KnowledgeBaseMenu
        options={["notes", "code"]}
        selected={["notes"]}
        isHero={false}
        onChange={onChange}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: TRIGGER_NAME }));
    const defaultItem = await screen.findByRole("menuitemcheckbox", { name: /Default/ });
    fireEvent.click(defaultItem);
    expect(onChange).toHaveBeenCalledWith([DEFAULT_KB_SENTINEL]);
  });

  it("selecting a named workspace clears Default (exclusive)", async () => {
    const onChange = vi.fn();
    render(
      <KnowledgeBaseMenu
        options={["notes", "code"]}
        selected={[DEFAULT_KB_SENTINEL]}
        isHero={false}
        onChange={onChange}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: TRIGGER_NAME }));
    const notes = await screen.findByRole("menuitemcheckbox", { name: "notes" });
    fireEvent.click(notes);
    expect(onChange).toHaveBeenCalledWith(["notes"]);
  });

  it("toggles a named workspace on/off", async () => {
    const onChange = vi.fn();
    render(
      <KnowledgeBaseMenu
        options={["notes", "code"]}
        selected={["notes"]}
        isHero={false}
        onChange={onChange}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: TRIGGER_NAME }));
    const code = await screen.findByRole("menuitemcheckbox", { name: "code" });
    fireEvent.click(code);
    expect(onChange).toHaveBeenCalledWith(["notes", "code"]);
  });

  it("deselects an already-selected named workspace", async () => {
    const onChange = vi.fn();
    render(
      <KnowledgeBaseMenu
        options={["notes", "code"]}
        selected={["notes"]}
        isHero={false}
        onChange={onChange}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: TRIGGER_NAME }));
    const notes = await screen.findByRole("menuitemcheckbox", { name: "notes" });
    fireEvent.click(notes);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("clears the whole selection (incl. Default) via the clear action", async () => {
    const onChange = vi.fn();
    render(
      <KnowledgeBaseMenu
        options={["notes", "code"]}
        selected={[DEFAULT_KB_SENTINEL]}
        isHero={false}
        onChange={onChange}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: TRIGGER_NAME }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText(/clear selection/i));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
