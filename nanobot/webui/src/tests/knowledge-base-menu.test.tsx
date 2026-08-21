import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { KnowledgeBaseMenu } from "@/components/thread/KnowledgeBaseMenu";

const TRIGGER_NAME = /knowledge base selector/i;

describe("KnowledgeBaseMenu", () => {
  it("renders the trigger even with an empty allowlist", () => {
    render(
      <KnowledgeBaseMenu options={[]} selected={[]} isHero={false} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: TRIGGER_NAME })).toBeInTheDocument();
    expect(screen.getByText("Knowledge base")).toBeInTheDocument();
  });

  it("shows the label when nothing is selected", () => {
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

  it("toggles a named knowledge base on/off", async () => {
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

  it("deselects an already-selected knowledge base", async () => {
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

  it("groups the built-in personal base separately from enterprise bases", async () => {
    render(
      <KnowledgeBaseMenu
        options={["__personal__", "docs"]}
        selected={[]}
        personalLabel="My Personal KB"
        isHero={false}
        onChange={vi.fn()}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: TRIGGER_NAME }));

    expect(await screen.findByRole("menuitemcheckbox", { name: "My Personal KB" })).toBeInTheDocument();
    expect(screen.getByText("Enterprise KB")).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "docs" })).toBeInTheDocument();
  });

  it("localizes the built-in personal base when no custom label is configured", async () => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage("zh-CN");
    try {
      render(
        <KnowledgeBaseMenu
          options={["__personal__"]}
          selected={[]}
          isHero={false}
          onChange={vi.fn()}
        />,
      );
      fireEvent.pointerDown(screen.getByRole("button", { name: /知识库选择器/ }));
      expect(
        await screen.findByRole("menuitemcheckbox", { name: "个人知识库" }),
      ).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it("clears the whole selection via the clear action", async () => {
    const onChange = vi.fn();
    render(
      <KnowledgeBaseMenu
        options={["notes", "code"]}
        selected={["notes", "code"]}
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
