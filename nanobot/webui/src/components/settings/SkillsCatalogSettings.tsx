import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import {
  Brain,
  Check,
  CircleAlert,
  FileUp,
  KeyRound,
  Loader2,
  Terminal,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useClipboardAndDrop } from "@/hooks/useClipboardAndDrop";
import { bufferToBase64 } from "@/lib/binary";
import { fetchSkillDetail } from "@/lib/api";
import type { SkillDetail, SkillSummary } from "@/lib/types";
import type { SkillUploadResult } from "@/lib/nanobot-client";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";

const MAX_SKILL_UPLOAD_BYTES = 16 * 1024 * 1024;
const SKILL_ERROR_KEYS: Record<string, string> = {
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

interface PendingOverwrite {
  file: File;
  skillName: string;
}

async function extractSkillName(file: File): Promise<string> {
  if (file.name.endsWith(".skill")) {
    return file.name.slice(0, -".skill".length);
  }
  if (file.name === "SKILL.md") {
    try {
      const text = await file.slice(0, 2048).text();
      const match = text.match(/^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)/m);
      if (match) return match[1];
    } catch {
      // ignore
    }
  }
  return file.name;
}

function skillMutationErrorMessage(error: unknown, t: TFunction): string {
  const token = error instanceof Error ? error.message : "failed";
  const key = SKILL_ERROR_KEYS[token] ?? SKILL_ERROR_KEYS.failed;
  return t(key, { defaultValue: t(SKILL_ERROR_KEYS.failed) });
}

function getErrorSkillName(error: unknown): string {
  if (error && typeof error === "object" && "skillName" in error && typeof error.skillName === "string") {
    return error.skillName;
  }
  return "";
}

function formatUploadSuccessMessage(result: SkillUploadResult, t: TFunction): string {
  if (!result.available && result.unavailable_reason) {
    if (result.updated) {
      return t("settings.skills.uploadSuccessUpdatedWithNotice", {
        name: result.name,
        reason: result.unavailable_reason,
      });
    }
    return t("settings.skills.uploadSuccessWithNotice", {
      name: result.name,
      reason: result.unavailable_reason,
    });
  }
  if (result.updated) {
    return t("settings.skills.uploadSuccessUpdated", { name: result.name });
  }
  return t("settings.skills.uploadSuccess", { name: result.name });
}

export interface SkillsCatalogSettingsProps {
  skills: SkillSummary[];
  onSkillsChanged?: () => Promise<void>;
}

export function SkillsCatalogSettings({
  skills,
  onSkillsChanged,
}: SkillsCatalogSettingsProps) {
  const { client } = useClient();
  const { t } = useTranslation();
  const availableCount = skills.filter((skill) => skill.available).length;
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillSummary | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<PendingOverwrite | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationSuccess, setOperationSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const triggerRefresh = useCallback(async () => {
    try {
      await onSkillsChanged?.();
    } catch {
      setOperationError(t("settings.skills.errors.refresh"));
    }
  }, [onSkillsChanged, t]);

  const uploadFile = useCallback(
    async (file: File, overwrite = false) => {
      setOperationError(null);
      setOperationSuccess(null);
      if (file.name !== "SKILL.md" && !file.name.endsWith(".skill")) {
        setOperationError(t("settings.skills.errors.invalidFile"));
        return;
      }
      if (file.size > MAX_SKILL_UPLOAD_BYTES) {
        setOperationError(t("settings.skills.errors.size"));
        return;
      }
      setUploading(true);
      try {
        const base64 = bufferToBase64(await file.arrayBuffer());
        const result = await client.uploadSkill(file.name, base64, { overwrite });
        setPendingOverwrite(null);
        setOperationSuccess(formatUploadSuccessMessage(result, t));
        await triggerRefresh();
      } catch (error) {
        const token = error instanceof Error ? error.message : "failed";
        if (token === "conflict") {
          const derivedName = getErrorSkillName(error) || (await extractSkillName(file));
          setPendingOverwrite({ file, skillName: derivedName });
        } else {
          setOperationSuccess(null);
          setOperationError(skillMutationErrorMessage(error, t));
        }
      } finally {
        setUploading(false);
      }
    },
    [client, t, triggerRefresh],
  );

  const handleFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (files.length > 1) {
        setOperationSuccess(null);
        setOperationError(t("settings.skills.errors.singleFile"));
        return;
      }
      void uploadFile(files[0]);
    },
    [t, uploadFile],
  );
  const drop = useClipboardAndDrop(handleFiles);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    setOperationError(null);
    setOperationSuccess(null);
    try {
      await client.deleteSkill(pendingDelete.name);
      const deletedName = pendingDelete.name;
      setPendingDelete(null);
      setSelectedSkill(null);
      setOperationSuccess(t("settings.skills.deleteSuccess", { name: deletedName }));
      await triggerRefresh();
    } catch (error) {
      const msg = skillMutationErrorMessage(error, t);
      setDeleteError(msg);
      setOperationError(msg);
    } finally {
      setDeleting(false);
    }
  }, [client, pendingDelete, t, triggerRefresh]);

  return (
    <div className="space-y-7">
      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-[680px] text-[13px] leading-5 text-muted-foreground">
          {t("settings.skills.description", {
            defaultValue: "Review the instruction skills this agent can load during a conversation.",
          })}
        </p>
        <span className="text-[12px] font-medium text-muted-foreground">
          {t("settings.skills.caption", {
            available: availableCount,
            total: skills.length,
            defaultValue: "{{available}} available · {{total}} total",
          })}
        </span>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
            {t("settings.skills.manageTitle")}
          </h2>
          <p className="mt-1 px-1 text-[13px] leading-5 text-muted-foreground">
            {t("settings.skills.manageDescription")}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".skill,.md"
          className="sr-only"
          onChange={(event) => {
            handleFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          disabled={uploading}
          aria-label={t("settings.skills.uploadDrop")}
          onClick={() => inputRef.current?.click()}
          onDragEnter={drop.onDragEnter}
          onDragOver={drop.onDragOver}
          onDragLeave={drop.onDragLeave}
          onDrop={drop.onDrop}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed px-5 py-7 text-center transition-colors",
            "border-border/70 bg-muted/15 hover:border-primary/50 hover:bg-muted/30",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            drop.isDragging && "border-primary bg-primary/10",
            uploading && "cursor-wait opacity-70",
          )}
        >
          {uploading ? (
            <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
          ) : (
            <FileUp className="h-6 w-6 text-muted-foreground" aria-hidden />
          )}
          <span className="text-[14px] font-medium text-foreground">
            {uploading ? t("settings.skills.uploading") : t("settings.skills.uploadDrop")}
          </span>
          <span className="text-[12px] text-muted-foreground">
            {t("settings.skills.uploadFormats")}
          </span>
        </button>
        {operationError ? (
          <p role="alert" className="rounded-[12px] bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {operationError}
          </p>
        ) : null}
        {operationSuccess ? (
          <p role="status" className="rounded-[12px] bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-700 dark:text-emerald-300">
            {operationSuccess}
          </p>
        ) : null}
      </section>

      <section>
        <div className="flex items-center justify-between border-b border-border/45 pb-3">
          <h2 className="mb-2 px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
            {t("settings.skills.featured", { defaultValue: "Agent skills" })}
          </h2>
          <span className="rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium text-muted-foreground">
            {skills.length}
          </span>
        </div>
        {skills.length ? (
          <div className="grid gap-x-10 gap-y-1 py-3 md:grid-cols-2">
            {skills.map((skill) => (
              <SkillCatalogRow
                key={`${skill.source}:${skill.name}`}
                skill={skill}
                onSelect={setSelectedSkill}
              />
            ))}
          </div>
        ) : (
          <div className="px-3 py-12 text-center text-sm text-muted-foreground">
            {t("settings.skills.empty", { defaultValue: "No skills are available." })}
          </div>
        )}
      </section>

      <SkillDetailSheet
        skill={selectedSkill}
        open={selectedSkill !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedSkill(null);
        }}
        onRequestDelete={(skill) => {
          setDeleteError(null);
          setPendingDelete(skill);
        }}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.skills.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.skills.deleteDescription", { name: pendingDelete?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p role="alert" className="rounded-[12px] bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("settings.skills.deleteCancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? t("settings.skills.deleting") : t("settings.skills.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingOverwrite !== null}
        onOpenChange={(open) => {
          if (!open && !uploading) setPendingOverwrite(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.skills.overwriteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.skills.overwriteDescription", {
                name: pendingOverwrite?.skillName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uploading}>
              {t("settings.skills.overwriteCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={uploading}
              onClick={(event) => {
                event.preventDefault();
                if (pendingOverwrite) {
                  void uploadFile(pendingOverwrite.file, true);
                }
              }}
            >
              {uploading ? t("settings.skills.uploading") : t("settings.skills.overwriteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface SkillCatalogRowProps {
  skill: SkillSummary;
  onSelect: (skill: SkillSummary) => void;
}

function SkillCatalogRow({
  skill,
  onSelect,
}: SkillCatalogRowProps) {
  const { t } = useTranslation();
  const sourceLabel = skillSourceLabel(skill.source, t);
  const StatusIcon = skill.available ? Check : CircleAlert;
  const statusLabel = skill.available
    ? t("settings.skills.statusAvailable", { defaultValue: "Available" })
    : t("settings.skills.statusUnavailable", { defaultValue: "Unavailable" });

  return (
    <button
      type="button"
      aria-label={t("settings.skills.openDetails", {
        name: skill.name,
        defaultValue: "Open details for {{name}}",
      })}
      onClick={() => onSelect(skill)}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-[16px] px-3 py-3 text-left transition-colors",
        "hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !skill.available && "opacity-65",
      )}
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-muted/70 text-muted-foreground">
        <Brain className="h-5 w-5" strokeWidth={1.8} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[15px] font-semibold leading-5 text-foreground">
            {skill.name}
          </h3>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
            {sourceLabel}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
          {skill.description}
        </p>
        {!skill.available && skill.unavailable_reason ? (
          <p className="mt-1 truncate text-[12px] leading-4 text-muted-foreground/80">
            {t("settings.skills.unavailableReason", {
              reason: skill.unavailable_reason,
              defaultValue: "Missing: {{reason}}",
            })}
          </p>
        ) : null}
      </div>
      <span
        title={!skill.available && skill.unavailable_reason ? skill.unavailable_reason : undefined}
        className={cn(
          "hidden shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium sm:inline-flex",
          skill.available
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "bg-muted text-muted-foreground",
        )}
      >
        <StatusIcon className="h-3.5 w-3.5" aria-hidden />
        {statusLabel}
      </span>
    </button>
  );
}

interface SkillDetailSheetProps {
  skill: SkillSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestDelete: (skill: SkillSummary) => void;
}

function SkillDetailSheet({
  skill,
  open,
  onOpenChange,
  onRequestDelete,
}: SkillDetailSheetProps) {
  const { token } = useClient();
  const { t } = useTranslation();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open || !skill) return;
    let cancelled = false;
    setDetail(null);
    setLoading(true);
    setLoadFailed(false);
    fetchSkillDetail(token, skill.name)
      .then((payload) => {
        if (!cancelled) setDetail(payload);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, skill, token]);

  if (!skill) return null;

  const activeSkill = detail ?? skill;
  const sourceLabel = skillSourceLabel(activeSkill.source, t);
  const statusLabel = activeSkill.available
    ? t("settings.skills.statusAvailable", { defaultValue: "Available" })
    : t("settings.skills.statusUnavailable", { defaultValue: "Unavailable" });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[min(34rem,calc(100vw-1rem))] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="flex items-start gap-3 pr-8">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px] bg-muted/70 text-muted-foreground">
              <Brain className="h-5 w-5" strokeWidth={1.8} aria-hidden />
            </div>
            <div className="min-w-0">
              <SheetTitle className="truncate text-[20px] font-semibold">
                {activeSkill.name}
              </SheetTitle>
              <SheetDescription className="sr-only">
                {t("settings.skills.detailDescription", {
                  name: activeSkill.name,
                  defaultValue: "Details for {{name}}.",
                })}
              </SheetDescription>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                <Pill>{sourceLabel}</Pill>
                <Pill tone={activeSkill.available ? "success" : "muted"}>{statusLabel}</Pill>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t("settings.skills.loadingDetail", { defaultValue: "Loading skill details..." })}
            </div>
          ) : loadFailed ? (
            <div className="mt-8 rounded-[16px] bg-destructive/10 px-3 py-3 text-sm text-destructive">
              {t("settings.skills.loadFailed", { defaultValue: "Could not load skill details." })}
            </div>
          ) : (
            <div className="mt-7 space-y-6">
              <DetailSection title={t("settings.skills.descriptionTitle", { defaultValue: "Description" })}>
                <p className="text-[14px] leading-6 text-muted-foreground">{activeSkill.description}</p>
              </DetailSection>

              <div className="grid grid-cols-2 gap-2">
                <MetaItem
                  label={t("settings.skills.source", { defaultValue: "Source" })}
                  value={sourceLabel}
                />
                <MetaItem
                  label={t("settings.skills.status", { defaultValue: "Status" })}
                  value={statusLabel}
                />
              </div>

              {!activeSkill.available && activeSkill.unavailable_reason ? (
                <DetailSection
                  title={t("settings.skills.unavailableReasonLabel", {
                    defaultValue: "Unavailable reason",
                  })}
                >
                  <p className="text-[13px] leading-5 text-destructive/85">
                    {activeSkill.unavailable_reason}
                  </p>
                </DetailSection>
              ) : null}

              {detail ? <RequirementsSection detail={detail} /> : null}

              {detail ? <RawInstructionsBlock markdown={detail.raw_markdown} /> : null}
            </div>
          )}
          {skill.source === "workspace" ? (
            <div className="mt-8 border-t border-border/45 pt-5">
              <Button
                type="button"
                variant="destructive"
                className="w-full justify-center gap-2"
                onClick={() => onRequestDelete(skill)}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                {t("settings.skills.deleteAction")}
              </Button>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RawInstructionsBlock({ markdown }: { markdown: string }) {
  const { t } = useTranslation();
  const content =
    markdown ||
    t("settings.skills.rawInstructionsEmpty", {
      defaultValue: "No raw instructions.",
    });

  return (
    <details className="group rounded-[18px] border border-border/45 bg-muted/20 px-3 py-3">
      <summary className="cursor-pointer select-none text-[13px] font-medium text-foreground/90 transition-colors hover:text-foreground">
        {t("settings.skills.rawInstructions", { defaultValue: "Raw SKILL.md" })}
      </summary>
      <div className="mt-3 overflow-hidden rounded-[14px] border border-border/35 bg-background/70">
        <pre
          className={cn(
            "max-h-[min(42vh,32rem)] overflow-auto overscroll-contain px-3.5 py-3 pr-4",
            "whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.7] text-foreground/62",
            "scrollbar-thin scrollbar-track-transparent",
            "[&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5",
            "[&::-webkit-scrollbar-thumb]:bg-muted-foreground/25",
          )}
        >
          {content}
        </pre>
      </div>
    </details>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] bg-muted/35 px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-medium text-foreground">{value}</div>
    </div>
  );
}

function RequirementsSection({ detail }: { detail: SkillDetail }) {
  const { t } = useTranslation();
  const { bins, env, missing_bins, missing_env } = detail.requirements;
  const hasRequirements = bins.length > 0 || env.length > 0;

  return (
    <DetailSection title={t("settings.skills.requirements", { defaultValue: "Requirements" })}>
      {hasRequirements ? (
        <div className="space-y-3">
          {missing_bins.length ? (
            <RequirementLine
              title={t("settings.skills.missingCommands", { defaultValue: "Missing CLI" })}
              items={missing_bins}
              tone="danger"
              icon={<Terminal className="h-3.5 w-3.5" aria-hidden />}
            />
          ) : null}
          {missing_env.length ? (
            <RequirementLine
              title={t("settings.skills.missingEnvironment", { defaultValue: "Missing ENV" })}
              items={missing_env}
              tone="danger"
              icon={<KeyRound className="h-3.5 w-3.5" aria-hidden />}
            />
          ) : null}
          {bins.length ? (
            <RequirementLine
              title={t("settings.skills.commands", { defaultValue: "Commands" })}
              items={bins}
              icon={<Terminal className="h-3.5 w-3.5" aria-hidden />}
            />
          ) : null}
          {env.length ? (
            <RequirementLine
              title={t("settings.skills.environment", { defaultValue: "Environment variables" })}
              items={env}
              icon={<KeyRound className="h-3.5 w-3.5" aria-hidden />}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {t("settings.skills.noRequirements", { defaultValue: "No explicit requirements." })}
        </p>
      )}
    </DetailSection>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function RequirementLine({
  title,
  items,
  icon,
  tone = "muted",
}: {
  title: string;
  items: string[];
  icon: ReactNode;
  tone?: "muted" | "danger";
}) {
  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "flex items-center gap-1.5 text-[12px]",
          tone === "danger" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {icon}
        {title}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <Pill key={item}>{item}</Pill>
        ))}
      </div>
    </div>
  );
}

function Pill({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "success";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "success"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function skillSourceLabel(source: string, t: TFunction): string {
  if (source === "workspace") {
    return t("settings.skills.sourceWorkspace", { defaultValue: "Custom" });
  }
  if (source === "builtin") {
    return t("settings.skills.sourceBuiltin", { defaultValue: "Built-in" });
  }
  return source;
}
