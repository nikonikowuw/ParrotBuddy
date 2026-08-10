import { useTranslation } from "react-i18next";

import {
  BookOpen,
  ChevronDown,
  Database,
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
 * UI sentinel marking "use the LightRAG server's default workspace" (no
 * LIGHTRAG-WORKSPACE header). Must match the backend _DEFAULT_SENTINEL in
 * nanobot/agent/tools/lightrag.py.
 */
export const DEFAULT_KB_SENTINEL = "__default__";

export interface KnowledgeBaseMenuProps {
  /** Named workspace allowlist sourced from settings (config.tools.lightrag.workspaces). */
  options: string[];
  /** Currently selected workspace names (may include the {@link DEFAULT_KB_SENTINEL}). */
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
  const isDefaultOnly =
    selected.length === 1 && selected[0] === DEFAULT_KB_SENTINEL;
  const namedSelected = selected.filter((w) => w !== DEFAULT_KB_SENTINEL);
  const hasSelection = selected.length > 0;

  const toggleDefault = () => {
    if (!onChange) return;
    onChange(isDefaultOnly ? [] : [DEFAULT_KB_SENTINEL]);
  };

  const toggleNamed = (name: string) => {
    if (!onChange) return;
    // Selecting a named workspace clears the Default sentinel (mutually exclusive).
    const withoutDefault = selected.filter((w) => w !== DEFAULT_KB_SENTINEL);
    const next = withoutDefault.includes(name)
      ? withoutDefault.filter((w) => w !== name)
      : [...withoutDefault, name];
    onChange(next);
  };

  const clear = () => {
    if (onChange && hasSelection) onChange([]);
  };

  const triggerLabel = !hasSelection
    ? t("thread.composer.knowledgeBase.label")
    : isDefaultOnly
      ? t("thread.composer.knowledgeBase.default")
      : t("thread.composer.knowledgeBase.selectedCount", {
          count: namedSelected.length,
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
        <DropdownMenuCheckboxItem
          checked={isDefaultOnly}
          onCheckedChange={toggleDefault}
          onSelect={(e) => e.preventDefault()}
        >
          <Database className="mr-1.5 inline h-3.5 w-3.5" />
          {t("thread.composer.knowledgeBase.default")}
        </DropdownMenuCheckboxItem>
        {options.length > 0 ? (
          <>
            <DropdownMenuSeparator />
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
        ) : null}
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
