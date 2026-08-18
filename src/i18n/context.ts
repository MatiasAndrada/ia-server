import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_LANGUAGE, SupportedLanguage } from './languages.js';

/**
 * Idioma activo del turno de conversación en curso.
 *
 * Se usa AsyncLocalStorage en vez de pasar `lang` por parámetro porque
 * `templates.foo(...)` se invoca en ~200 lugares dentro de WhatsAppHandler,
 * repartidos en ~60 métodos privadas. Threading explícito significaría tocar
 * todas esas firmas (y sus tests) sin ganar nada: el idioma es contexto del
 * turno, no un argumento de negocio de cada función.
 *
 * WhatsAppHandler es un singleton que atiende varias conversaciones en
 * paralelo, así que guardar el idioma en `this` sería una race condition.
 * AsyncLocalStorage da aislamiento por cadena async, que es exactamente el
 * alcance de un turno.
 */
const languageStore = new AsyncLocalStorage<SupportedLanguage>();

/** Corre `fn` con `language` como idioma activo. Todo lo que se emita adentro sale en ese idioma. */
export function runWithLanguage<T>(language: SupportedLanguage, fn: () => T): T {
  return languageStore.run(language, fn);
}

/**
 * Idioma activo. Fuera de un `runWithLanguage` devuelve el default (español),
 * que es lo que mantiene verdes los tests y las rutas REST existentes.
 */
export function currentLanguage(): SupportedLanguage {
  return languageStore.getStore() ?? DEFAULT_LANGUAGE;
}

/** True si hay un idioma explícito en contexto (útil para logs/debug). */
export function hasLanguageContext(): boolean {
  return languageStore.getStore() !== undefined;
}
