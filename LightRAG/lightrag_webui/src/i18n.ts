import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { useSettingsStore } from '@/stores/settings'
import { scopedStorage } from '@/lib/scopedStorage'

import en from './locales/en.json'
import zh from './locales/zh.json'
import fr from './locales/fr.json'
import ar from './locales/ar.json'
import zh_TW from './locales/zh_TW.json'
import ru from './locales/ru.json'
import ja from './locales/ja.json'
import de from './locales/de.json'
import uk from './locales/uk.json'
import ko from './locales/ko.json'
import vi from './locales/vi.json'

export const SUPPORTED_LANGUAGES = ['en', 'zh', 'fr', 'ar', 'zh_TW', 'ru', 'ja', 'de', 'uk', 'ko', 'vi'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export function normalizeLanguage(lang: string | null | undefined): SupportedLanguage | null {
  if (!lang) return null
  const trimmed = lang.trim()
  if (SUPPORTED_LANGUAGES.includes(trimmed as SupportedLanguage)) {
    return trimmed as SupportedLanguage
  }
  const lower = trimmed.toLowerCase()
  if (
    lower === 'zh' ||
    lower === 'zh-cn' ||
    lower === 'zh_cn' ||
    lower.startsWith('zh-hans') ||
    lower.startsWith('zh-sg')
  ) {
    return 'zh'
  }
  if (
    lower === 'zh-tw' ||
    lower === 'zh_tw' ||
    lower === 'zh-hk' ||
    lower === 'zh-mo' ||
    lower.startsWith('zh-hant')
  ) {
    return 'zh_TW'
  }
  const base = lower.split(/[-_]/)[0]
  const match = SUPPORTED_LANGUAGES.find((l) => l.toLowerCase() === base)
  return match ?? null
}

const getStoredLanguage = () => {
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.get('embedded') === '1') {
        const langParam = normalizeLanguage(params.get('lang'))
        if (langParam) return langParam
      }
    }
    const settingsString = scopedStorage.getItem('settings-storage')
    if (settingsString) {
      const settings = JSON.parse(settingsString)
      return settings.state?.language || 'en'
    }
  } catch (e) {
    console.error('Failed to get stored language:', e)
  }
  return 'en'
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      fr: { translation: fr },
      ar: { translation: ar },
      zh_TW: { translation: zh_TW },
      ru: { translation: ru },
      ja: { translation: ja },
      de: { translation: de },
      uk: { translation: uk },
      ko: { translation: ko },
      vi: { translation: vi }
    },
    lng: getStoredLanguage(), // Use stored language settings
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    },
    // Configuration to handle missing translations
    returnEmptyString: false,
    returnNull: false,
  })

// Subscribe to language changes
useSettingsStore.subscribe((state) => {
  const currentLanguage = state.language
  if (i18n.language !== currentLanguage) {
    i18n.changeLanguage(currentLanguage)
  }
})

export default i18n
