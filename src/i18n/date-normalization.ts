/**
 * Normalización de referencias de fecha/hora en inglés y portugués a sus
 * equivalentes canónicos en español.
 *
 * DECISIÓN DE DISEÑO — por qué una tabla y no tres parsers:
 *
 * `reservation-datetime.ts` son 837 líneas de lógica de calendario probada
 * (ventana de 7 días, turnos partidos, márgenes de apertura/cierre, fechas
 * bloqueadas, desambiguación de día de semana) con 404 líneas de tests.
 * Reescribirla por idioma triplicaría la superficie de bugs en la parte más
 * delicada del sistema.
 *
 * En cambio, este pre-pass traduce SOLO los tokens temporales antes de que el
 * parser existente los vea, así `parseRelativeDay`, `parseTimeOfDay` y
 * `hasDateOrTimeSignal` siguen funcionando exactamente igual y sin modificarse.
 *
 * Se engancha dentro de `normalizeReservationScopeText`, que es el único punto
 * por el que ya pasaban todos esos parsers.
 *
 * IMPORTANTE: la normalización debe ser IDEMPOTENTE sobre texto en español —
 * una entrada en español tiene que salir idéntica. Hay un test que lo verifica.
 */

/**
 * Tokens temporales extranjeros → canónico español, ya sin acentos y en
 * minúscula (el texto llega normalizado por NFD).
 *
 * El orden importa: las entradas de varias palabras van primero para que
 * "day after tomorrow" gane sobre "tomorrow", y "depois de amanha" sobre
 * "amanha".
 */
const TEMPORAL_TOKENS: readonly (readonly [string, string])[] = [
  // --- Días relativos (multi-palabra primero) ---
  ['day after tomorrow', 'pasado manana'],
  ['depois de amanha', 'pasado manana'],
  ['tomorrow', 'manana'],
  ['amanha', 'manana'],
  ['today', 'hoy'],
  ['hoje', 'hoy'],
  ['tonight', 'hoy de la noche'],
  ['hoje a noite', 'hoy de la noche'],
  ['this evening', 'hoy de la noche'],
  ['this afternoon', 'hoy de la tarde'],
  ['hoje a tarde', 'hoy de la tarde'],

  // --- Días de la semana ---
  // Inglés
  ['monday', 'lunes'],
  ['tuesday', 'martes'],
  ['wednesday', 'miercoles'],
  ['thursday', 'jueves'],
  ['friday', 'viernes'],
  ['saturday', 'sabado'],
  ['sunday', 'domingo'],
  // Portugués — la forma larga "-feira" primero, si no "segunda" sola se
  // consumiría y dejaría "-feira" colgando.
  ['segunda-feira', 'lunes'],
  ['segunda feira', 'lunes'],
  ['terca-feira', 'martes'],
  ['terca feira', 'martes'],
  ['quarta-feira', 'miercoles'],
  ['quarta feira', 'miercoles'],
  ['quinta-feira', 'jueves'],
  ['quinta feira', 'jueves'],
  ['sexta-feira', 'viernes'],
  ['sexta feira', 'viernes'],
  ['segunda', 'lunes'],
  ['terca', 'martes'],
  ['quarta', 'miercoles'],
  ['quinta', 'jueves'],
  ['sexta', 'viernes'],
  // "sabado" y "domingo" son idénticos en ES y PT — no necesitan entrada.

  // --- Franjas horarias (alimentan applyTimeOfDayQualifier) ---
  ['in the evening', 'de la noche'],
  ['in the afternoon', 'de la tarde'],
  ['in the morning', 'de la manana'],
  ['at night', 'de la noche'],
  ['da noite', 'de la noche'],
  ['a noite', 'de la noche'],
  ['da tarde', 'de la tarde'],
  ['a tarde', 'de la tarde'],
  ['da manha', 'de la manana'],
  ['de manha', 'de la manana'],

  // --- Expresiones de hora ---
  // "half past"/"quarter past" NO van acá: en inglés el modificador va ANTES
  // del número y en español después, así que necesitan reordenar. Ver PHRASE_REWRITES.
  ['e meia', 'y media'],
  ['e quinze', 'y cuarto'],
  ['at around', 'a eso de las'],
  ["o'clock", 'hs'],
  ['horas', 'hs'],

  // --- Preposiciones de hora, para que matcheen los patrones "a las N" ---
  ['at the', 'a las'],
  ['around', 'a eso de las'],

  // --- "ahora" (elección de turno instantáneo) ---
  ['right now', 'ahora'],
  ['now', 'ahora'],
  ['agora', 'ahora'],
];

/**
 * Reescrituras que necesitan REORDENAR, no solo sustituir.
 *
 * En inglés el modificador va antes del número ("half past nine") y en español
 * después ("nueve y media"), así que un reemplazo literal produciría
 * "y media 9" y el parser no lo reconocería. Se aplican ANTES que la tabla de
 * tokens literales.
 */
const PHRASE_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/\bhalf\s+past\s+(\d{1,2})\b/g, '$1 y media'],
  [/\bquarter\s+past\s+(\d{1,2})\b/g, '$1 y cuarto'],
  [/\bquarter\s+to\s+(\d{1,2})\b/g, '$1 menos cuarto'],
  // "meia" y "quinze" en portugués sí van después del número, como en español.
];

/**
 * "at" → "a las" solo cuando precede a un número ("at 9", "at 21:00"), para no
 * romper "at the restaurant" ni "look at". Se aplica aparte del reemplazo
 * literal porque necesita lookahead.
 */
const ENGLISH_AT_TIME = /\bat\s+(?=\d)/g;

/** "as 21", "as 9 horas" — el "as" portugués delante de un número. */
const PORTUGUESE_AS_TIME = /\bas\s+(?=\d)/g;

const TEMPORAL_PATTERNS: readonly (readonly [RegExp, string])[] = TEMPORAL_TOKENS.map(
  ([foreign, canonical]) =>
    [
      new RegExp(`\\b${foreign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'g'),
      canonical,
    ] as const
);

/**
 * Traduce tokens temporales de EN/PT al canónico español. Devuelve el texto sin
 * cambios cuando ya está en español.
 *
 * Espera texto YA normalizado (minúsculas, sin acentos, sin puntuación).
 */
export function normalizeTemporalTokens(normalizedText: string): string {
  let result = normalizedText;

  // Primero las que reordenan, para que "half past 9" quede "9 y media" antes
  // de que cualquier sustitución literal toque esas palabras.
  for (const [pattern, replacement] of PHRASE_REWRITES) {
    result = result.replace(pattern, replacement);
  }

  for (const [pattern, canonical] of TEMPORAL_PATTERNS) {
    result = result.replace(pattern, canonical);
  }

  result = result.replace(ENGLISH_AT_TIME, 'a las ');
  result = result.replace(PORTUGUESE_AS_TIME, 'a las ');

  return result.replace(/\s+/g, ' ').trim();
}
