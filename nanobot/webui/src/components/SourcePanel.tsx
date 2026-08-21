import { BookOpen, ExternalLink, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FileReferenceChip } from "@/components/FileReferenceChip";
import { withGatewayToken } from "@/lib/api";
import type { RAGEvidenceItem } from "@/lib/document-references";
import { useOptionalClientToken } from "@/providers/ClientProvider";

interface SourcePanelProps {
  evidence: RAGEvidenceItem[];
  onOpenFilePreview?: (path: string) => void;
}

export function SourcePanel({ evidence, onOpenFilePreview }: SourcePanelProps) {
  const { t } = useTranslation();
  const gatewayToken = useOptionalClientToken() ?? "";
  if (evidence.length === 0) return null;

  return (
    <section
      aria-label={t("message.references", { defaultValue: "Reference documents" })}
      className="mt-3 w-full rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs"
      data-testid="rag-source-panel"
    >
      <div className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span>{t("message.references", { defaultValue: "Reference documents" })}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {evidence.map((item) => {
          const isExternalWeb = Boolean(
            item.reference.source_url &&
            !item.href?.includes("/api/lightrag/file/") &&
            !item.href?.includes("/documents/file/")
          );
          const href = item.href ? withGatewayToken(item.href, gatewayToken) : undefined;
          const serverLabel =
            item.serverLabel === "__personal__"
              ? t("thread.composer.knowledgeBase.personal")
              : item.serverLabel?.trim();

          if (isExternalWeb && href) {
            return (
              <a
                key={item.key}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-background/80 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-sky-500/50 hover:bg-muted hover:text-sky-600 dark:hover:text-sky-300"
                title={item.fullPath || item.name}
              >
                <Globe className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-hidden />
                <span className="min-w-0 max-w-[240px] truncate">{item.name}</span>
                {serverLabel ? (
                  <span className="max-w-[180px] truncate text-[10px] text-muted-foreground">
                    {serverLabel}
                  </span>
                ) : null}
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-current" aria-hidden />
              </a>
            );
          }

          if (href && !onOpenFilePreview) {
            return (
              <a
                key={item.key}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center rounded-md border border-border/60 bg-background/80 px-2.5 py-1 text-xs no-underline shadow-none transition-colors hover:border-sky-500/50 hover:bg-muted"
                title={item.fullPath || item.name}
              >
                {serverLabel ? (
                  <span className="mr-1 max-w-[180px] truncate text-[10px] text-muted-foreground">
                    {serverLabel}
                  </span>
                ) : null}
                <FileReferenceChip
                  path={item.fullPath}
                  displayName={item.name}
                  tooltipPath={serverLabel ? `${serverLabel}: ${item.fullPath}` : item.fullPath}
                  previewPath={item.fullPath}
                  display="name"
                />
              </a>
            );
          }

          return (
            <div
              key={item.key}
              className="inline-flex max-w-full items-center rounded-md border border-border/60 bg-background/80 px-2.5 py-1 text-xs shadow-none transition-colors hover:border-sky-500/50 hover:bg-muted"
            >
              {serverLabel ? (
                <span className="mr-1 max-w-[180px] truncate text-[10px] text-muted-foreground">
                  {serverLabel}
                </span>
              ) : null}
              <FileReferenceChip
                path={item.fullPath}
                displayName={item.name}
                tooltipPath={serverLabel ? `${serverLabel}: ${item.fullPath}` : item.fullPath}
                previewPath={item.fullPath}
                display="name"
                onOpen={onOpenFilePreview}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
