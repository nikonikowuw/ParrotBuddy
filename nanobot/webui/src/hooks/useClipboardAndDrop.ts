import { useCallback, useRef, useState } from "react";

/** Extract files from a paste event. Plain text pasted alongside files is not
 * consumed by this helper, so the caller can still let the textarea receive
 * ordinary text naturally. */
export function extractFilesFromPaste(
  event: ClipboardEvent | React.ClipboardEvent,
): File[] {
  const clipboard = (event as ClipboardEvent).clipboardData
    ?? (event as React.ClipboardEvent).clipboardData;
  if (!clipboard) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** Backwards-compatible image-only projection for callers that need it. */
export function extractImageFilesFromPaste(
  event: ClipboardEvent | React.ClipboardEvent,
): File[] {
  return extractFilesFromPaste(event).filter((file) => file.type.startsWith("image/"));
}

/** Extract all dropped files; the attachment owner applies the MIME policy. */
export function extractFilesFromDrop(
  event: DragEvent | React.DragEvent,
): File[] {
  const dt = (event as DragEvent).dataTransfer
    ?? (event as React.DragEvent).dataTransfer;
  return dt ? Array.from(dt.files) : [];
}

/** Backwards-compatible image-only projection for callers that need it. */
export function extractImageFilesFromDrop(
  event: DragEvent | React.DragEvent,
): File[] {
  return extractFilesFromDrop(event).filter((file) => file.type.startsWith("image/"));
}

export interface UseClipboardAndDropApi {
  /** Whether a drag is currently hovering the drop zone (toggle dragover UI). */
  isDragging: boolean;
  onPaste: (event: React.ClipboardEvent) => void;
  onDragEnter: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

/** Wire paste + drag-and-drop to a callback.
 *
 * The hook owns ``isDragging`` state and the refcount that keeps it accurate
 * across nested ``dragenter`` / ``dragleave`` events. MIME validation remains
 * in the attachment lifecycle hook so picker, paste, and drop share one rule.
 */
export function useClipboardAndDrop(
  onFiles: (files: File[]) => void,
): UseClipboardAndDropApi {
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = extractFilesFromPaste(event);
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    },
    [onFiles],
  );

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      dragDepth.current = 0;
      setIsDragging(false);
      const files = extractFilesFromDrop(event);
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    },
    [onFiles],
  );

  return { isDragging, onPaste, onDragEnter, onDragOver, onDragLeave, onDrop };
}
