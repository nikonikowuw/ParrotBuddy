import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSkills } from "@/hooks/useSkills";
import * as api from "@/lib/api";
import type { SkillSummary, SkillsPayload } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchSkills: vi.fn() };
});

const builtinSkill: SkillSummary = {
  name: "builtin-skill",
  description: "Built-in skill",
  source: "builtin",
  available: true,
};
const workspaceSkill: SkillSummary = {
  name: "workspace-skill",
  description: "Workspace skill",
  source: "workspace",
  available: true,
};

function payload(...skills: SkillSummary[]): SkillsPayload {
  return { skills };
}

describe("useSkills", () => {
  beforeEach(() => {
    vi.mocked(api.fetchSkills).mockReset();
  });

  it("loads skills and refreshes the shared list", async () => {
    vi.mocked(api.fetchSkills)
      .mockResolvedValueOnce(payload(builtinSkill))
      .mockResolvedValueOnce(payload(workspaceSkill));

    const { result } = renderHook(() => useSkills("token"));
    await waitFor(() => expect(result.current.skills).toEqual([builtinSkill]));

    await act(async () => {
      await result.current.refresh();
    });

    expect(api.fetchSkills).toHaveBeenNthCalledWith(1, "token");
    expect(api.fetchSkills).toHaveBeenNthCalledWith(2, "token");
    expect(result.current.skills).toEqual([workspaceSkill]);
  });

  it("ignores an older response when refreshes overlap", async () => {
    let resolveStale!: (value: SkillsPayload) => void;
    let resolveLatest!: (value: SkillsPayload) => void;
    vi.mocked(api.fetchSkills)
      .mockResolvedValueOnce(payload(builtinSkill))
      .mockImplementationOnce(
        () => new Promise<SkillsPayload>((resolve) => { resolveStale = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise<SkillsPayload>((resolve) => { resolveLatest = resolve; }),
      );

    const { result } = renderHook(() => useSkills("token"));
    await waitFor(() => expect(result.current.skills).toEqual([builtinSkill]));

    let staleRefresh!: Promise<void>;
    let latestRefresh!: Promise<void>;
    act(() => {
      staleRefresh = result.current.refresh();
      latestRefresh = result.current.refresh();
    });

    await act(async () => {
      resolveLatest(payload(workspaceSkill));
      await latestRefresh;
    });
    expect(result.current.skills).toEqual([workspaceSkill]);

    await act(async () => {
      resolveStale(payload(builtinSkill));
      await staleRefresh;
    });
    expect(result.current.skills).toEqual([workspaceSkill]);
  });

  it("preserves existing skills when a refresh fails", async () => {
    vi.mocked(api.fetchSkills)
      .mockResolvedValueOnce(payload(builtinSkill))
      .mockRejectedValueOnce(new Error("network failure"));

    const { result } = renderHook(() => useSkills("token"));
    await waitFor(() => expect(result.current.skills).toEqual([builtinSkill]));

    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow("network failure");
    });

    expect(result.current.skills).toEqual([builtinSkill]);
  });
});
