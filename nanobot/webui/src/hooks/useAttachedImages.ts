import { useCallback, useEffect, useRef, useState } from "react";

import { bufferToBase64 } from "@/lib/binary";
import { encodeImage, type EncodeFailure } from "@/lib/imageEncode";

/** Lifecycle stages of one attachment:
 *
 * - ``encoding``  — being converted to a data URL; chip shows a spinner
 * - ``ready``     — ``dataUrl`` available; safe to submit
 * - ``error``     — validation / decode failure; chip shows inline error
 */
export type AttachmentStatus = "encoding" | "ready" | "error";
export type AttachmentKind = "image" | "file";

export interface AttachedFile {
  id: string;
  file: File;
  /** Optimistic ``blob:`` preview URL; revoked on ``remove`` / ``clear`` /
   * unmount. */
  previewUrl: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /** Populated when ``status === "ready"``. */
  dataUrl?: string;
  /** Size of the final encoded payload (base64 bytes decoded). */
  encodedBytes?: number;
  /** Whether the Worker re-encoded the image to hit the size budget. */
  normalized?: boolean;
  /** Human-readable validation / encoding error when ``status === "error"``. */
  error?: AttachmentError;
}

/** Backwards-compatible name for callers that only handled images. */
export type AttachedImage = AttachedFile;

export interface RestoredReadyAttachment {
  dataUrl: string;
  name?: string;
  kind?: AttachmentKind;
}

/** Backwards-compatible name for queued image drafts. */
export type RestoredReadyImage = RestoredReadyAttachment;

/** Machine-readable rejection reasons surfaced as inline chip errors.
 *
 * Callers localize these via the ``thread.composer.imageRejected`` i18n table.
 */
export type AttachmentError =
  | "unsupported_type"   // server whitelist excludes this MIME
  | "too_many_images"    // per-message image cap reached before enqueue
  | "too_many_files"     // per-message attachment cap reached before enqueue
  | "too_many_documents" // server-side document cap reached
  | "magic_mismatch"     // extension lies about the real image content
  | "decode_failed"      // Worker couldn't decode / re-encode
  | "too_large"          // image remains too large after normalization
  | "file_too_large"     // binary document exceeds the browser upload budget
  | "io";                // file read failed at the browser layer

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** Kept for existing callers and the image-specific server contract. */
export const MAX_IMAGES_PER_MESSAGE = MAX_ATTACHMENTS_PER_MESSAGE;
/** Leave room for base64 overhead inside the default WebSocket frame limit. */
export const MAX_FILE_BYTES = 6 * 1024 * 1024;

const IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export const DOCUMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const DOCUMENT_MIMES: ReadonlySet<string> = new Set(Object.values(DOCUMENT_MIME_BY_EXTENSION));
const ACCEPTED_MIMES: ReadonlySet<string> = new Set([
  ...IMAGE_MIMES,
  ...DOCUMENT_MIMES,
]);

function dataUrlMime(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1]?.toLowerCase() || "";
}

export function attachmentKindForMime(mime: string): AttachmentKind | null {
  const normalized = mime.trim().toLowerCase().split(";", 1)[0] ?? "";
  if (IMAGE_MIMES.has(normalized)) return "image";
  if (DOCUMENT_MIMES.has(normalized)) return "file";
  return null;
}

export function attachmentKindForDataUrl(dataUrl: string): AttachmentKind | null {
  return attachmentKindForMime(dataUrlMime(dataUrl));
}

function extensionOf(name: string): string {
  const dot = name.toLowerCase().lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

/** Resolve browser MIME metadata, falling back to a parser-supported suffix. */
export function attachmentMimeForFile(file: File): string | null {
  const declared = file.type.trim().toLowerCase().split(";", 1)[0] ?? "";
  if (ACCEPTED_MIMES.has(declared)) return declared;
  return DOCUMENT_MIME_BY_EXTENSION[extensionOf(file.name)]
    ?? IMAGE_MIME_BY_EXTENSION[extensionOf(file.name)]
    ?? (IMAGE_MIMES.has(declared) ? declared : null);
}

function dataUrlToFile(dataUrl: string, name?: string): File {
  const mime = dataUrlMime(dataUrl) || "application/octet-stream";
  const fallbackName = mime.startsWith("image/")
    ? `image.${mime.split("/")[1] || "png"}`
    : "attachment.bin";
  try {
    const [, base64 = ""] = dataUrl.split(",", 2);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], name || fallbackName, { type: mime });
  } catch {
    return new File([], name || fallbackName, { type: mime });
  }
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mapEncodeFailure(reason: EncodeFailure["reason"]): AttachmentError {
  switch (reason) {
    case "invalid_mime":
    case "magic_mismatch":
      return "magic_mismatch";
    case "too_large_after_normalize":
      return "too_large";
    case "io":
      return "io";
    case "decode_failed":
    default:
      return "decode_failed";
  }
}

type EncodedAttachment =
  | {
      ok: true;
      dataUrl: string;
      bytes: number;
      normalized: boolean;
    }
  | { ok: false; reason: AttachmentError };

async function encodeAttachment(file: File, mime: string, kind: AttachmentKind): Promise<EncodedAttachment> {
  if (kind === "image") {
    // A missing browser MIME is common for files selected on some platforms;
    // the suffix fallback above is still safe because the image Worker checks
    // magic bytes before accepting the payload.
    const imageFile = file.type === mime
      ? file
      : new File([file], file.name, { type: mime, lastModified: file.lastModified });
    const result = await encodeImage(imageFile);
    if (!result.ok) return { ok: false, reason: mapEncodeFailure(result.reason) };
    return {
      ok: true,
      dataUrl: result.dataUrl,
      bytes: result.bytes,
      normalized: result.normalized,
    };
  }

  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: "file_too_large" };
  }
  try {
    const buffer = await file.arrayBuffer();
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${bufferToBase64(buffer)}`,
      bytes: file.size,
      normalized: false,
    };
  } catch {
    return { ok: false, reason: "io" };
  }
}

export interface UseAttachedImagesApi {
  /** All staged images and document attachments. */
  attachments: AttachedFile[];
  /** Backwards-compatible alias for ``attachments``. */
  images: AttachedFile[];
  /** Enqueue new files. Returns the list of rejected files so the caller can
   * surface inline errors. */
  enqueue: (files: Iterable<File>) => {
    rejected: Array<{ file: File; reason: AttachmentError }>;
  };
  remove: (id: string) => { nextFocusId: string | null };
  /** Revoke every staged blob URL and drop all attachments. */
  clear: () => void;
  /** Restore already-encoded attachments, e.g. a queued composer draft. */
  restoreReadyAttachments: (attachments: RestoredReadyAttachment[]) => void;
  /** Backwards-compatible alias for queued image drafts. */
  restoreReadyImages: (images: RestoredReadyImage[]) => void;
  /** ``true`` when at least one attachment is still encoding. */
  encoding: boolean;
  /** ``true`` when we've hit ``MAX_ATTACHMENTS_PER_MESSAGE``. */
  full: boolean;
}

/** Manage the lifecycle of files attached to the Composer.
 *
 * Images retain their existing Worker validation/normalization path. Supported
 * documents are read as bounded binary payloads; the server extracts their
 * text after upload, so they never enter a provider's image protocol.
 */
export function useAttachedImages(): UseAttachedImagesApi {
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  // Ref mirror so ``enqueue`` sees the authoritative length during rapid
  // selection, drag, or paste events in a single tick.
  const attachmentsRef = useRef<AttachedFile[]>([]);
  attachmentsRef.current = attachments;

  const setEntry = useCallback((id: string, patch: Partial<AttachedFile>) => {
    setAttachments((prev) => {
      const next = prev.map((attachment) => (
        attachment.id === id ? { ...attachment, ...patch } : attachment
      ));
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const enqueue = useCallback(
    (files: Iterable<File>) => {
      const rejected: Array<{ file: File; reason: AttachmentError }> = [];
      const toAdd: AttachedFile[] = [];
      let slot = MAX_ATTACHMENTS_PER_MESSAGE - attachmentsRef.current.length;

      for (const file of files) {
        const mime = attachmentMimeForFile(file);
        const kind = mime ? attachmentKindForMime(mime) : null;
        if (!mime || !kind) {
          rejected.push({ file, reason: "unsupported_type" });
          continue;
        }
        if (slot <= 0) {
          rejected.push({
            file,
            reason: kind === "image" ? "too_many_images" : "too_many_files",
          });
          continue;
        }
        if (kind === "file" && file.size > MAX_FILE_BYTES) {
          rejected.push({ file, reason: "file_too_large" });
          continue;
        }
        slot -= 1;
        toAdd.push({
          id: uuid(),
          file,
          previewUrl: URL.createObjectURL(file),
          kind,
          status: "encoding",
        });

        const entry = toAdd[toAdd.length - 1];
        // Fire conversion after the chip renders first (good INP).
        queueMicrotask(() => {
          void encodeAttachment(file, mime, kind).then(
            (result) => {
              if (result.ok) {
                setEntry(entry.id, {
                  status: "ready",
                  dataUrl: result.dataUrl,
                  encodedBytes: result.bytes,
                  normalized: result.normalized,
                });
              } else {
                setEntry(entry.id, {
                  status: "error",
                  error: result.reason,
                });
              }
            },
            () => {
              setEntry(entry.id, {
                status: "error",
                error: "decode_failed",
              });
            },
          );
        });
      }

      if (toAdd.length > 0) {
        const next = [...attachmentsRef.current, ...toAdd];
        attachmentsRef.current = next;
        setAttachments(next);
      }
      return { rejected };
    },
    [setEntry],
  );

  const remove = useCallback((id: string) => {
    let nextFocusId: string | null = null;
    setAttachments((prev) => {
      const idx = prev.findIndex((attachment) => attachment.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      try {
        URL.revokeObjectURL(target.previewUrl);
      } catch {
        // Preview URL revocation is best-effort.
      }
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      attachmentsRef.current = next;
      const candidate = next[idx] ?? next[idx - 1];
      nextFocusId = candidate?.id ?? null;
      return next;
    });
    return { nextFocusId };
  }, []);

  const clear = useCallback(() => {
    setAttachments((prev) => {
      for (const attachment of prev) {
        try {
          URL.revokeObjectURL(attachment.previewUrl);
        } catch {
          // Revocation is best-effort.
        }
      }
      attachmentsRef.current = [];
      return [];
    });
  }, []);

  const restoreReadyAttachments = useCallback((restored: RestoredReadyAttachment[]) => {
    const toRestore = restored
      .filter((attachment) => attachmentKindForDataUrl(attachment.dataUrl) !== null)
      .slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
      .map((attachment): AttachedFile => {
        const kind = attachmentKindForDataUrl(attachment.dataUrl) as AttachmentKind;
        const file = dataUrlToFile(attachment.dataUrl, attachment.name);
        return {
          id: uuid(),
          file,
          previewUrl: attachment.dataUrl,
          kind,
          status: "ready",
          dataUrl: attachment.dataUrl,
          encodedBytes: file.size,
          normalized: false,
        };
      });
    setAttachments((prev) => {
      for (const attachment of prev) {
        try {
          URL.revokeObjectURL(attachment.previewUrl);
        } catch {
          // Revocation is best-effort.
        }
      }
      attachmentsRef.current = toRestore;
      return toRestore;
    });
  }, []);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        try {
          URL.revokeObjectURL(attachment.previewUrl);
        } catch {
          // Best-effort cleanup on unmount.
        }
      }
    };
  }, []);

  const encoding = attachments.some((attachment) => attachment.status === "encoding");
  const full = attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE;

  return {
    attachments,
    images: attachments,
    enqueue,
    remove,
    clear,
    restoreReadyAttachments,
    restoreReadyImages: restoreReadyAttachments,
    encoding,
    full,
  };
}

/** New descriptive alias; the old hook name remains supported. */
export const useAttachedFiles = useAttachedImages;
