/**
 * Path-scoped localStorage for embedded mode.
 *
 * When the WebUI is embedded inside nanobot (`?embedded=1`), two LightRAG
 * instances mounted at different paths of the same origin (e.g. `/rag-a` and
 * `/rag-b`) would otherwise share every localStorage key — auth token, theme,
 * current tab and the rest of the persisted settings. This module re-keys
 * storage by the WebUI mount path so each instance keeps its own state.
 *
 * Standalone (non-embedded) mode keeps the original unprefixed keys for
 * backward compatibility, so existing installations are unaffected.
 */

import { webuiPrefix } from '@/lib/constants'

/**
 * Resolve the storage object lazily at call time rather than at module load:
 * ES-module imports are hoisted, so a module-load capture would grab bun's
 * native ``localStorage`` in tests before their ``Object.defineProperty``
 * mock has run. Browsers expose it as ``window.localStorage``; test environs
 * define it on ``globalThis``.
 */
function globalLocalStorage(): Storage | undefined {
  if (typeof globalThis === 'undefined') return undefined
  return (globalThis as { localStorage?: Storage }).localStorage
}

/**
 * Namespace token derived from a WebUI mount path: non-alphanumerics become
 * underscores and empty results fall back to ``webui``. Kept pure so the
 * distinct-namespace-per-path behavior is unit-testable without a DOM.
 * (e.g. `/webui/` → `webui`, `/site01/webui/` → `site01_webui`).
 */
export function storageNamespaceFromPath(path: string): string {
  const token = path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return token || 'webui'
}

/**
 * The namespace suffix for embedded mode, derived from the WebUI mount path.
 * Returns `null` when not embedded, which keeps storage keys unchanged.
 */
function embeddedStorageNamespace(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (params.get('embedded') !== '1') return null
  return storageNamespaceFromPath(webuiPrefix || '/webui/')
}

export function scopedStorageKey(key: string): string {
  const ns = embeddedStorageNamespace()
  return ns ? `lightrag:${ns}:${key}` : key
}

/** localStorage adapter that transparently prefixes keys in embedded mode. */
export const scopedStorage = {
  getItem: (key: string): string | null =>
    globalLocalStorage()?.getItem(scopedStorageKey(key)) ?? null,
  setItem: (key: string, value: string): void =>
    globalLocalStorage()?.setItem(scopedStorageKey(key), value),
  removeItem: (key: string): void =>
    globalLocalStorage()?.removeItem(scopedStorageKey(key)),
}
