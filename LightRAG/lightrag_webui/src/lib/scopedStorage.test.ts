import { afterEach, describe, expect, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Set up globals BEFORE importing the module under test
// ---------------------------------------------------------------------------

const storageData = new Map<string, string>()
const storageMock = {
  getItem: (key: string) => storageData.get(key) ?? null,
  setItem: (key: string, value: string) => { storageData.set(key, value) },
  removeItem: (key: string) => { storageData.delete(key) },
  clear: () => { storageData.clear() },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: storageMock,
  configurable: true,
})

// bun test has no `window` by default; provide a minimal one so the embedded
// URL-param and __LIGHTRAG_CONFIG__ paths of scopedStorage are exercised.
const windowMock = {
  __LIGHTRAG_CONFIG__: { apiPrefix: '', webuiPrefix: '/webui/' },
  location: { search: '' },
}
Object.defineProperty(globalThis, 'window', {
  value: windowMock,
  configurable: true,
})

import {
  scopedStorage,
  scopedStorageKey,
  storageNamespaceFromPath,
} from '@/lib/scopedStorage'

describe('scopedStorage', () => {
  afterEach(() => {
    storageData.clear()
    windowMock.location.search = ''
  })

  test('keeps keys unchanged when not embedded', () => {
    expect(scopedStorageKey('LIGHTRAG-API-TOKEN')).toBe('LIGHTRAG-API-TOKEN')
    scopedStorage.setItem('LIGHTRAG-API-TOKEN', 'tok')
    expect(storageData.get('LIGHTRAG-API-TOKEN')).toBe('tok')
    expect(scopedStorage.getItem('LIGHTRAG-API-TOKEN')).toBe('tok')
    scopedStorage.removeItem('LIGHTRAG-API-TOKEN')
    expect(storageData.get('LIGHTRAG-API-TOKEN')).toBeUndefined()
  })

  test('prefixes keys by the webui path when embedded', () => {
    windowMock.location.search = '?embedded=1'
    expect(scopedStorageKey('LIGHTRAG-API-TOKEN')).toBe('lightrag:webui:LIGHTRAG-API-TOKEN')
  })

  test('isolates embedded storage from the shared unprefixed keys', () => {
    storageData.set('LIGHTRAG-API-TOKEN', 'shared-token')
    windowMock.location.search = '?embedded=1'
    // The embedded instance must not see the standalone instance's token.
    expect(scopedStorage.getItem('LIGHTRAG-API-TOKEN')).toBeNull()
    scopedStorage.setItem('LIGHTRAG-API-TOKEN', 'embedded-token')
    expect(scopedStorage.getItem('LIGHTRAG-API-TOKEN')).toBe('embedded-token')
    // And it must not overwrite the standalone key either.
    expect(storageData.get('LIGHTRAG-API-TOKEN')).toBe('shared-token')
    expect(storageData.get('lightrag:webui:LIGHTRAG-API-TOKEN')).toBe('embedded-token')
  })

  test('removes only the scoped key in embedded mode', () => {
    storageData.set('LIGHTRAG-API-TOKEN', 'shared-token')
    storageData.set('lightrag:webui:LIGHTRAG-API-TOKEN', 'embedded-token')
    windowMock.location.search = '?embedded=1'
    scopedStorage.removeItem('LIGHTRAG-API-TOKEN')
    expect(storageData.get('lightrag:webui:LIGHTRAG-API-TOKEN')).toBeUndefined()
    expect(storageData.get('LIGHTRAG-API-TOKEN')).toBe('shared-token')
  })

  test('derives distinct namespaces for distinct webui paths', () => {
    expect(storageNamespaceFromPath('/webui/')).toBe('webui')
    expect(storageNamespaceFromPath('/site01/webui/')).toBe('site01_webui')
    expect(storageNamespaceFromPath('/rag-a/webui/')).toBe('rag_a_webui')
    expect(storageNamespaceFromPath('//rag_b/webui')).toBe('rag_b_webui')
    expect(storageNamespaceFromPath('////')).toBe('webui')
  })
})
