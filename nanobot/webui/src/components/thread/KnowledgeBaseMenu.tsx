import { useTranslation } from "react-i18next";

import {
  BookOpen,
  ChevronDown,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Knowledge-base selector for configured LightRAG servers. The selection is
 * stored as server names and sent to the backend as lightrag_workspaces.
 */
export interface KnowledgeBaseMenuProps {
  /** Server names sourced from settings (config.tools.lightrag.servers). */
  options: string[];
  /** Currently selected server names. */
  selected: string[];
  isHero: boolean;
  disabled?: boolean;
  onChange?: (next: string[]) => void;
}

export function KnowledgeBaseMenu({
  options,
  selected,
  isHero,
  disabled,
  onChange,
}: KnowledgeBaseMenuProps) {
  const { t } = useTranslation();
  const interactive = !disabled && !!onChange;
  const hasSelection = selected.length > 0;

  const toggleNamed = (name: string) => {
    if (!onChange) return;
    const next = selected.includes(name)
      ? selected.filter((item) => item !== name)
      : [...selected, name];
    onChange(next);
  };

  const clear = () => {
    if (onChange && hasSelection) onChange([]);
  };

  const triggerLabel = !hasSelection
    ? t("thread.composer.knowledgeBase.label")
    : t("thread.composer.knowledgeBase.selectedCount", {
        count: selected.length,
      });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!interactive}>
        <Button
          type="button"
          variant="ghost"
          aria-label={t("thread.composer.knowledgeBase.ariaLabel")}
          title={t("thread.composer.knowledgeBase.tooltip")}
          className={cn(
            "max-w-[min(12.5rem,42vw)] rounded-[10px] border border-transparent font-semibold shadow-none",
            isHero ? "h-8 px-2.5 text-[12px]" : "h-9 px-3 text-[12.5px]",
            hasSelection
              ? "bg-transparent text-sky-600 hover:bg-sky-500/8 dark:text-sky-300 dark:hover:bg-sky-400/10"
              : "bg-transparent text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground dark:hover:bg-white/[0.06]",
          )}
        >
          <BookOpen className="mr-1.5 h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{triggerLabel}</span>
          {hasSelection ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={t("thread.composer.knowledgeBase.clear")}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                clear();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  clear();
                }
              }}
              className="ml-1 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </span>
          ) : (
            <ChevronDown className="ml-1.5 h-3 w-3 shrink-0" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>
          {t("thread.composer.knowledgeBase.label")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.length > 0 ? (
          <>
            {options.map((name) => (
              <DropdownMenuCheckboxItem
                key={name}
                checked={selected.includes(name)}
                onCheckedChange={() => toggleNamed(name)}
                onSelect={(e) => e.preventDefault()}
              >
                {name}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        ) : (
          <div className="px-2.5 py-1.5 text-[12px] text-muted-foreground">
            {t("thread.composer.knowledgeBase.none")}
          </div>
        )}
        {hasSelection ? (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              onClick={clear}
              className="w-full px-2.5 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t("thread.composer.knowledgeBase.clear")}
            </button>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
