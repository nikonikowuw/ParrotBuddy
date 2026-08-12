import type { UIMessage } from "./types";

function isFilePatternReference(val: string): boolean {
  if (!val || val.length > 250) return false;
  return /(?:[*?[\]{}]|(?:\*\*|\/\*))/.test(val);
}

export function fileReferenceFromUrl(
  href: string | undefined,
): { name: string; fullPath: string; rewrittenHref: string } | null {
  if (!href || href.startsWith("#")) return null;
  try {
    const url = new URL(href, "http://localhost");

    // Legacy LightRAG document URL: /documents/file/<rel-path>
    if (url.pathname.includes("/documents/file/")) {
      const parts = url.pathname.split("/documents/file/");
      const rawPath = decodeURIComponent(parts[1] ?? "");
      const name = rawPath.split("/").filter(Boolean).pop() || rawPath;
      if (name && !isFilePatternReference(name)) {
        return { name, fullPath: rawPath, rewrittenHref: `/api/lightrag/file/default/${parts[1]}` };
      }
    }

    // Gateway-proxied LightRAG document URL: /api/lightrag/file/<server>/<rel-path>
    if (url.pathname.startsWith("/api/lightrag/file/")) {
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

export function extractDocumentReferencesFromText(text: string): DocumentReferenceItem[] {
  if (!text) return [];
  const items: DocumentReferenceItem[] = [];
  const seen = new Set<string>();

  const addRef = (name: string, fullPath: string, href?: string) => {
    const cleanName = name.replace(/^(?:📄|📝|📊|🖼️|📦|🎵|🎥|💻|📎)\s*/u, "").trim();
    if (!cleanName) return;
    const key = href || fullPath || cleanName;
    if (!seen.has(key)) {
      seen.add(key);
      items.push({ name: cleanName, fullPath: fullPath || cleanName, href });
    }
  };

  // 1. Match LightRAG reference lines: e.g. "1. [label](url)" or "1. filename.pdf (id:1)"
  const lightragLineRegex = /^\s*\d+\.\s*(?:\[([^\]]+)\]\(([^)]+)\)|([^\s(]+)(?:\s+\(id:[^)]+\))?)/gm;
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

export function extractDocumentReferencesFromMessages(
  activityMessages: UIMessage[] | undefined,
  assistantContent?: string,
): DocumentReferenceItem[] {
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
