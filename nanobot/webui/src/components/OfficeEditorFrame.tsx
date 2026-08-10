import type { RefObject } from "react";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Map a server save-error token to an i18n key (unknown tokens render raw). */
const SAVE_ERROR_KEYS: Record<string, string> = {
  size: "filePreview.saveError.size",
  forbidden: "filePreview.saveError.forbidden",
  not_found: "filePreview.saveError.notFound",
  invalid_path: "filePreview.saveError.invalidPath",
  decode: "filePreview.saveError.decode",
  failed: "filePreview.saveError.failed",
  missing_path: "filePreview.saveError.malformed",
  missing_content: "filePreview.saveError.malformed",
  missing_request_id: "filePreview.saveError.malformed",
  invalid_chat_id: "filePreview.saveError.malformed",
};

interface OfficeEditorFrameProps {
  /** Display name shown in the editor header. */
  fileName: string;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  /** Raw save-error token or message; tokens are localized for display. */
  saveError: string | null;
  /** False keeps Save disabled until the document actually changed. */
  dirty: boolean;
  /** Persist the edited document; must resolve once the server wrote it. */
  onSave: () => void;
  /** Return to the read-only preview pane. */
  onBack: () => void;
  /** Editor host element; the concrete editor mounts into this node. */
  containerRef: RefObject<HTMLDivElement>;
  /** Extra classes for the editor host (e.g. a white canvas background). */
  containerClassName?: string;
}

/**
 * Shared chrome for the in-panel Office editors (header with back/save,
 * save-error banner, loading/load-error overlays, editor host). The concrete
 * editors only differ in how they fetch, mount, and serialize their format.
 */
export function OfficeEditorFrame({
  fileName,
  loading,
  loadError,
  saving,
  saveError,
  dirty,
  onSave,
  onBack,
  containerRef,
  containerClassName,
}: OfficeEditorFrameProps) {
  const { t } = useTranslation();
  const saveErrorKey = saveError ? SAVE_ERROR_KEYS[saveError] : undefined;
  const saveErrorMessage = saveErrorKey
    ? t(saveErrorKey, { defaultValue: saveError })
    : saveError;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onBack}
          disabled={saving}
          className="shrink-0"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          <span className="ml-1.5">
            {t("filePreview.backToPreview", { defaultValue: "Back to preview" })}
          </span>
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/70">
          {fileName}
        </span>
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={saving || loading || !!loadError || !dirty}
          className="shrink-0"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          <span className="ml-1.5">
            {t("filePreview.save", { defaultValue: "Save" })}
          </span>
        </Button>
      </div>
      {saveErrorMessage ? (
        <div className="shrink-0 border-b border-border/60 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("filePreview.saveFailed", { defaultValue: "Could not save this file." })}{" "}
          {saveErrorMessage}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/60 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("filePreview.loadingEditor", { defaultValue: "Loading editor..." })}
          </div>
        ) : null}
        {loadError ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-8 text-center text-sm text-muted-foreground">
            <div className="max-w-sm">
              <p>
                {t("filePreview.editorLoadFailed", {
                  defaultValue: "Could not open this file for editing.",
                })}
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground/70">{loadError}</p>
            </div>
          </div>
        ) : null}
        <div
          ref={containerRef}
          className={cn("h-full w-full overflow-hidden", containerClassName)}
        />
      </div>
    </div>
  );
}
