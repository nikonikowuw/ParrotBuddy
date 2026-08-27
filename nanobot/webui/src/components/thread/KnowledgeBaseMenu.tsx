import { useTranslation } from "react-i18next";

import {
  BookOpen,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Knowledge-base toggle for LightRAG.
 * TODO(MVP): In MVP version, enterprise knowledge base configuration and multi-server
 * selection are simplified into a single binary toggle (enabled/disabled).
 * Keep props compatible so multi-KB selection can be re-introduced later.
 */
export interface KnowledgeBaseMenuProps {
  /** Server names sourced from settings (config.tools.lightrag.servers). */
  options?: string[];
  /** Localized/display name for the built-in personal knowledge base. */
  personalLabel?: string | null;
  /** Currently selected server names. */
  selected: string[];
  isHero: boolean;
  disabled?: boolean;
  onChange?: (next: string[]) => void;
}

export function KnowledgeBaseMenu({
  options = [],
  selected,
  isHero,
  disabled,
  onChange,
}: KnowledgeBaseMenuProps) {
  const { t } = useTranslation();
  const interactive = !disabled && !!onChange;
  const isEnabled = selected.length > 0;

  const toggle = () => {
    if (!onChange) return;
    if (isEnabled) {
      onChange([]);
    } else {
      // Default to personal KB if present in options or "__personal__"
      const defaultTarget = options.includes("__personal__")
        ? "__personal__"
        : options[0] || "__personal__";
      onChange([defaultTarget]);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      disabled={!interactive}
      onClick={toggle}
      aria-label={t("thread.composer.knowledgeBase.ariaLabel")}
      aria-pressed={isEnabled}
      title={t("thread.composer.knowledgeBase.tooltip")}
      className={cn(
        "max-w-[min(12.5rem,42vw)] rounded-[10px] border border-transparent font-semibold shadow-none transition-colors",
        isHero ? "h-8 px-2.5 text-[12px]" : "h-9 px-3 text-[12.5px]",
        isEnabled
          ? "bg-transparent text-sky-600 hover:bg-sky-500/8 dark:text-sky-300 dark:hover:bg-sky-400/10"
          : "bg-transparent text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground dark:hover:bg-white/[0.06]",
      )}
    >
      <BookOpen className="mr-1.5 h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{t("thread.composer.knowledgeBase.label")}</span>
    </Button>
  );
}

