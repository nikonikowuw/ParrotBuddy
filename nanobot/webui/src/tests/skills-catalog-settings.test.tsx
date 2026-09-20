import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SkillsCatalogSettings } from "@/components/settings/SkillsCatalogSettings";
import type { NanobotClient } from "@/lib/nanobot-client";
import type { SkillSummary } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

const workspaceSkill: SkillSummary = {
  name: "custom-skill",
  description: "A workspace skill",
  source: "workspace",
  available: true,
};
const builtinSkill: SkillSummary = {
  name: "builtin-skill",
  description: "A built-in skill",
  source: "builtin",
  available: true,
};

function renderCatalog(
  skills: SkillSummary[] = [workspaceSkill, builtinSkill],
  clientOverrides: Partial<Pick<NanobotClient, "uploadSkill" | "deleteSkill">> = {},
  onSkillsChanged = vi.fn().mockResolvedValue(undefined),
) {
  const client = {
    uploadSkill: vi.fn().mockResolvedValue({
      name: "uploaded-skill",
      updated: false,
      available: true,
      unavailable_reason: "",
    }),
    deleteSkill: vi.fn().mockResolvedValue("custom-skill"),
    ...clientOverrides,
  } as unknown as NanobotClient;
  const view = render(
    <ClientProvider client={client} token="token">
      <SkillsCatalogSettings skills={skills} onSkillsChanged={onSkillsChanged} />
    </ClientProvider>,
  );
  return { ...view, client, onSkillsChanged };
}

function skillDetail(name: string, source: "workspace" | "builtin") {
  return {
    name,
    description: source === "workspace" ? "A workspace skill" : "A built-in skill",
    source,
    available: true,
    requirements: { bins: [], env: [], missing_bins: [], missing_env: [] },
    raw_markdown: `---\nname: ${name}\ndescription: test\n---\n`,
  };
}

describe("SkillsCatalogSettings", () => {
  it("uploads a selected SKILL.md and refreshes the shared list", async () => {
    const onSkillsChanged = vi.fn().mockResolvedValue(undefined);
    const { container, client } = renderCatalog([workspaceSkill], {}, onSkillsChanged);
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    const file = new File(["---\nname: selected-skill\ndescription: test\n---\n"], "SKILL.md", {
      type: "text/markdown",
    });
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => {
      expect(client.uploadSkill).toHaveBeenCalledWith("SKILL.md", expect.any(String), { overwrite: false });
    });
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent("Uploaded uploaded-skill.");
  });

  it("shows a localized gateway error without refreshing after a failed upload", async () => {
    const onSkillsChanged = vi.fn().mockResolvedValue(undefined);
    const uploadSkill = vi.fn().mockRejectedValue(new Error("invalid_skill"));
    const { container } = renderCatalog([workspaceSkill], { uploadSkill }, onSkillsChanged);
    const input = container.querySelector('input[type="file"]');
    const file = new File(["skill"], "SKILL.md", { type: "text/markdown" });

    fireEvent.change(input!, { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The skill package or frontmatter is invalid.",
    );
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it("prompts to overwrite when a conflict occurs and updates successfully", async () => {
    const onSkillsChanged = vi.fn().mockResolvedValue(undefined);
    const uploadSkill = vi
      .fn()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({
        name: "uploaded-skill",
        updated: true,
        available: true,
        unavailable_reason: "",
      });
    const { container, client } = renderCatalog([workspaceSkill], { uploadSkill }, onSkillsChanged);
    const input = container.querySelector('input[type="file"]');
    const file = new File(["---\nname: existing-skill\ndescription: test\n---\n"], "SKILL.md", {
      type: "text/markdown",
    });

    fireEvent.change(input!, { target: { files: [file] } });

    const overwriteDialog = await screen.findByRole("alertdialog");
    expect(overwriteDialog).toHaveTextContent("Update existing skill?");
    expect(overwriteDialog).toHaveTextContent('A workspace skill named "existing-skill" already exists.');

    fireEvent.click(screen.getByRole("button", { name: "Update skill" }));

    await waitFor(() => {
      expect(client.uploadSkill).toHaveBeenNthCalledWith(
        2,
        "SKILL.md",
        expect.any(String),
        { overwrite: true },
      );
    });
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent("Updated uploaded-skill.");
  });

  it("accepts a dropped .skill package", async () => {
    const { client } = renderCatalog([workspaceSkill]);
    const dropZone = screen.getByRole("button", { name: "Choose a skill file or drop it here" });
    const file = new File(["package"], "custom.skill", { type: "application/zip" });

    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file], types: ["Files"] },
    });

    await waitFor(() => {
      expect(client.uploadSkill).toHaveBeenCalledWith("custom.skill", expect.any(String), { overwrite: false });
    });
  });

  it("shows delete confirmation only for workspace skills", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const name = String(input).endsWith("builtin-skill") ? "builtin-skill" : "custom-skill";
        return {
          ok: true,
          status: 200,
          json: async () => skillDetail(name, name === "custom-skill" ? "workspace" : "builtin"),
        } as Response;
      }),
    );

    const { client, onSkillsChanged } = renderCatalog();
    fireEvent.click(screen.getByRole("button", { name: "Open details for custom-skill" }));
    expect(await screen.findByRole("button", { name: "Delete workspace skill" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete workspace skill" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));

    await waitFor(() => expect(client.deleteSkill).toHaveBeenCalledWith("custom-skill"));
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open details for builtin-skill" }));
    await waitFor(() => expect(screen.getByText("A built-in skill")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Delete workspace skill" })).not.toBeInTheDocument();
  });

  it("displays error inside AlertDialog when deletion fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => skillDetail("custom-skill", "workspace"),
      } as Response)),
    );

    const deleteSkill = vi.fn().mockRejectedValue(new Error("forbidden"));
    renderCatalog([workspaceSkill], { deleteSkill });

    fireEvent.click(screen.getByRole("button", { name: "Open details for custom-skill" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete workspace skill" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));

    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith("custom-skill"));
    expect(await screen.findByRole("alert")).toHaveTextContent("This skill cannot be changed.");
    // Dialog remains open showing the error
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("shows upload success and refresh error when refresh fails after upload", async () => {
    const onSkillsChanged = vi.fn().mockRejectedValue(new Error("network error"));
    const { container } = renderCatalog([workspaceSkill], {}, onSkillsChanged);
    const input = container.querySelector('input[type="file"]');
    const file = new File(["---\nname: ok-skill\ndescription: desc\n---\n"], "SKILL.md", {
      type: "text/markdown",
    });

    fireEvent.change(input!, { target: { files: [file] } });

    expect(await screen.findByRole("status")).toHaveTextContent("Uploaded uploaded-skill.");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The skill changed, but the list could not be refreshed.",
    );
  });

  it("does not trigger an error when file selection is empty", async () => {
    const { container } = renderCatalog([workspaceSkill]);
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input!, { target: { files: [] } });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
