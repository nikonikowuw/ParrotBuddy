/**
 * Skill mutation payload helpers.
 *
 * Mutation-error normalization lives here rather than in
 * ``SkillsCatalogSettings`` so the component only orchestrates state and
 * rendering, and so these rules can be unit tested without React.
 */

import type { TFunction } from "i18next";

import { SkillMutationError } from "./nanobot-client";
import type { SkillUploadResult } from "./nanobot-client";

export const MAX_SKILL_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Stable backend error tokens mapped to their message catalog keys. */
export const SKILL_ERROR_KEYS: Record<string, string> = {
  invalid_file: "settings.skills.errors.invalidFile",
  invalid_path: "settings.skills.errors.invalidPath",
  invalid_skill: "settings.skills.errors.invalidSkill",
  conflict: "settings.skills.errors.conflict",
  forbidden: "settings.skills.errors.forbidden",
  not_found: "settings.skills.errors.notFound",
  size: "settings.skills.errors.size",
  decode: "settings.skills.errors.decode",
  failed: "settings.skills.errors.failed",
};

const SKILL_PACKAGE_SUFFIX = ".skill";
const SKILL_MARKDOWN_NAME = "SKILL.md";
/** Only the frontmatter header is needed to recover a standalone skill name. */
const FRONTMATTER_PROBE_BYTES = 2048;
const FRONTMATTER_NAME_RE = /^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)/m;

/** Return whether a picked file is a supported skill artifact. */
export function isSupportedSkillFile(filename: string): boolean {
  return filename === SKILL_MARKDOWN_NAME || filename.endsWith(SKILL_PACKAGE_SUFFIX);
}

/**
 * Recover the skill name a standalone ``SKILL.md`` will be installed under.
 *
 * Used only to label the overwrite confirmation before the server has been
 * asked; the server remains the authority on the final name.
 */
export async function extractSkillName(file: File): Promise<string> {
  if (file.name.endsWith(SKILL_PACKAGE_SUFFIX)) {
    return file.name.slice(0, -SKILL_PACKAGE_SUFFIX.length);
  }
  if (file.name === SKILL_MARKDOWN_NAME) {
    try {
      const text = await file.slice(0, FRONTMATTER_PROBE_BYTES).text();
      const match = text.match(FRONTMATTER_NAME_RE);
      if (match) return match[1];
    } catch {
      // Fall through to the filename when the header cannot be read.
    }
  }
  return file.name;
}

/** Normalize a thrown value into the skill error token it represents. */
export function skillErrorToken(error: unknown): string {
  if (error instanceof SkillMutationError) return error.token;
  if (error instanceof Error && error.message) return error.message;
  return "failed";
}

/** Localize a skill mutation failure, falling back to the generic message. */
export function skillMutationErrorMessage(error: unknown, t: TFunction): string {
  const token = skillErrorToken(error);
  const key = SKILL_ERROR_KEYS[token] ?? SKILL_ERROR_KEYS.failed;
  return t(key, { defaultValue: t(SKILL_ERROR_KEYS.failed) });
}

/** Return the conflicting skill name reported by a failed upload, if any. */
export function skillErrorName(error: unknown): string {
  return error instanceof SkillMutationError ? error.skillName : "";
}

/** Localize the outcome of a successful upload or update. */
export function formatUploadSuccessMessage(result: SkillUploadResult, t: TFunction): string {
  const noticeKey = result.updated
    ? "settings.skills.uploadSuccessUpdatedWithNotice"
    : "settings.skills.uploadSuccessWithNotice";
  if (!result.available && result.unavailable_reason) {
    return t(noticeKey, { name: result.name, reason: result.unavailable_reason });
  }
  return t(
    result.updated ? "settings.skills.uploadSuccessUpdated" : "settings.skills.uploadSuccess",
    { name: result.name },
  );
}
