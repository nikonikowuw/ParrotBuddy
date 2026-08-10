import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { OfficeEditorFrame } from "@/components/OfficeEditorFrame";
import { fetchWithTimeout } from "@/lib/http";
import type { CommandType, IWorkbookData } from "@univerjs/presets";

interface UniverSheetsEditorProps {
  /** Raw-file URL (token-scoped) that serves the original xlsx bytes. */
  fileUrl: string;
  token: string;
  /** Display name shown in the editor header. */
  fileName: string;
  /**
   * Persist the edited file. Receives the full xlsx content as a base64
   * string (the WS save frame shape); must resolve when the server has
   * written the file back.
   */
  onSave: (contentBase64: string) => Promise<void>;
  /** Return to the read-only preview pane. */
  onBack: () => void;
  /** Called after a successful save (e.g. to refresh the preview). */
  onSaved: () => void;
}

interface UniverHandle {
  univer: { dispose: () => void };
  univerAPI: {
    createWorkbook: (snapshot: IWorkbookData) => unknown;
    getActiveWorkbook: () => { getSnapshot: () => IWorkbookData } | null;
    onCommandExecuted: (cb: (info: { type?: CommandType }) => void) => {
      dispose: () => void;
    };
  };
}

/**
 * Editable spreadsheet view backed by Univer Sheets (community preset).
 *
 * Loads the original xlsx bytes, converts them into a Univer snapshot with
 * exceljs, mounts the editor in place, and on save snapshots the workbook
 * back out, serializes it with exceljs and hands the base64 content to
 * ``onSave``. Univer + exceljs are loaded lazily (dynamic imports) so the
 * heavy Office chunks only download when the user actually edits.
 */
export function UniverSheetsEditor({
  fileUrl,
  token,
  fileName,
  onSave,
  onBack,
  onSaved,
}: UniverSheetsEditorProps) {
  const { i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<UniverHandle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Becomes true on the first data mutation so Save stays disabled for an
  // untouched workbook (avoids re-serializing + re-writing on a stray click).
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let mountedHandle: UniverHandle | null = null;
    let commandDisposable: { dispose: () => void } | null = null;
    (async () => {
      try {
        const res = await fetchWithTimeout(fileUrl, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        const [{ createUniver, CommandType, LocaleType }, { UniverSheetsCorePreset }, { xlsxBufferToUniver }] = await Promise.all([
          import("@univerjs/presets"),
          import("@univerjs/preset-sheets-core"),
          import("@/lib/xlsx-univer"),
        ]);
        const snapshot = await xlsxBufferToUniver(buffer, fileName);
        if (cancelled || !containerRef.current) return;
        // Univer unit ids must be unique per session; a collision would make
        // a second open of the same file silently replace the first.
        snapshot.id = `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const handle = createUniver({
          // Match the app's UI language instead of hardcoding Chinese chrome.
          locale: i18n.language.startsWith("zh") ? LocaleType.ZH_CN : LocaleType.EN_US,
          presets: [UniverSheetsCorePreset({ container: containerRef.current })],
        });
        handle.univerAPI.createWorkbook(snapshot);
        // Registered after createWorkbook so the initial load's mutations are
        // not counted as user edits. Data changes always route through the
        // command service, so any real edit fires a MUTATION command.
        commandDisposable = handle.univerAPI.onCommandExecuted((info) => {
          if (info.type === CommandType.MUTATION) setDirty(true);
        });
        univerRef.current = handle;
        mountedHandle = handle;
        setLoading(false);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      commandDisposable?.dispose();
      mountedHandle?.univer.dispose();
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [fileUrl, token, fileName, i18n.language]);

  const handleSave = useCallback(async () => {
    const handle = univerRef.current;
    if (!handle) return;
    setSaving(true);
    setSaveError(null);
    try {
      const workbook = handle.univerAPI.getActiveWorkbook();
      if (!workbook) {
        setSaveError("failed");
        return;
      }
      const snapshot = workbook.getSnapshot();
      const [{ bufferToBase64 }, { univerWorkbookToXlsxBuffer }] = await Promise.all([
        import("@/lib/binary"),
        import("@/lib/xlsx-univer"),
      ]);
      const buffer = await univerWorkbookToXlsxBuffer(snapshot);
      await onSave(bufferToBase64(buffer));
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [onSave, onSaved]);

  return (
    <OfficeEditorFrame
      fileName={fileName}
      loading={loading}
      loadError={loadError}
      saving={saving}
      saveError={saveError}
      dirty={dirty}
      onSave={handleSave}
      onBack={onBack}
      containerRef={containerRef}
    />
  );
}
