import { describe, expect, test } from 'bun:test'
import { normalizeLanguage, SUPPORTED_LANGUAGES } from '@/i18n'

describe('i18n normalizeLanguage', () => {
  test('returns null for null, undefined, or empty string', () => {
    expect(normalizeLanguage(null)).toBeNull()
    expect(normalizeLanguage(undefined)).toBeNull()
    expect(normalizeLanguage('')).toBeNull()
    expect(normalizeLanguage('   ')).toBeNull()
  })

  test('recognizes all supported language codes directly', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(normalizeLanguage(lang)).toBe(lang)
    }
  })

  test('normalizes Simplified Chinese variants to zh', () => {
    expect(normalizeLanguage('zh')).toBe('zh')
    expect(normalizeLanguage('zh-cn')).toBe('zh')
    expect(normalizeLanguage('ZH-CN')).toBe('zh')
    expect(normalizeLanguage('zh_cn')).toBe('zh')
    expect(normalizeLanguage('zh-Hans')).toBe('zh')
    expect(normalizeLanguage('zh-hans-cn')).toBe('zh')
    expect(normalizeLanguage('zh-SG')).toBe('zh')
  })

  test('normalizes Traditional Chinese variants to zh_TW', () => {
    expect(normalizeLanguage('zh_TW')).toBe('zh_TW')
    expect(normalizeLanguage('zh-tw')).toBe('zh_TW')
    expect(normalizeLanguage('ZH-TW')).toBe('zh_TW')
    expect(normalizeLanguage('zh_tw')).toBe('zh_TW')
    expect(normalizeLanguage('zh-hk')).toBe('zh_TW')
    expect(normalizeLanguage('zh-mo')).toBe('zh_TW')
    expect(normalizeLanguage('zh-Hant')).toBe('zh_TW')
    expect(normalizeLanguage('zh-hant-hk')).toBe('zh_TW')
  })

  test('matches base language prefixes for other supported languages', () => {
    expect(normalizeLanguage('fr-FR')).toBe('fr')
    expect(normalizeLanguage('ja-JP')).toBe('ja')
    expect(normalizeLanguage('ko-KR')).toBe('ko')
    expect(normalizeLanguage('de-DE')).toBe('de')
    expect(normalizeLanguage('ru-RU')).toBe('ru')
    expect(normalizeLanguage('ar-EG')).toBe('ar')
    expect(normalizeLanguage('uk-UA')).toBe('uk')
    expect(normalizeLanguage('vi-VN')).toBe('vi')
    expect(normalizeLanguage('en-US')).toBe('en')
  })

  test('returns null for unsupported languages', () => {
    expect(normalizeLanguage('es')).toBeNull()
    expect(normalizeLanguage('pt-BR')).toBeNull()
    expect(normalizeLanguage('unknown')).toBeNull()
  })
})
