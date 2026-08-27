import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  FileText,
  Loader2,
  Network,
  RefreshCw,
  Server,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SettingsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

export type LightRagEmbeddedTab = "documents" | "knowledge-graph";

export type LightRagLanguage =
  | "en"
  | "zh"
  | "fr"
  | "ar"
  | "zh_TW"
  | "ru"
  | "ja"
  | "de"
  | "uk"
  | "ko"
  | "vi";

const LIGHTRAG_LANGUAGES: readonly LightRagLanguage[] = [
  "en",
  "zh",
  "fr",
  "ar",
  "zh_TW",
  "ru",
  "ja",
  "de",
  "uk",
  "ko",
  "vi",
];

/** Map nanobot supported locales to LightRAG supported language identifiers. */
export function toLightRagLanguage(
  locale: string | null | undefined,
): LightRagLanguage {
  if (!locale) return "en";
  const lower = locale.toLowerCase().trim();
  if (
    lower === "zh-cn" ||
    lower === "zh" ||
    lower.startsWith("zh-hans") ||
    lower.startsWith("zh-sg")
  ) {
    return "zh";
  }
  if (
    lower === "zh-tw" ||
    lower === "zh-hk" ||
    lower === "zh-mo" ||
    lower.startsWith("zh-hant")
  ) {
    return "zh_TW";
  }
  const base = lower.split(/[-_]/)[0] as LightRagLanguage;
  if (LIGHTRAG_LANGUAGES.includes(base)) {
    return base;
  }
  return "en";
}

/** Browser-local navigation preference: which LightRAG server the embedded
 * page last pointed at (per-browser, never written back to config). */
const EMBEDDED_SERVER_STORAGE_KEY = "nanobot-webui.lightrag-embedded-server";
/** Cross-origin frames cannot report load failures, so a missing `load` event
 * within this window is surfaced as a "still loading?" hint with retry and an
 * open-in-new-tab fallback. */
const LOAD_TIMEOUT_MS = 10_000;

interface LightRagEmbeddedViewProps {
  settings: SettingsPayload | null;
  tab: LightRagEmbeddedTab;
  theme: "light" | "dark";
  onChatWithEntity?: (entity: { id: string | number; name: string; description?: string; properties?: Record<string, unknown> }, serverName?: string | null) => void;
}

/**
 * Embedded LightRAG WebUI (Documents / Knowledge Graph) inside the nanobot
 * shell. Loads the full LightRAG WebUI in an iframe at
 * ``{api_base}/webui/?embedded=1&tab=...&theme=...``. Authentication, theme
 * and internal tab navigation stay inside LightRAG; nanobot only selects the
 * server and the initial tab.
 */
export function LightRagEmbeddedView({
  settings,
  tab,
  theme,
  onChatWithEntity,
}: LightRagEmbeddedViewProps) {
  const { t, i18n } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const lightragLang = toLightRagLanguage(i18n.resolvedLanguage ?? i18n.language);

  const servers = useMemo(() => {
    const list: Array<{ name: string; label?: string; api_base: string }> = [];
    if (settings?.lightrag?.personal?.enabled) {
      list.push({
        name: "__personal__",
        label:
          settings.lightrag.personal.name?.trim() ||
          t("thread.composer.knowledgeBase.personal"),
        api_base: settings.lightrag.personal.api_base,
      });
    }
    const extra = settings?.lightrag?.enterprise_servers ?? settings?.lightrag?.servers ?? [];
    for (const s of extra) {
      if (!list.some((existing) => existing.name === s.name)) {
        list.push(s);
      }
    }
    return list;
  }, [settings?.lightrag, t]);
  const defaultServerName = settings?.lightrag?.default_workspace ?? null;

  const [selectedName, setSelectedName] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(EMBEDDED_SERVER_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [retryCount, setRetryCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  // Resolve the active server: keep the last browser selection while it still
  // exists, otherwise fall back to default_workspace, then the first server.
  // Runs whenever the settings payload changes so a deleted/renamed server
  // falls back live.
  useEffect(() => {
    setSelectedName((current) => {
      if (current && servers.some((s) => s.name === current)) return current;
      if (defaultServerName && servers.some((s) => s.name === defaultServerName)) {
        return defaultServerName;
      }
      return servers[0]?.name ?? null;
    });
  }, [servers, defaultServerName]);

  useEffect(() => {
    if (!selectedName) return;
    try {
      window.localStorage.setItem(EMBEDDED_SERVER_STORAGE_KEY, selectedName);
    } catch {
      // ignore storage errors (private mode, etc.)
    }
  }, [selectedName]);

  const server = servers.find((s) => s.name === selectedName) ?? null;

  const iframeUrl = useMemo(() => {
    if (!server) return null;
    const base = server.api_base.replace(/\/+$/, "");
    const params = new URLSearchParams({
      embedded: "1",
      tab,
      theme,
      lang: lightragLang,
    });
    return `${base}/webui/?${params.toString()}`;
  }, [server, tab, theme, lightragLang]);

  // Reset load state whenever the frame target changes (server / tab / theme /
  // manual retry all swap the iframe `key`, forcing a fresh load).
  useEffect(() => {
    setLoaded(false);
    setTimedOut(false);
  }, [iframeUrl, retryCount]);

  useEffect(() => {
    if (loaded || !iframeUrl) return;
    const timer = window.setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [iframeUrl, retryCount, loaded]);

  const handleLoad = useCallback(() => {
    setLoaded(true);
    setTimedOut(false);
  }, []);

  const handleRetry = useCallback(() => {
    setRetryCount((c) => c + 1);
  }, []);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!onChatWithEntity) return;

    function onWindowMessage(event: MessageEvent) {
      // Validate that the message came from our embedded iframe
      if (
        iframeRef.current?.contentWindow &&
        event.source !== iframeRef.current.contentWindow
      ) {
        return;
      }

      const data = event.data;
      if (
        data &&
        typeof data === "object" &&
        data.type === "lightrag:chat_with_entity" &&
        data.entity &&
        typeof data.entity.name === "string"
      ) {
        onChatWithEntity?.(data.entity, selectedName);
      }
    }

    window.addEventListener("message", onWindowMessage);
    return () => {
      window.removeEventListener("message", onWindowMessage);
    };
  }, [onChatWithEntity, selectedName]);

  if (!server || !iframeUrl) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Server className="h-8 w-8 text-muted-foreground/40" />
        <p className="max-w-sm text-sm text-muted-foreground">
          {tx(
            "lightragEmbedded.noServer",
            "No LightRAG server is configured. Add one in Settings → LightRAG.",
          )}
        </p>
      </div>
    );
  }

  const frameKey = `${selectedName}:${tab}:${theme}:${lightragLang}:${retryCount}`;

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/55 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-foreground">
          {tab === "documents" ? (
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground/70" />
          ) : (
            <Network className="h-4 w-4 shrink-0 text-muted-foreground/70" />
          )}
          <span className="truncate">
            {tab === "documents"
              ? tx("sidebar.documents", "Knowledge Base")
              : tx("sidebar.knowledgeGraph", "Knowledge Graph")}
          </span>
        </div>
        {/* TODO(MVP): In MVP version, hide the top-left knowledge base server switcher. Keep dropdown logic and state management intact for future multi-KB support. */}
        {false && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-7 gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
                title={server?.api_base}
              >
                <Server className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[16rem] truncate">
                  {server?.label ?? server?.name}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>
                {tx("lightragEmbedded.serverLabel", "LightRAG server")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {servers.map((item) => (
                <DropdownMenuItem
                  key={item.name}
                  onSelect={() => setSelectedName(item.name)}
                  className={cn(item.name === server?.name && "bg-foreground/[0.055]")}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{item.label ?? item.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {item.api_base}
                    </span>
                  </span>
                  {item.name === server?.name ? (
                    <Check className="ml-auto h-3.5 w-3.5 shrink-0" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {!loaded ? (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {tx("lightragEmbedded.loading", "Loading…")}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={tx("lightragEmbedded.reload", "Reload")}
            title={tx("lightragEmbedded.reload", "Reload")}
            onClick={handleRetry}
            className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        <iframe
          ref={iframeRef}
          key={frameKey}
          src={iframeUrl}
          title={`${server.label ?? server.name} — LightRAG`}
          referrerPolicy="no-referrer"
          onLoad={handleLoad}
          className="h-full w-full border-0"
        />
        {timedOut ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-border/55 bg-background/95 px-3 py-2 text-[12px] text-muted-foreground backdrop-blur">
            <span className="min-w-0 flex-1">
              {tx(
                "lightragEmbedded.timedOut",
                "Still loading… The server may be unreachable or block embedding.",
              )}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRetry}
              className="h-7 rounded-full px-3 text-[12px]"
            >
              {tx("lightragEmbedded.retry", "Retry")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
