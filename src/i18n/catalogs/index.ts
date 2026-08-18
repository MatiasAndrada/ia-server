import { SupportedLanguage } from '../languages.js';
import { currentLanguage } from '../context.js';
import { esCatalog, type MessageCatalog } from './es.js';
import { enCatalog } from './en.js';
import { ptCatalog } from './pt.js';

export type { MessageCatalog } from './es.js';

const CATALOGS: Record<SupportedLanguage, MessageCatalog> = {
  es: esCatalog,
  en: enCatalog,
  pt: ptCatalog,
};

/**
 * Catálogo de un idioma puntual. API explícita para los senders de background
 * (realtime-sync, post-visit), que corren fuera del contexto de un turno, y para
 * los tests.
 */
export function getTemplates(language: SupportedLanguage): MessageCatalog {
  return CATALOGS[language] ?? esCatalog;
}

/**
 * Catálogo del idioma activo (ver ../context.ts). Es lo que usan los dispatchers
 * de utils/message-templates.ts, de forma que los ~200 call sites del handler no
 * necesitan saber nada del idioma.
 */
export function catalog(): MessageCatalog {
  return getTemplates(currentLanguage());
}

/** Solo para tests: permite iterar los tres catálogos y validar completitud. */
export const ALL_CATALOGS: Readonly<Record<SupportedLanguage, MessageCatalog>> = CATALOGS;
