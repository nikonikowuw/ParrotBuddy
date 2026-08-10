import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, ChevronRight, Download, Loader2, PenLine, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CodeBlock } from "@/components/CodeBlock";
import {
  FileReferenceIcon,
  fileKindForPath,
  splitFilePath,
} from "@/components/FileReferenceChip";
import { Button } from "@/components/ui/button";
import { ApiError, fetchFilePreview, fileRawUrl } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { fetchWithTimeout } from "@/lib/http";
import type { FilePreviewBinaryPayload, FilePreviewPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface FilePreviewPanelProps {
  sessionKey: string;
  path: string;
  token: string;
  desktopWidth?: number;
  isClosing?: boolean;
  onResizeStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onClose: () => void;
  /**
   * Auto-widen the panel to fit the rendered document's natural content
   * width (docx-preview renders pages at fixed 100% scale, so a narrow
   * panel would clip the page). Called once after a document renders;
   * hosts should clamp and expand (never shrink) the panel width.
   */
  onAutoFitWidth?: (contentWidth: number) => void;
  /**
   * When set, editable spreadsheets (xlsx) get an "edit" action that swaps
   * the read-only preview for an in-panel editor; saving sends the edited
   * file back through this callback (resolves when the server persisted it).
   */
  onSaveFile?: (path: string, contentBase64: string) => Promise<void>;
}

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; payload: FilePreviewPayload };

function usePreviewBlob(rawUrl: string, token: string) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setBlob(null);
    (async () => {
      try {
        const res = await fetchWithTimeout(rawUrl, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.blob();
        if (cancelled) return;
        setBlob(data);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawUrl, token]);

  return { blob, status };
}

function PreviewLoadingOverlay() {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/60 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {t("filePreview.loading", { defaultValue: "Loading preview..." })}
    </div>
  );
}

function DocumentPreviewToolbar({
  filename,
  size,
  rawUrl,
}: {
  filename: string;
  size: number;
  rawUrl: string;
}) {
  const { t } = useTranslation();
  const noReferrer = { referrerPolicy: "no-referrer" as const };
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 py-1.5">
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/70">
        {filename} · {formatBytes(size)}
      </span>
      <Button type="button" size="sm" variant="ghost" className="shrink-0" asChild>
        <a href={rawUrl} download={filename} {...noReferrer}>
          <Download className="h-3.5 w-3.5" aria-hidden />
          <span className="ml-1.5">
            {t("filePreview.download", { defaultValue: "Download" })}
          </span>
        </a>
      </Button>
    </div>
  );
}

function BinaryPreviewBody({
  payload,
  rawUrl,
  token,
  sessionKey,
  onAutoFitWidth,
}: {
  payload: FilePreviewBinaryPayload;
  rawUrl: string;
  token: string;
  sessionKey: string;
  onAutoFitWidth?: (contentWidth: number) => void;
}) {
  const { t } = useTranslation();
  const mime = payload.mime_type.toLowerCase();
  const filename = payload.filename;
  const noReferrer = { referrerPolicy: "no-referrer" as const };

  if (mime.startsWith("image/")) {
    return (
      <div className="flex h-full items-center justify-center bg-muted/20 p-4">
        <img
          src={rawUrl}
          alt={filename}
          {...noReferrer}
          className="max-h-full max-w-full rounded-md object-contain shadow-sm"
        />
      </div>
    );
  }
  if (mime.startsWith("video/")) {
    return (
      <div className="flex h-full items-center justify-center bg-black/5 p-4">
        <video
          src={rawUrl}
          controls
          {...noReferrer}
          className="max-h-full max-w-full rounded-md"
        />
      </div>
    );
  }
  if (mime.startsWith("audio/")) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <audio src={rawUrl} controls {...noReferrer} className="w-full" />
      </div>
    );
  }
  if (mime === "application/pdf") {
    return (
      <iframe
        src={rawUrl}
        title={t("filePreview.document", { defaultValue: "Document preview" })}
        className="h-full w-full border-0"
      />
    );
  }
  if (mime === DOCX_MIME) {
    return (
      <DocxPreview
        token={token}
        sessionKey={sessionKey}
        path={payload.path}
        payload={payload}
        onAutoFitWidth={onAutoFitWidth}
      />
    );
  }
  if (mime === XLSX_MIME) {
    return (
      <XlsxPreview
        token={token}
        sessionKey={sessionKey}
        path={payload.path}
        payload={payload}
      />
    );
  }
  if (mime === PPTX_MIME) {
    return (
      <PptxPreview
        token={token}
        sessionKey={sessionKey}
        path={payload.path}
        payload={payload}
      />
    );
  }
  if (mime === "text/html" || mime === "image/svg+xml") {
    // Script-capable types get a fully sandboxed frame (no scripts, unique origin).
    return (
      <iframe
        src={rawUrl}
        sandbox=""
        title={t("filePreview.document", { defaultValue: "Document preview" })}
        className="h-full w-full border-0"
      />
    );
  }
  // Office documents, archives and other non-renderable binaries: browsers
  // download these, so offer explicit open/download actions.
  return <BinaryUnsupportedBody payload={payload} rawUrl={rawUrl} />;
}

function BinaryUnsupportedBody({
  payload,
  rawUrl,
}: {
  payload: FilePreviewBinaryPayload;
  rawUrl: string;
}) {
  const { t } = useTranslation();
  const filename = payload.filename;
  const noReferrer = { referrerPolicy: "no-referrer" as const };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <FileReferenceIcon kind={fileKindForPath(filename)} />
      <p className="text-sm text-muted-foreground">
        {t("filePreview.binaryUnsupported", {
          defaultValue: "This file type can't be previewed in the browser.",
        })}
      </p>
      <p className="font-mono text-xs text-muted-foreground/70">
        {filename} · {formatBytes(payload.size)}
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => window.open(rawUrl, "_blank", "noopener,noreferrer")}
        >
          {t("filePreview.openInBrowser", { defaultValue: "Open in new tab" })}
        </Button>
        <Button type="button" size="sm" variant="outline" asChild>
          <a href={rawUrl} download={filename} {...noReferrer}>
            {t("filePreview.download", { defaultValue: "Download" })}
          </a>
        </Button>
      </div>
    </div>
  );
}

/**
 * Render an office document (docx/pptx) into a plain container once the raw
 * file blob is ready, tracking loading/rendered/failed state and tearing down
 * on unmount. Shared by the Docx/Pptx previewers, which differ only in the
 * renderer they load.
 */
function useOfficePreview(
  blob: Blob | null,
  status: "loading" | "ready" | "error",
  render: (blob: Blob, container: HTMLElement) => Promise<{ destroy?: () => void } | void>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (status !== "ready" || !blob) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    setRendered(false);
    setFailed(false);
    if (containerRef.current) {
      containerRef.current.innerHTML = "";
    }
    (async () => {
      try {
        const container = containerRef.current;
        if (!container) return;
        const handle = await render(blob, container);
        if (cancelled) return;
        destroy = handle?.destroy;
        setRendered(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [blob, status, render]);

  return { containerRef, rendered, failed };
}

function OfficeDocumentFrame({
  token,
  sessionKey,
  path,
  payload,
  render,
  onAutoFitWidth,
}: {
  token: string;
  sessionKey: string;
  path: string;
  payload: FilePreviewBinaryPayload;
  render: (blob: Blob, container: HTMLElement) => Promise<{ destroy?: () => void } | void>;
  onAutoFitWidth?: (contentWidth: number) => void;
}) {
  const rawUrl = fileRawUrl(token, sessionKey, path);
  const { blob, status } = usePreviewBlob(rawUrl, token);
  const { containerRef, rendered, failed } = useOfficePreview(blob, status, render);

  // docx-preview lays out pages at a fixed 100% scale, so the panel must
  // be at least as wide as the widest page (plus wrapper padding) to avoid
  // horizontal clipping. Two complementary behaviours:
  //   1. Report the widest rendered overflow once so the host can widen the
  //      panel (it only ever expands — manual drags stay respected).
  //   2. Scale the pages down to fit the container whenever it is still
  //      narrower than the content (small windows, manual narrowing), so the
  //      document is always fully visible with no horizontal scrollbar — the
  //      same fit-to-width behaviour the Sobree editor has.
  useEffect(() => {
    if (!rendered || !containerRef.current) return;
    const el = containerRef.current;
    let raf = 0;
    let frames = 0;
    let widest = 0;
    let autoFitReported = false;

    const fitWidth = () => {
      const wrapper = el.querySelector<HTMLElement>(".docx-wrapper");
      if (!wrapper) return;
      const natural = wrapper.scrollWidth;
      if (natural <= 0) return;
      const scale = Math.min(1, el.clientWidth / natural);
      const sections = wrapper.querySelectorAll<HTMLElement>(".docx");
      sections.forEach((section) => {
        section.style.zoom = scale < 1 ? String(scale) : "";
      });
    };

    const sample = () => {
      frames += 1;
      if (el.scrollWidth > el.clientWidth + 8) {
        widest = Math.max(widest, el.scrollWidth);
      }
      // Once we've seen overflow, keep sampling a few frames to catch a
      // late-layout page; stop at 40 frames (~650ms) either way.
      if (frames < 40 && (widest === 0 || frames < 12)) {
        raf = requestAnimationFrame(sample);
      } else if (widest > 0 && !autoFitReported) {
        autoFitReported = true;
        onAutoFitWidth?.(widest);
      }
      fitWidth();
    };
    raf = requestAnimationFrame(sample);

    // Re-fit when the panel width changes (auto-fit widening or a manual
    // drag) so the zoom tracks the container.
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      frames = 0;
      widest = 0;
      raf = requestAnimationFrame(sample);
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [rendered, onAutoFitWidth]);

  if (status === "error" || failed) {
    return <BinaryUnsupportedBody payload={payload} rawUrl={rawUrl} />;
  }
  return (
    <div className="flex h-full flex-col">
      <DocumentPreviewToolbar filename={payload.filename} size={payload.size} rawUrl={rawUrl} />
      <div className="relative min-h-0 flex-1">
        {!rendered ? <PreviewLoadingOverlay /> : null}
        <div ref={containerRef} className="h-full overflow-auto" />
      </div>
    </div>
  );
}

function DocxPreview({
  token,
  sessionKey,
  path,
  payload,
  onAutoFitWidth,
}: {
  token: string;
  sessionKey: string;
  path: string;
  payload: FilePreviewBinaryPayload;
  onAutoFitWidth?: (contentWidth: number) => void;
}) {
  const render = useCallback(async (blob: Blob, container: HTMLElement) => {
    const { renderAsync } = await import("docx-preview");
    await renderAsync(blob, container);
  }, []);
  return (
    <OfficeDocumentFrame
      token={token}
      sessionKey={sessionKey}
      path={path}
      payload={payload}
      render={render}
      onAutoFitWidth={onAutoFitWidth}
    />
  );
}

function XlsxPreview({
  token,
  sessionKey,
  path,
  payload,
}: {
  token: string;
  sessionKey: string;
  path: string;
  payload: FilePreviewBinaryPayload;
}) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const rawUrl = fileRawUrl(token, sessionKey, path);
  const filename = payload.filename;
  const { blob, status } = usePreviewBlob(rawUrl, token);

  useEffect(() => {
    if (status !== "ready" || !blob) return;
    let cancelled = false;
    setFailed(false);
    setSheets(null);
    setActiveIndex(0);
    (async () => {
      try {
        const [{ xlsx2Html }, { Workbook }] = await Promise.all([
          import("xlsx-preview"),
          import("exceljs"),
        ]);
        const workbook = new Workbook();
        await workbook.xlsx.load(await blob.arrayBuffer());
        const names = workbook.worksheets.map((sheet) => sheet.name);
        const htmls = (await xlsx2Html(blob, { separateSheets: true })) as string[];
        if (cancelled) return;
        setSheets(
          htmls.map((html, index) => ({
            name: names[index] ?? `Sheet ${index + 1}`,
            html,
          })),
        );
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob, status]);

  if (status === "error" || failed) {
    return <BinaryUnsupportedBody payload={payload} rawUrl={rawUrl} />;
  }
  const activeSheet = sheets?.[activeIndex];
  return (
    <div className="flex h-full flex-col">
      <DocumentPreviewToolbar filename={filename} size={payload.size} rawUrl={rawUrl} />
      {sheets ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-2 py-1">
          {sheets.map((sheet, index) => (
            <button
              key={`${sheet.name}-${index}`}
              type="button"
              onClick={() => setActiveIndex(index)}
              className={cn(
                "shrink-0 rounded-[6px] px-2 py-1 text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                index === activeIndex
                  ? "bg-primary/10 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {!sheets ? <PreviewLoadingOverlay /> : null}
        {activeSheet ? (
          <iframe
            key={activeIndex}
            data-testid="xlsx-preview-frame"
            sandbox=""
            srcDoc={activeSheet.html}
            title={`${filename} — ${activeSheet.name}`}
            className="h-full w-full border-0 bg-white"
          />
        ) : null}
      </div>
    </div>
  );
}

function PptxPreview({
  token,
  sessionKey,
  path,
  payload,
}: {
  token: string;
  sessionKey: string;
  path: string;
  payload: FilePreviewBinaryPayload;
}) {
  const render = useCallback(async (blob: Blob, container: HTMLElement) => {
    const { init } = await import("pptx-preview");
    const width = Math.max(container.clientWidth || 640, 320);
    const viewer = init(container, { width, mode: "list" });
    await viewer.preview(await blob.arrayBuffer());
    return { destroy: () => viewer.destroy() };
  }, []);
  return (
    <OfficeDocumentFrame
      token={token}
      sessionKey={sessionKey}
      path={path}
      payload={payload}
      render={render}
    />
  );
}

export function FilePreviewPanel({
  sessionKey,
  path,
  token,
  desktopWidth = 544,
  isClosing = false,
  onResizeStart,
  onClose,
  onAutoFitWidth,
  onSaveFile,
}: FilePreviewPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [entered, setEntered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editorModule, setEditorModule] = useState<{
    UniverSheetsEditor?: typeof import("@/components/UniverSheetsEditor").UniverSheetsEditor;
    SobreeDocxEditor?: typeof import("@/components/SobreeDocxEditor").SobreeDocxEditor;
  } | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const startEditInFlight = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setEditing(false);
    setEditorModule(null);
    fetchFilePreview(token, sessionKey, path)
      .then((payload) => {
        if (!cancelled) setState({ status: "ready", payload });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof ApiError
          ? (error.status === 404 && /API route not found/i.test(error.message)
            ? t("filePreview.routeMissing", {
              defaultValue: "File preview needs the latest gateway. Restart nanobot gateway and try again.",
            })
            : error.message)
          : t("filePreview.failed", { defaultValue: "Could not preview this file." });
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [path, sessionKey, t, token, previewVersion]);

  const displayPath = state.status === "ready" ? state.payload.display_path : path;
  const previewPath = state.status === "ready" ? state.payload.path : displayPath;
  const normalizedPreviewPath = previewPath.replace(/\\/g, "/");
  const hasRootPrefix = normalizedPreviewPath.startsWith("/");
  const { name } = splitFilePath(displayPath);
  const fileName = name || displayPath;
  const pathParts = useMemo(
    () => normalizedPreviewPath.split("/").filter(Boolean),
    [normalizedPreviewPath],
  );
  const directoryParts = useMemo(
    () => (pathParts.length > 1 ? pathParts.slice(0, -1) : []),
    [pathParts],
  );
  const breadcrumbParts = useMemo(
    () => (directoryParts.length > 0 ? [...directoryParts, fileName] : [fileName]),
    [directoryParts, fileName],
  );
  const compactBreadcrumbParts = useMemo(
    () => (breadcrumbParts.length > 3 ? breadcrumbParts.slice(-3) : breadcrumbParts),
    [breadcrumbParts],
  );
  const hasCompactPrefix = breadcrumbParts.length > compactBreadcrumbParts.length;
  const breadcrumbTitle = `${hasRootPrefix ? "/" : ""}${[
    ...directoryParts,
    fileName,
  ].join("/")}`;

  // Office binaries can be edited in place (xlsx via Univer, docx via
  // Sobree), and only when the host wired up a save path (ThreadShell
  // provides it for websocket sessions).
  const mimeType = state.status === "ready" && state.payload.kind === "binary"
    ? (state.payload.mime_type || "").toLowerCase()
    : "";
  const canEdit = !editing
    && !!onSaveFile
    && state.status === "ready"
    && state.payload.kind === "binary"
    && (mimeType === XLSX_MIME || mimeType === DOCX_MIME);

  const handleStartEdit = useCallback(async () => {
    if (editorModule) {
      setEditing(true);
      return;
    }
    if (startEditInFlight.current) return;
    startEditInFlight.current = true;
    try {
      // Load only the editor matching this file type so editing a docx does
      // not pull the whole Univer + exceljs bundle (and vice versa).
      if (mimeType === XLSX_MIME) {
        const { UniverSheetsEditor } = await import("@/components/UniverSheetsEditor");
        setEditorModule({ UniverSheetsEditor });
      } else {
        const { SobreeDocxEditor } = await import("@/components/SobreeDocxEditor");
        setEditorModule({ SobreeDocxEditor });
      }
      setEditing(true);
    } catch {
      // leave the read-only preview in place; the editor chunk failed to load
    } finally {
      startEditInFlight.current = false;
    }
  }, [editorModule, mimeType]);

  const handleEditorSave = useCallback(
    async (contentBase64: string) => {
      if (!onSaveFile || state.status !== "ready") return;
      await onSaveFile(state.payload.path, contentBase64);
    },
    [onSaveFile, state],
  );
  const handleEditorBack = useCallback(() => setEditing(false), []);
  const handleEditorSaved = useCallback(() => {
    setEditing(false);
    setPreviewVersion((v) => v + 1);
  }, []);


  return (
    <aside
      aria-label={t("filePreview.aria", { defaultValue: "File preview" })}
      style={{
        "--file-preview-width": `${desktopWidth}px`,
        "--file-preview-slot-width": !entered || isClosing ? "0px" : `${desktopWidth}px`,
      } as CSSProperties}
      className={cn(
        "absolute inset-y-0 right-0 z-30 w-[min(100vw,var(--file-preview-slot-width))] overflow-hidden",
        "transition-[width] duration-300 ease-out will-change-[width]",
        "md:relative md:z-auto md:w-[var(--file-preview-slot-width)] md:min-w-0 md:shrink-0",
        isClosing && "pointer-events-none",
      )}
      data-testid="file-preview-panel"
      data-file-preview-panel
    >
      <div
        className={cn(
          "absolute inset-y-0 right-0 flex w-[min(100vw,var(--file-preview-width))] flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] md:w-[var(--file-preview-width)] md:pb-0",
          "border-l border-border/70 bg-background shadow-2xl md:shadow-none",
          "transition-[opacity,transform] duration-300 ease-out will-change-transform",
          !entered || isClosing ? "translate-x-full opacity-0" : "translate-x-0 opacity-100",
          "motion-reduce:translate-x-0",
        )}
      >
        {onResizeStart ? (
          <button
            type="button"
            aria-label={t("filePreview.resize", { defaultValue: "Resize file preview" })}
            className={cn(
              "group absolute inset-y-0 left-0 z-20 hidden w-3 -translate-x-1/2 cursor-col-resize touch-none md:flex",
              "items-stretch justify-center focus-visible:outline-none",
            )}
            onPointerDown={onResizeStart}
          >
            <span
              aria-hidden
              className={cn(
                "h-full w-px bg-foreground/25 opacity-0 transition-opacity",
                "group-hover:opacity-100 group-focus-visible:bg-ring group-focus-visible:opacity-100",
              )}
            />
          </button>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3"
            title={previewPath}
          >
            <nav
              aria-label={t("filePreview.breadcrumb", { defaultValue: "File path" })}
              className="flex min-w-0 flex-1 items-center overflow-hidden text-sm leading-5"
              title={breadcrumbTitle}
              data-testid="file-preview-breadcrumb"
            >
              {hasCompactPrefix ? (
                <>
                  <span className="shrink-0 text-muted-foreground/55">...</span>
                  <ChevronRight
                    className="mx-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/35"
                    aria-hidden
                  />
                </>
              ) : hasRootPrefix ? (
                <>
                  <span className="shrink-0 text-muted-foreground/55">/</span>
                  <ChevronRight
                    className="mx-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/35"
                    aria-hidden
                  />
                </>
              ) : null}
              {compactBreadcrumbParts.map((part, index) => {
                const isLast = index === compactBreadcrumbParts.length - 1;
                return (
                  <span
                    key={`${part}-${index}`}
                    className="flex min-w-0 items-center overflow-hidden"
                  >
                    {index > 0 ? (
                      <ChevronRight
                        className="mx-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/35"
                        aria-hidden
                      />
                    ) : null}
                    <span
                      className={cn(
                        "min-w-0 truncate rounded-[4px] px-1 py-0.5",
                        isLast
                          ? "font-medium text-foreground"
                          : "max-w-[26vw] shrink text-muted-foreground/78",
                      )}
                      data-testid={isLast ? "file-preview-title" : undefined}
                    >
                      {part}
                    </span>
                  </span>
                );
              })}
            </nav>
            {canEdit ? (
              <button
                type="button"
                onClick={handleStartEdit}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5",
                  "text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                title={t("filePreview.edit", { defaultValue: "Edit" })}
                aria-label={t("filePreview.edit", { defaultValue: "Edit" })}
                data-testid="file-preview-edit"
              >
                <PenLine className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">
                  {t("filePreview.edit", { defaultValue: "Edit" })}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              title={t("filePreview.close", { defaultValue: "Close file preview" })}
              aria-label={t("filePreview.close", { defaultValue: "Close file preview" })}
              data-testid="file-preview-close"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {state.status === "loading" ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {t("filePreview.loading", { defaultValue: "Loading preview..." })}
              </div>
            ) : state.status === "error" ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
                <div className="max-w-sm">
                  <AlertCircle
                    className="mx-auto mb-3 h-5 w-5 text-muted-foreground/70"
                    aria-hidden
                  />
                  <p>{state.message}</p>
                </div>
              </div>
            ) : editing && editorModule && state.payload.kind === "binary" ? (
              <div className="h-full overflow-hidden">
                {mimeType === XLSX_MIME && editorModule.UniverSheetsEditor ? (
                  <editorModule.UniverSheetsEditor
                    fileUrl={fileRawUrl(token, sessionKey, state.payload.path)}
                    token={token}
                    fileName={state.payload.filename ?? "spreadsheet.xlsx"}
                    onSave={handleEditorSave}
                    onBack={handleEditorBack}
                    onSaved={handleEditorSaved}
                  />
                ) : mimeType === DOCX_MIME && editorModule.SobreeDocxEditor ? (
                  <editorModule.SobreeDocxEditor
                    fileUrl={fileRawUrl(token, sessionKey, state.payload.path)}
                    token={token}
                    fileName={state.payload.filename ?? "document.docx"}
                    onSave={handleEditorSave}
                    onBack={handleEditorBack}
                    onSaved={handleEditorSaved}
                  />
                ) : null}
              </div>
            ) : state.payload.kind === "binary" ? (
              <BinaryPreviewBody
                payload={state.payload}
                rawUrl={fileRawUrl(token, sessionKey, state.payload.path)}
                token={token}
                sessionKey={sessionKey}
                onAutoFitWidth={onAutoFitWidth}
              />
            ) : (
              <div className="min-h-full">
                {state.payload.truncated ? (
                  <div className="mx-4 mt-3 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
                    {t("filePreview.truncated", {
                      defaultValue: "Preview is truncated because this file is large.",
                    })}
                  </div>
                ) : null}
                <CodeBlock
                  language={state.payload.language}
                  code={state.payload.content}
                  chrome="none"
                  highlight
                  showLineNumbers
                  wrapLongLines={false}
                  className="min-h-full"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
