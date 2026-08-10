import { useCallback, useEffect, useRef, useState } from "react";

import { OfficeEditorFrame } from "@/components/OfficeEditorFrame";
import { fetchWithTimeout } from "@/lib/http";
import { bufferToBase64 } from "@/lib/binary";

interface SobreeDocxEditorProps {
  /** Raw-file URL (token-scoped) that serves the original docx bytes. */
  fileUrl: string;
  token: string;
  /** Display name shown in the editor header. */
  fileName: string;
  /**
   * Persist the edited file. Receives the full docx content as a base64
   * string (the WS save frame shape); must resolve when the server has
   * written the file back.
   */
  onSave: (contentBase64: string) => Promise<void>;
  /** Return to the read-only preview pane. */
  onBack: () => void;
  /** Called after a successful save (e.g. to refresh the preview). */
  onSaved: () => void;
}

interface SobreeHandle {
  toDocx: () => { blob: Blob; warnings: string[] };
  destroy: () => void;
  on: (event: "change", cb: () => void) => () => void;
}

/**
 * Editable Word view backed by @sobree/core (MIT, native OOXML round-trip).
 *
 * Loads the original docx bytes, mounts the WYSIWYG editor in place, and on
 * save serializes the document back to a docx Blob and hands the base64
 * content to ``onSave``. @sobree/core + plugins are loaded lazily so the
 * editor chunk only downloads when the user actually edits a document.
 */
export function SobreeDocxEditor({
  fileUrl,
  token,
  fileName,
  onSave,
  onBack,
  onSaved,
}: SobreeDocxEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<SobreeHandle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Becomes true on the first document mutation so Save stays disabled for
  // an untouched document (avoids re-serializing + re-writing on a stray
  // click). Listener is attached after ``ready`` so the initial docx import
  // is not counted as a user edit.
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let mountedHandle: SobreeHandle | null = null;
    let unsubscribeChange: (() => void) | null = null;
    (async () => {
      try {
        const res = await fetchWithTimeout(fileUrl, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        const [{ createSobree }, { keyboard }, { blockTools }, { zoomControls }] = await Promise.all([
          import("@sobree/core"),
          import("@sobree/keyboard"),
          import("@sobree/block-tools"),
          import("@sobree/zoom-controls"),
        ]);
        if (cancelled || !containerRef.current) return;
        const handle = createSobree(containerRef.current, {
          content: buffer,
          plugins: [keyboard(), blockTools(), zoomControls()],
        });
        await handle.ready;
        if (cancelled) {
          handle.destroy();
          return;
        }
        // Attach after ``ready`` so the docx import's own mutations are not
        // treated as user edits.
        unsubscribeChange = handle.on("change", () => setDirty(true));
        handleRef.current = handle;
        mountedHandle = handle;
        setLoading(false);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribeChange?.();
      mountedHandle?.destroy();
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [fileUrl, token, fileName]);

  const handleSave = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { blob } = handle.toDocx();
      await onSave(bufferToBase64(await blob.arrayBuffer()));
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
      containerClassName="bg-white"
    />
  );
}
