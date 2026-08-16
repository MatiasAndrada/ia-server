import {
  FLAG_EMOJI_PATTERN,
  FLAG_TO_LANGUAGE,
  LANGUAGE_ALIASES,
  LANGUAGE_MENU_ORDER,
  normalizeForLanguageMatch,
  SupportedLanguage,
} from './languages';

/**
 * Detección de idioma y de pedidos explícitos de cambio de idioma.
 *
 * Determinista primero, igual que el resto del repo (los parsers de fecha/hora
 * corren antes que el LLM). Acá el sesgo es todavía más conservador: ante la
 * duda se devuelve null y el menú resuelve la ambigüedad. Un falso positivo
 * ("vinieron unos amigos brasileños" → cambia a portugués) es mucho peor que un
 * falso negativo, porque el cliente pierde el hilo de la conversación.
 */

// ============================================================================
// Cambio explícito de idioma
// ============================================================================

export type LanguageChangeSource = 'flag' | 'menu_number' | 'language_name' | 'change_phrase';

export interface LanguageChangeRequest {
  language: SupportedLanguage;
  source: LanguageChangeSource;
}

/**
 * Verbos/frases que, acompañados de un nombre de idioma, indican pedido de
 * cambio. Deliberadamente en los tres idiomas: un cliente puede pedir el cambio
 * escribiendo en el idioma que todavía no tiene activo ("can you speak spanish").
 */
const CHANGE_VERB_PATTERN =
  /\b(?:cambi\w*|camb\w*|pasa\w*|habl\w*|escrib\w*|responde\w*|contest\w*|pod[eé]s|puedes|quiero|prefiero|prefier\w*|switch\w*|change\w*|speak\w*|talk\w*|write\w*|reply\w*|answer\w*|can\s+you|could\s+you|please|mud\w*|troc\w*|fal\w*|escrev\w*|respond\w*|quero|prefiro|voc[eê]\s+pode|pode)\b/;

/** "en inglés", "to english", "em português" — la preposición delante del idioma. */
const LANGUAGE_PREPOSITION_PATTERN = /\b(?:en|em|in|a|to|al|ao|para|pra|por)\b/;

/**
 * Detecta un pedido explícito de cambio de idioma. Devuelve null salvo que se
 * cumpla una de estas tres condiciones — es lo que evita los falsos positivos:
 *
 *   1. El mensaje contiene un emoji de bandera.
 *   2. El mensaje es *únicamente* el nombre de un idioma ("english", "português").
 *   3. El mensaje combina un verbo de cambio con el nombre de un idioma
 *      ("quiero cambiar a inglés", "can you speak portuguese").
 *
 * Mencionar un idioma al pasar ("somos 4, dos hablan inglés", "vinieron unos
 * brasileños") NO dispara cambio: no hay bandera, el mensaje no es solo el
 * nombre del idioma, y aunque haya un verbo suelto se exige que el nombre del
 * idioma aparezca inmediatamente ligado a él.
 */
export function detectLanguageChangeRequest(text: string): LanguageChangeRequest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Bandera — la señal más inequívoca, gana sobre todo lo demás.
  const flagMatch = trimmed.match(FLAG_EMOJI_PATTERN);
  if (flagMatch) {
    for (const flag of flagMatch) {
      const language = FLAG_TO_LANGUAGE.get(flag);
      if (language) {
        return { language, source: 'flag' };
      }
    }
  }

  const normalized = normalizeForLanguageMatch(trimmed);

  // 2. El mensaje entero es el nombre de un idioma.
  const bare = normalized.replace(/[^\p{L}\s]/gu, '').trim();
  const bareLanguage = LANGUAGE_ALIASES.get(bare);
  if (bareLanguage) {
    return { language: bareLanguage, source: 'language_name' };
  }

  // 3. Verbo de cambio + nombre de idioma.
  if (CHANGE_VERB_PATTERN.test(normalized)) {
    const mentioned = findMentionedLanguage(normalized);
    if (mentioned) {
      return { language: mentioned, source: 'change_phrase' };
    }
  }

  return null;
}

/**
 * Máximo de palabras para considerar que un mensaje es un pedido directo de
 * cambio ("english please", "portugues por favor") y no una frase donde el
 * idioma se menciona al pasar.
 */
const SHORT_REQUEST_MAX_WORDS = 4;

/**
 * Busca un nombre de idioma en el texto. Exige preposición delante ("en inglés",
 * "to english") para no matchear "un grupo que habla inglés"; la excepción son
 * los mensajes muy cortos ("english please"), donde no hay lugar para que el
 * idioma sea un detalle incidental.
 */
function findMentionedLanguage(normalized: string): SupportedLanguage | null {
  const isShortRequest = normalized.split(/\s+/).filter(Boolean).length <= SHORT_REQUEST_MAX_WORDS;

  for (const [alias, language] of LANGUAGE_ALIASES) {
    // Los alias de 2 letras ("es", "en", "pt", "br") son demasiado ambiguos
    // dentro de una frase — solo valen como mensaje completo (caso 2).
    if (alias.length <= 2) continue;

    const withPreposition = new RegExp(
      `(?:${LANGUAGE_PREPOSITION_PATTERN.source}\\s+)${escapeRegExp(alias)}\\b`
    );
    if (withPreposition.test(normalized)) {
      return language;
    }

    if (isShortRequest && new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(normalized)) {
      return language;
    }
  }
  return null;
}

/**
 * Interpreta la respuesta al menú de bienvenida: un número (1, 2, 3), una
 * bandera o el nombre del idioma. Se usa solo mientras el draft tiene
 * `awaitingLanguageChoice`, así que acá sí es seguro aceptar un número pelado.
 */
export function parseLanguageMenuChoice(text: string): LanguageChangeRequest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Número de opción — acepta "2", "2️⃣", "opción 2", "option 2".
  const digits = trimmed.replace(/[️⃣]/g, '').match(/\b([1-9])\b/);
  if (digits) {
    const index = Number.parseInt(digits[1], 10) - 1;
    const language = LANGUAGE_MENU_ORDER[index];
    if (language) {
      return { language, source: 'menu_number' };
    }
  }

  // Bandera o nombre de idioma escrito.
  const explicit = detectLanguageChangeRequest(trimmed);
  if (explicit) return explicit;

  // Dentro del menú también vale un nombre de idioma suelto en medio de una
  // frase ("quiero español por favor"), sin exigir verbo de cambio.
  const normalized = normalizeForLanguageMatch(trimmed);
  for (const [alias, language] of LANGUAGE_ALIASES) {
    if (alias.length <= 2) continue;
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(normalized)) {
      return { language, source: 'language_name' };
    }
  }

  return null;
}

// ============================================================================
// Auto-detección del idioma del mensaje
// ============================================================================

/**
 * Saludos y frases cortas inequívocas. Los primeros mensajes suelen ser de 1-2
 * palabras, donde el scorer estadístico no tiene material suficiente.
 *
 * "hola" es español y "olá"/"oi" portugués: la tilde y la forma los separan.
 * Se omiten a propósito los ambiguos entre ES y PT ("boa"/"buena" no, pero
 * "gracias"/"obrigado" sí porque son claramente distintos).
 */
const GREETING_LANGUAGE: ReadonlyMap<string, SupportedLanguage> = new Map([
  ['hola', 'es'],
  ['holaa', 'es'],
  ['buenas', 'es'],
  ['buenos dias', 'es'],
  ['buenas tardes', 'es'],
  ['buenas noches', 'es'],
  ['que tal', 'es'],
  ['hi', 'en'],
  ['hello', 'en'],
  ['hey', 'en'],
  ['good morning', 'en'],
  ['good afternoon', 'en'],
  ['good evening', 'en'],
  ['oi', 'pt'],
  ['ola', 'pt'],
  ['opa', 'pt'],
  ['bom dia', 'pt'],
  ['boa tarde', 'pt'],
  ['boa noite', 'pt'],
]);

/**
 * Palabras marcadoras por idioma. Solo se listan términos que NO existen (o son
 * muy raros) en los otros dos idiomas soportados — de ahí que no aparezcan
 * cognados como "reserva", "mesa", "hotel", idénticos en ES y PT.
 */
const MARKERS: Record<SupportedLanguage, readonly string[]> = {
  es: [
    'quiero', 'quisiera', 'necesito', 'gracias', 'por favor', 'buenas', 'hola',
    'mañana', 'manana', 'hoy', 'personas', 'cuantas', 'cuantos', 'donde', 'cuando',
    'ustedes', 'tienen', 'puedo', 'podria', 'seria', 'somos', 'estamos', 'tambien',
    'jueves', 'viernes', 'sabado', 'domingo', 'miercoles', 'noche', 'tarde',
  ],
  en: [
    'want', 'would', 'need', 'thanks', 'thank you', 'please', 'hello', 'hi',
    'tomorrow', 'today', 'people', 'how many', 'where', 'when', 'you', 'have',
    'can', 'could', 'we are', 'table', 'booking', 'reservation', 'tonight',
    'thursday', 'friday', 'saturday', 'sunday', 'wednesday', 'evening', 'night',
  ],
  pt: [
    'quero', 'queria', 'gostaria', 'preciso', 'obrigado', 'obrigada', 'por favor',
    'ola', 'amanha', 'hoje', 'pessoas', 'quantas', 'quantos', 'onde', 'quando',
    'voces', 'voce', 'tem', 'posso', 'poderia', 'somos', 'estamos', 'tambem',
    'quinta', 'sexta', 'sabado', 'domingo', 'quarta', 'noite', 'jantar', 'nao',
  ],
};

export interface DetectionResult {
  language: SupportedLanguage;
  /** 0..1. Por debajo de DETECTION_THRESHOLD conviene no confiar y mostrar el menú. */
  confidence: number;
}

/** Debajo de esto no se pisa el idioma actual: se prefiere preguntar. */
export const DETECTION_THRESHOLD = 0.5;

/**
 * Detecta el idioma de un mensaje. Devuelve null cuando no hay señal suficiente
 * (mensajes cortos ambiguos como "ok", "2", "👍"), que es la mayoría de los
 * turnos dentro de un flujo ya empezado.
 */
export function detectLanguage(text: string): DetectionResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const normalized = normalizeForLanguageMatch(trimmed);

  // Saludo exacto — atajo de alta confianza para el primer mensaje.
  const asGreeting = normalized.replace(/[^\p{L}\s]/gu, '').trim().replace(/\s+/g, ' ');
  const greetingLanguage = GREETING_LANGUAGE.get(asGreeting);
  if (greetingLanguage) {
    return { language: greetingLanguage, confidence: 0.9 };
  }

  // Un mensaje que empieza con un saludo conocido ("bom dia, mesa pra 4").
  for (const [greeting, language] of GREETING_LANGUAGE) {
    if (asGreeting.startsWith(`${greeting} `)) {
      return { language, confidence: 0.85 };
    }
  }

  // Scorer por marcadores.
  const scores = scoreMarkers(normalized);
  const ranked = (Object.entries(scores) as [SupportedLanguage, number][]).sort(
    (a, b) => b[1] - a[1]
  );
  const [topLanguage, topScore] = ranked[0];
  const runnerUpScore = ranked[1]?.[1] ?? 0;

  if (topScore === 0) return null;

  // Confianza = cuánto se despega el ganador del segundo. Un empate entre ES y
  // PT (el par difícil) da confianza baja y deja que el menú decida.
  const confidence = (topScore - runnerUpScore) / topScore;
  if (confidence <= 0) return null;

  return { language: topLanguage, confidence: Math.min(confidence, 0.95) };
}

function scoreMarkers(normalized: string): Record<SupportedLanguage, number> {
  const scores: Record<SupportedLanguage, number> = { es: 0, en: 0, pt: 0 };

  for (const [language, markers] of Object.entries(MARKERS) as [
    SupportedLanguage,
    readonly string[],
  ][]) {
    for (const marker of markers) {
      const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(marker)}(?:$|\\s|[.,!?])`);
      if (pattern.test(normalized)) {
        scores[language] += 1;
      }
    }
  }

  return scores;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
