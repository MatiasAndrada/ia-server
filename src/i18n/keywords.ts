/**
 * Palabras clave multilingües del flujo de reserva.
 *
 * Decisión de diseño: se acepta la UNIÓN de los tres idiomas en un solo matcher,
 * no tres parsers seleccionados por idioma activo. Los clientes mezclan idiomas
 * permanentemente ("ok", "yes", "sí", "sim"), un brasileño escribe CANCEL, y un
 * turista saluda en inglés antes de elegir español. Un matcher por idioma
 * fallaría justo en esos casos, además de triplicar el código.
 *
 * El texto que llega acá ya viene normalizado (minúsculas, sin acentos) por
 * normalizeCourtesyText / normalizeReservationScopeText.
 */

/**
 * Saludos en ES / EN / PT.
 *
 * Incluye variantes informales rioplatenses (holaa, ey, yoo) y brasileñas
 * (oi, opa, eai). Es un fragmento de regex sin anclas: los callers lo componen
 * según necesiten (mensaje completo, prefijo, etc).
 */
export const GREETING_UNIT_SOURCE =
  '(?:' +
  // Español
  'hola{1,6}|holis|holiwis|ola{1,3}|buenas|buenos\\s+dias|buenas\\s+tardes|buenas\\s+noches|' +
  'buen\\s+dia|que\\s+tal|quetal|saludos|ey+|yoo+|' +
  // Inglés
  'hello+|hi+|hey+|good\\s+morning|good\\s+afternoon|good\\s+evening|greetings|' +
  // Portugués
  'oi+|oie|opa|eai|e\\s+ai|bom\\s+dia|boa\\s+tarde|boa\\s+noite|ola' +
  ')';

/** Un mensaje que es SOLO saludo (uno o varios encadenados: "hola buenos dias"). */
export const GREETING_MESSAGE_PATTERN = new RegExp(
  `^${GREETING_UNIT_SOURCE}(?:\\s+${GREETING_UNIT_SOURCE})*$`
);

export function isMultilingualGreeting(normalizedText: string): boolean {
  return GREETING_MESSAGE_PATTERN.test(normalizedText.trim());
}

/**
 * Palabras mágicas de cancelación, en los tres idiomas. `cancelar` es idéntica
 * en ES y PT, lo que reduce la ambigüedad entre esos dos.
 */
export const CANCEL_KEYWORDS = [
  'cancelar', 'cancela', 'cancelo', 'anular', 'anula',
  'cancel', 'cancelled', 'canceled',
] as const;

/** Palabras para arrancar una reserva nueva. */
export const BOOK_KEYWORDS = [
  'reservar', 'reserva', 'reservo',
  'book', 'booking', 'reserve', 'reservation',
] as const;

/** Palabras para salir/abandonar el flujo en curso. */
export const EXIT_KEYWORDS = [
  'salir', 'salgo', 'dejalo', 'olvidalo', 'nada',
  'exit', 'quit', 'stop', 'never mind', 'nevermind', 'forget it',
  'sair', 'esquece', 'deixa',
] as const;

/** Afirmaciones. */
export const AFFIRMATIVE_KEYWORDS = [
  'si', 'sí', 'dale', 'claro', 'obvio', 'va', 'listo', 'perfecto', 'de una',
  'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'alright', 'correct',
  'sim', 'claro que sim', 'certo', 'beleza', 'isso',
] as const;

/** Negaciones. */
export const NEGATIVE_KEYWORDS = [
  'no', 'nop', 'nel', 'para nada',
  'nope', 'nah', 'not really',
  'nao', 'não',
] as const;

/** Agradecimientos. */
export const GRATITUDE_KEYWORDS = [
  'gracias', 'muchas gracias', 'mil gracias', 'genial', 'barbaro',
  'thanks', 'thank you', 'thx', 'great', 'awesome', 'perfect',
  'obrigado', 'obrigada', 'valeu', 'otimo', 'ótimo',
] as const;

function buildAlternation(words: readonly string[]): string {
  return words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .sort((a, b) => b.length - a.length) // el más largo primero, para que gane "thank you" sobre "thanks"
    .join('|');
}

/** Construye un regex que matchea cualquiera de `words` como palabra completa. */
export function buildKeywordPattern(words: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${buildAlternation(words)})\\b`);
}

/** Construye un regex que matchea si el mensaje ENTERO es una de `words`. */
export function buildExactKeywordPattern(words: readonly string[]): RegExp {
  return new RegExp(`^(?:${buildAlternation(words)})$`);
}
