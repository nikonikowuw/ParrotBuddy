import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import {
  MAX_SKILL_UPLOAD_BYTES,
  SKILL_ERROR_KEYS,
  extractSkillName,
  formatUploadSuccessMessage,
  isSupportedSkillFile,
  skillErrorName,
  skillErrorToken,
  skillMutationErrorMessage,
} from "@/lib/skills";
import { SkillMutationError, type SkillUploadResult } from "@/lib/nanobot-client";

/** Minimal TFunction stand-in that echoes the key and its interpolation. */
function fakeT(): TFunction {
  const t = ((key: string, options?: Record<string, unknown>) => {
    if (!options) return key;
    const parts = Object.entries(options)
      .filter(([name]) => name !== "defaultValue")
      .map(([name, value]) => `${name}=${String(value)}`);
    return parts.length ? `${key}(${parts.join(",")})` : key;
  }) as unknown as TFunction;
  return t;
}

function uploadResult(overrides: Partial<SkillUploadResult> = {}): SkillUploadResult {
  return {
    name: "demo-skill",
    updated: false,
    available: true,
    unavailable_reason: "",
    ...overrides,
  };
}

describe("skill file helpers", () => {
  it("accepts only SKILL.md and .skill artifacts", () => {
    expect(isSupportedSkillFile("SKILL.md")).toBe(true);
    expect(isSupportedSkillFile("demo.skill")).toBe(true);
    expect(isSupportedSkillFile("skill.md")).toBe(false);
    expect(isSupportedSkillFile("demo.zip")).toBe(false);
    expect(isSupportedSkillFile("SKILL.md.bak")).toBe(false);
  });

  it("derives a package skill name from the file name", async () => {
    const file = new File(["zip"], "packaged-skill.skill");
    expect(await extractSkillName(file)).toBe("packaged-skill");
  });

  it("derives a standalone skill name from frontmatter", async () => {
    const file = new File(
      ["---\nname: from-frontmatter\ndescription: test\n---\n"],
      "SKILL.md",
    );
    expect(await extractSkillName(file)).toBe("from-frontmatter");
  });

  it("falls back to the file name when frontmatter has no usable name", async () => {
    const file = new File(["---\ndescription: nameless\n---\n"], "SKILL.md");
    expect(await extractSkillName(file)).toBe("SKILL.md");
  });
});

describe("skill error normalization", () => {
  it("reads the stable token from a SkillMutationError", () => {
    expect(skillErrorToken(new SkillMutationError("conflict", "demo-skill"))).toBe("conflict");
    expect(skillErrorName(new SkillMutationError("conflict", "demo-skill"))).toBe("demo-skill");
  });

  it("ignores a skill name on non-conflict failures", () => {
    expect(skillErrorName(new SkillMutationError("forbidden"))).toBe("");
    expect(skillErrorName(new Error("forbidden"))).toBe("");
    expect(skillErrorName(undefined)).toBe("");
  });

  it("degrades unknown failures to the generic token", () => {
    expect(skillErrorToken(new Error("boom"))).toBe("boom");
    expect(skillErrorToken(new Error(""))).toBe("failed");
    expect(skillErrorToken({ weird: true })).toBe("failed");
    expect(skillErrorToken(null)).toBe("failed");
  });

  it("maps every token to a localized key", () => {
    const t = fakeT();
    for (const [token, key] of Object.entries(SKILL_ERROR_KEYS)) {
      expect(skillMutationErrorMessage(new SkillMutationError(token), t)).toBe(key);
    }
  });

  it("uses the generic message for an unrecognized token", () => {
    const t = fakeT();
    expect(skillMutationErrorMessage(new SkillMutationError("mystery"), t)).toBe(
      SKILL_ERROR_KEYS.failed,
    );
  });
});

describe("upload success message", () => {
  it("reports a plain upload and an update", () => {
    const t = fakeT();
    expect(formatUploadSuccessMessage(uploadResult(), t)).toBe(
      "settings.skills.uploadSuccess(name=demo-skill)",
    );
    expect(formatUploadSuccessMessage(uploadResult({ updated: true }), t)).toBe(
      "settings.skills.uploadSuccessUpdated(name=demo-skill)",
    );
  });

  it("reports the reason when the skill installs but is unavailable", () => {
    const t = fakeT();
    const unavailable = uploadResult({ available: false, unavailable_reason: "missing: uv" });

    expect(formatUploadSuccessMessage(unavailable, t)).toBe(
      "settings.skills.uploadSuccessWithNotice(name=demo-skill,reason=missing: uv)",
    );
    expect(formatUploadSuccessMessage({ ...unavailable, updated: true }, t)).toBe(
      "settings.skills.uploadSuccessUpdatedWithNotice(name=demo-skill,reason=missing: uv)",
    );
  });

  it("does not surface a notice when the reason is empty", () => {
    const t = fakeT();
    expect(formatUploadSuccessMessage(uploadResult({ available: false }), t)).toBe(
      "settings.skills.uploadSuccess(name=demo-skill)",
    );
  });
});

describe("upload size limit", () => {
  it("matches the value the component enforces", () => {
    expect(MAX_SKILL_UPLOAD_BYTES).toBe(16 * 1024 * 1024);
  });
});
