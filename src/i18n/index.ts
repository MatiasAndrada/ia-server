export {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  LANGUAGE_MENU_ORDER,
  LANGUAGE_NATIVE_NAMES,
  LANGUAGE_ENGLISH_NAMES,
  LANGUAGE_FLAGS,
  FLAG_TO_LANGUAGE,
  LANGUAGE_ALIASES,
  isSupportedLanguage,
  coerceLanguage,
  normalizeForLanguageMatch,
  type SupportedLanguage,
} from './languages.js';

export { runWithLanguage, currentLanguage, hasLanguageContext } from './context.js';

export { getTemplates, catalog, ALL_CATALOGS, type MessageCatalog } from './catalogs/index.js';
