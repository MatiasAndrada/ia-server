/**
 * Catálogo de idiomas soportados por el agente.
 *
 * Agregar un idioma nuevo se hace en tres pasos: sumarlo a SUPPORTED_LANGUAGES,
 * completar las tablas de este archivo, y crear su catálogo en ./catalogs/.
 * El tipo MessageCatalog obliga en compile-time a implementar todas las claves.
 */

export const SUPPORTED_LANGUAGES = ['es', 'en', 'pt'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'es';

/** Orden en el que se listan los idiomas en el menú de bienvenida (1️⃣, 2️⃣, 3️⃣). */
export const LANGUAGE_MENU_ORDER: readonly SupportedLanguage[] = ['es', 'en', 'pt'];

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Normaliza un valor guardado (DB/Redis) a un idioma soportado.
 * Devuelve null en vez de tirar: un valor viejo o corrupto no debe romper el flujo.
 */
export function coerceLanguage(value: unknown): SupportedLanguage | null {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLanguage(normalized) ? normalized : null;
}

/** Nombre del idioma en su propio idioma — lo que ve el cliente en el menú. */
export const LANGUAGE_NATIVE_NAMES: Record<SupportedLanguage, string> = {
  es: 'Español',
  en: 'English',
  pt: 'Português',
};

/** Nombre en inglés — se usa para instruir al LLM ("Respond in Portuguese"). */
export const LANGUAGE_ENGLISH_NAMES: Record<SupportedLanguage, string> = {
  es: 'Spanish',
  en: 'English',
  pt: 'Portuguese (Brazilian)',
};

/** Bandera representativa de cada idioma, para el menú. */
export const LANGUAGE_FLAGS: Record<SupportedLanguage, string> = {
  es: '🇪🇸',
  en: '🇬🇧',
  pt: '🇧🇷',
};

// ============================================================================
// Banderas → idioma
// ============================================================================

/**
 * Construye el emoji de bandera a partir de un código ISO de país (dos regional
 * indicator symbols). Se genera en vez de pegarse literal para que la tabla de
 * abajo sea legible y no se cuelen emojis mal copiados.
 */
function flagOf(countryCode: string): string {
  return String.fromCodePoint(
    ...[...countryCode.toUpperCase()].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65)
  );
}

/**
 * Países cuya bandera se interpreta como pedido de ese idioma. Un turista manda
 * la bandera de su país, no la del idioma — de ahí que 🇦🇷 y 🇲🇽 mapeen a `es`.
 */
const COUNTRIES_BY_LANGUAGE: Record<SupportedLanguage, string[]> = {
  es: [
    'ES', 'AR', 'MX', 'UY', 'CL', 'CO', 'PE', 'PY', 'BO',
    'EC', 'VE', 'CR', 'GT', 'CU', 'DO', 'HN', 'NI', 'PA', 'SV',
  ],
  en: ['GB', 'US', 'AU', 'CA', 'IE', 'NZ', 'ZA', 'IN'],
  pt: ['BR', 'PT', 'AO', 'MZ'],
};

export const FLAG_TO_LANGUAGE: ReadonlyMap<string, SupportedLanguage> = new Map(
  (Object.entries(COUNTRIES_BY_LANGUAGE) as [SupportedLanguage, string[]][]).flatMap(
    ([language, countries]) =>
      countries.map((country) => [flagOf(country), language] as [string, SupportedLanguage])
  )
);

/** Detecta cualquier par de regional indicator symbols (= un emoji de bandera). */
export const FLAG_EMOJI_PATTERN = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

// ============================================================================
// Nombres de idioma escritos → idioma
// ============================================================================

/**
 * Cómo puede escribir el cliente el nombre de un idioma, en cualquiera de los
 * idiomas soportados. Las claves van normalizadas (minúscula, sin acentos) —
 * ver normalizeForLanguageMatch.
 */
const LANGUAGE_ALIAS_SOURCES: Record<SupportedLanguage, string[]> = {
  es: ['español', 'espanol', 'castellano', 'spanish', 'espanhol', 'spagnolo', 'espagnol', 'es'],
  en: ['inglés', 'ingles', 'english', 'inglês', 'anglais', 'inglese', 'en'],
  pt: [
    'português', 'portugues', 'portuguese', 'portugués', 'brasileño', 'brasilero',
    'brasileiro', 'brazilian', 'portoghese', 'portugais', 'pt', 'br',
  ],
};

/** Quita acentos y pasa a minúscula, para comparar nombres de idioma escritos de cualquier forma. */
export function normalizeForLanguageMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // marcas diacríticas combinantes
    .toLowerCase()
    .trim();
}

export const LANGUAGE_ALIASES: ReadonlyMap<string, SupportedLanguage> = new Map(
  (Object.entries(LANGUAGE_ALIAS_SOURCES) as [SupportedLanguage, string[]][]).flatMap(
    ([language, aliases]) =>
      aliases.map(
        (alias) => [normalizeForLanguageMatch(alias), language] as [string, SupportedLanguage]
      )
  )
);
