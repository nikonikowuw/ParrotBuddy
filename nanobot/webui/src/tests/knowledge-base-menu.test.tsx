import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { KnowledgeBaseMenu } from "@/components/thread/KnowledgeBaseMenu";

const TRIGGER_NAME = /knowledge base selector/i;

describe("KnowledgeBaseMenu", () => {
  it("renders the toggle button", () => {
    render(
      <KnowledgeBaseMenu options={[]} selected={[]} isHero={false} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: TRIGGER_NAME })).toBeInTheDocument();
    expect(screen.getByText("Knowledge base")).toBeInTheDocument();
  });

  it("toggles knowledge base on when clicked and currently unselected", () => {
    const onChange = vi.fn();
    render(
      <KnowledgeBaseMenu
        options={["__personal__"]}
        selected={[]}
        isHero={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: TRIGGER_NAME }));
    expect(onChange).toHaveBeenCalledWith(["__personal__"]);
  });

  it("toggles knowledge base off when clicked and currently selected", () => {
    const onChange = vi.fn();
    render(
      <KnowledgeBaseMenu
        options={["__personal__"]}
        selected={["__personal__"]}
        isHero={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: TRIGGER_NAME }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("indicates pressed state when knowledge base is selected", () => {
    render(
      <KnowledgeBaseMenu
        options={["__personal__"]}
        selected={["__personal__"]}
        isHero={false}
        onChange={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: TRIGGER_NAME });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("localizes the label when language changes", async () => {
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
      expect(screen.getByRole("button", { name: /知识库选择器/ })).toBeInTheDocument();
      expect(screen.getByText("知识库")).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});

