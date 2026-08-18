import type {
  RAGReference,
  RAGReferenceChunk,
  RAGReferenceMedia,
  UIMessage,
} from "./types";

function isFilePatternReference(val: string): boolean {
  if (!val || val.length > 250) return false;
  return /(?:[*?]|(?:\*\*|\/\*))/.test(val);
}

function isTrustedLocalUrl(url: URL, href: string): boolean {
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  const currentOrigin = typeof window !== "undefined" ? window.location.origin : "";
  if (currentOrigin && url.origin === currentOrigin) return true;
  return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
}

export function fileReferenceFromUrl(
  href: string | undefined,
): { name: string; fullPath: string; rewrittenHref: string } | null {
  if (!href || href.startsWith("#")) return null;
  try {
    const url = new URL(href, "http://localhost");

    // Legacy LightRAG document URL: /documents/file/<rel-path>
    if (url.pathname.includes("/documents/file/")) {
      if (!isTrustedLocalUrl(url, href)) return null;
      const parts = url.pathname.split("/documents/file/");
      const rawPath = decodeURIComponent(parts[1] ?? "");
      const name = rawPath.split("/").filter(Boolean).pop() || rawPath;
      if (name && !isFilePatternReference(name)) {
        return { name, fullPath: rawPath, rewrittenHref: `/api/lightrag/file/default/${parts[1]}` };
      }
    }

    // Gateway-proxied LightRAG document URL: /api/lightrag/file/<server>/<rel-path>
    if (url.pathname.startsWith("/api/lightrag/file/")) {
      if (!isTrustedLocalUrl(url, href)) return null;
      const rest = url.pathname.slice("/api/lightrag/file/".length);
      const rawPath = decodeURIComponent(rest.split("/").slice(1).join("/"));
      const name = rawPath.split("/").filter(Boolean).pop() || rawPath;
      if (name && !isFilePatternReference(name)) {
        // Strip loopback domain if present to ensure it uses the current window origin
        const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
        const finalHref = isLoopback ? url.pathname + url.search + url.hash : href;
        return { name, fullPath: rawPath, rewrittenHref: finalHref };
      }
    }
  } catch {
    // Ignore invalid URLs
  }
  return null;
}

export interface DocumentReferenceItem {
  name: string;
  fullPath: string;
  href?: string;
}

const MAX_REFERENCE_TEXT_CHARS = 8_000;

export interface RAGEvidenceMedia extends RAGReferenceMedia {
  href?: string;
}

export interface RAGEvidenceItem {
  key: string;
  reference: RAGReference;
  name: string;
  fullPath: string;
  href?: string;
  media: RAGEvidenceMedia[];
}

function safeStructuredPath(value: unknown, allowAbsolute: boolean): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.includes("\0") || (!allowAbsolute && path.startsWith("/"))) return null;
  if (path.split("/").some((part) => part === "..")) return null;
  return path;
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    for (const params of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
      for (const key of params.keys()) {
        if (["access_token", "api_key", "apikey", "authorization", "token", "x_api_key"].includes(key.toLowerCase().replace(/-/g, "_"))) {
          return null;
        }
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

function gatewayEvidenceUrl(serverName: string | undefined, path: string): string | undefined {
  if (!serverName) return undefined;
  const encodedServer = encodeURIComponent(serverName);
  const encodedPath = path
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/api/lightrag/file/${encodedServer}/${encodedPath}`;
}

function normalizeStructuredReference(value: unknown): RAGReference | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const filePath = safeStructuredPath(raw.file_path ?? raw.path, true);
  if (!filePath) return null;
  const serverName = typeof raw.server_name === "string" ? raw.server_name.trim() : undefined;
  const reference: RAGReference = {
    file_path: filePath,
    server_name: serverName || undefined,
  };
  for (const key of ["reference_id", "title", "best_score_type"] as const) {
    if (typeof raw[key] === "string" && raw[key].trim()) reference[key] = raw[key].trim();
  }
  const sourceUrl = safeSourceUrl(raw.source_url);
  if (sourceUrl) reference.source_url = sourceUrl;
  for (const key of ["hit_count", "best_score"] as const) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) reference[key] = raw[key];
  }
  if (Array.isArray(raw.content)) {
    reference.content = raw.content
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.slice(0, MAX_REFERENCE_TEXT_CHARS));
  }
  if (Array.isArray(raw.chunks)) {
    const chunks: RAGReferenceChunk[] = [];
    for (const value of raw.chunks) {
      if (!value || typeof value !== "object") continue;
      const rawChunk = value as Record<string, unknown>;
      if (typeof rawChunk.chunk_id !== "string" || !rawChunk.chunk_id) continue;
      const chunk: RAGReferenceChunk = { chunk_id: rawChunk.chunk_id };
      if (typeof rawChunk.content === "string") {
        chunk.content = rawChunk.content.slice(0, MAX_REFERENCE_TEXT_CHARS);
      }
      for (const key of ["score", "rerank_score", "vector_score", "distance", "retrieval_rank"] as const) {
        if (typeof rawChunk[key] === "number" && Number.isFinite(rawChunk[key])) chunk[key] = rawChunk[key];
      }
      if (typeof rawChunk.score_type === "string" && rawChunk.score_type) chunk.score_type = rawChunk.score_type;
      chunks.push(chunk);
    }
    if (chunks.length) reference.chunks = chunks;
  }
  if (Array.isArray(raw.media)) {
    const media: RAGReferenceMedia[] = [];
    const seen = new Set<string>();
    for (const value of raw.media) {
      if (!value || typeof value !== "object") continue;
      const rawMedia = value as Record<string, unknown>;
      if (rawMedia.type !== "image") continue;
      const path = safeStructuredPath(rawMedia.path, false);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      media.push({
        type: "image",
        path,
        ...(typeof rawMedia.format === "string" ? { format: rawMedia.format } : {}),
        ...(typeof rawMedia.name === "string" ? { name: rawMedia.name } : {}),
        ...(typeof rawMedia.description === "string" ? { description: rawMedia.description } : {}),
      });
    }
    if (media.length) reference.media = media;
  }
  return reference;
}

function mergeStructuredReferences(existing: RAGReference, incoming: RAGReference): RAGReference {
  const merged: RAGReference = { ...existing, ...incoming };
  const chunks = [...(existing.chunks ?? [])];
  const chunkIndex = new Map(chunks.map((chunk, index) => [chunk.chunk_id, index]));
  for (const chunk of incoming.chunks ?? []) {
    const index = chunkIndex.get(chunk.chunk_id);
    if (index === undefined) {
      chunkIndex.set(chunk.chunk_id, chunks.length);
      chunks.push(chunk);
    } else {
      chunks[index] = { ...chunks[index], ...chunk };
    }
  }
  if (chunks.length) merged.chunks = chunks;
  const media = [...(existing.media ?? [])];
  const mediaPaths = new Set(media.map((item) => item.path));
  for (const item of incoming.media ?? []) {
    if (!mediaPaths.has(item.path)) {
      mediaPaths.add(item.path);
      media.push(item);
    }
  }
  if (media.length) merged.media = media;
  return merged;
}

export function extractStructuredRagReferencesFromMessages(
  activityMessages: UIMessage[] | undefined,
): RAGReference[] {
  if (!activityMessages) return [];
  const references = new Map<string, RAGReference>();
  for (const message of activityMessages) {
    for (const event of message.toolEvents ?? []) {
      if (!Array.isArray(event.references)) continue;
      for (const value of event.references) {
        const reference = normalizeStructuredReference(value);
        if (!reference) continue;
        const key = `${reference.server_name ?? ""}\0${reference.file_path}`;
        const previous = references.get(key);
        references.set(key, previous ? mergeStructuredReferences(previous, reference) : reference);
      }
    }
  }
  return [...references.values()];
}

export function extractRagEvidenceFromMessages(
  activityMessages: UIMessage[] | undefined,
): RAGEvidenceItem[] {
  return extractStructuredRagReferencesFromMessages(activityMessages).map((reference) => {
    const fullPath = reference.file_path;
    const name = reference.title?.trim() || fullPath.split("/").filter(Boolean).pop() || fullPath;
    const href = reference.source_url
      ?? gatewayEvidenceUrl(reference.server_name, fullPath);
    const media = (reference.media ?? []).map((item) => ({
      ...item,
      href: gatewayEvidenceUrl(reference.server_name, item.path),
    }));
    return {
      key: `${reference.server_name ?? ""}\0${reference.file_path}`,
      reference,
      name,
      fullPath,
      href,
      media,
    };
  });
}

/** Markdown escapes emitted by the LightRAG formatter. */
const MARKDOWN_ESCAPE_RE = /\\(.)/g;
const MARKDOWN_ESCAPABLE = new Set([
  "\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "!", "|", ">", "+",
]);

export function extractDocumentReferencesFromText(text: string): DocumentReferenceItem[] {
  if (!text) return [];
  const items: DocumentReferenceItem[] = [];
  const seen = new Set<string>();

  const addRef = (name: string, fullPath: string, href?: string) => {
    const cleanName = name
      .replace(/^(?:📄|📝|📊|🖼️|📦|🎵|🎥|💻|📎)\s*/u, "")
      .replace(MARKDOWN_ESCAPE_RE, (match, char: string) => (
        MARKDOWN_ESCAPABLE.has(char) ? char : match
      ))
      .trim();
    if (!cleanName) return;
    const key = href || fullPath || cleanName;
    if (!seen.has(key)) {
      seen.add(key);
      items.push({ name: cleanName, fullPath: fullPath || cleanName, href });
    }
  };

  // 1. Match LightRAG reference lines: e.g. "1. [label](url)" or "1. filename.pdf (id:1)"
  const lightragLineRegex = /^\s*\d+\.\s*(?:\[((?:\\.|[^\]])+)\]\(([^)]+)\)|([^\s(]+)(?:\s+\(id:[^)]+\))?)/gm;
  let match: RegExpExecArray | null;
  while ((match = lightragLineRegex.exec(text)) !== null) {
    const label = match[1];
    const url = match[2];
    const plainPath = match[3];

    if (url) {
      const urlRef = fileReferenceFromUrl(url);
      addRef(label || urlRef?.name || "file", urlRef?.fullPath || label || "file", urlRef?.rewrittenHref || url);
    } else if (plainPath) {
      const cleanPath = plainPath.trim();
      if (
        cleanPath &&
        !cleanPath.startsWith("http://") &&
        !cleanPath.startsWith("https://") &&
        /\.(pdf|doc|docx|wps|xls|xlsx|csv|ppt|pptx|png|jpg|jpeg|webp|svg|txt|md|json|zip)$/i.test(cleanPath)
      ) {
        const name = cleanPath.split("/").filter(Boolean).pop() || cleanPath;
        addRef(name, cleanPath);
      }
    }
  }

  // 2. Match Markdown links: [label](url) where url contains /documents/file/
  const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  while ((match = markdownLinkRegex.exec(text)) !== null) {
    const label = match[1];
    const href = match[2];
    const urlRef = fileReferenceFromUrl(href);
    if (urlRef) {
      addRef(label || urlRef.name, urlRef.fullPath, urlRef.rewrittenHref);
    }
  }

  // 3. Standalone URLs with /documents/file/
  const standaloneUrlRegex = /(https?:\/\/[^\s)>]+)/g;
  while ((match = standaloneUrlRegex.exec(text)) !== null) {
    const href = match[1];
    const urlRef = fileReferenceFromUrl(href);
    if (urlRef) {
      addRef(urlRef.name, urlRef.fullPath, urlRef.rewrittenHref);
    }
  }

  return items;
}

const messageReferenceCache = new WeakMap<UIMessage, DocumentReferenceItem[]>();

/**
 * Extract document references from activity trace messages or assistant content.
 *
 * When structured RAG evidence is present in toolEvents, it takes precedence
 * and is returned directly. If no structured evidence is available, this falls
 * back to regular expression extraction from message text (for backwards
 * compatibility with legacy traces and non-LightRAG references).
 */
export function extractDocumentReferencesFromMessages(
  activityMessages: UIMessage[] | undefined,
  assistantContent?: string,
): DocumentReferenceItem[] {
  const structuredEvidence = extractRagEvidenceFromMessages(activityMessages);
  if (structuredEvidence.length > 0) {
    return structuredEvidence.map(({ name, fullPath, href }) => ({
      name,
      fullPath,
      href,
    }));
  }

  const result: DocumentReferenceItem[] = [];
  const seen = new Set<string>();

  const processItems = (items: DocumentReferenceItem[]) => {
    for (const item of items) {
      const key = item.href || item.fullPath || item.name;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
  };

  if (activityMessages) {
    for (const msg of activityMessages) {
      if (!messageReferenceCache.has(msg)) {
        const msgItems: DocumentReferenceItem[] = [];
        const msgSeen = new Set<string>();
        const addItems = (text: string | undefined) => {
          if (!text) return;
          for (const item of extractDocumentReferencesFromText(text)) {
            const key = item.href || item.fullPath || item.name;
            if (!msgSeen.has(key)) {
              msgSeen.add(key);
              msgItems.push(item);
            }
          }
        };

        addItems(msg.content);
        if (msg.traces) {
          for (const trace of msg.traces) addItems(trace);
        }
        if (msg.toolEvents) {
          for (const ev of msg.toolEvents) {
            if (typeof ev.result === "string") {
              addItems(ev.result);
            } else if (ev.result && typeof ev.result === "object") {
              addItems(JSON.stringify(ev.result));
            }
            // Do not scan arguments to prevent user-provided inputs from appearing as references
          }
        }
        messageReferenceCache.set(msg, msgItems);
      }
      processItems(messageReferenceCache.get(msg)!);
    }
  }

  if (assistantContent) {
    processItems(extractDocumentReferencesFromText(assistantContent));
  }

  return result;
}
