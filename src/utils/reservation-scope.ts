import { ReservationDraft } from '../types';

export type ReservationScopeDecision = 'allow' | 'off_topic' | 'specific_time';

export interface ReservationScopeContext {
  businessName?: string;
  currentStep?: ReservationDraft['step'] | null;
}

export interface ReservationScopeEvaluation {
  decision: ReservationScopeDecision;
  message?: string;
}

const DEFAULT_BUSINESS_NAME = 'el comercio';

export function buildReservationIntroMessage(businessName?: string): string {
  const resolvedBusinessName = resolveBusinessName(businessName);
  return `¡Hola! 👋 Soy el asistente de ${resolvedBusinessName} y estoy para generar reservas. ¿Cuál es tu nombre?`;
}

export function buildReservationOffTopicMessage(businessName?: string): string {
  const resolvedBusinessName = resolveBusinessName(businessName);
  return `Hola 😊 Solo puedo ayudarte con consultas relacionadas a reservas para “${resolvedBusinessName}” en el turno actual. ¿Querés hacer una reserva?`;
}

export function buildReservationSpecificTimeMessage(businessName?: string): string {
  const resolvedBusinessName = resolveBusinessName(businessName);
  return `Hola 😊 Por ahora solo puedo ayudarte con reservas instantáneas para el turno actual en “${resolvedBusinessName}”. Todavía no puedo tomar reservas para una hora específica. ¿Querés hacer una reserva?`;
}

export function evaluateReservationScope(
  message: string,
  context: ReservationScopeContext = {}
): ReservationScopeEvaluation {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return { decision: 'allow' };
  }

  const normalizedMessage = normalizeReservationScopeText(trimmedMessage);

  // Block prompt injection / meta-instruction attempts before any other check.
  // This prevents messages like "no hace falta seguir el flujo de reservas" from
  // being classified as reservation-related due to keyword matching.
  if (isPromptInjectionAttempt(normalizedMessage)) {
    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
    };
  }

  const currentStep = context.currentStep ?? null;
  const hasActiveDraft = currentStep !== null && currentStep !== 'completed';
  const reservationRelated = isReservationRelatedMessage(normalizedMessage);
  const reservationOptIn = isReservationOptInMessage(normalizedMessage);

  if (isSpecificTimeReservationIntent(trimmedMessage, normalizedMessage, hasActiveDraft, reservationRelated)) {
    return {
      decision: 'specific_time',
      message: buildReservationSpecificTimeMessage(context.businessName),
    };
  }

  if (currentStep === 'name') {
    // Also allow messages that start with an affirmative word — the user is likely
    // responding to the scope-guard's "¿Querés hacer una reserva?" with a verbose
    // confirmation like "Si quiero hacerla" or "Dale, vamos" which don't match
    // exact opt-in patterns but clearly mean "yes, continue".
    if (looksLikePersonName(trimmedMessage) || reservationRelated || reservationOptIn || startsWithAffirmativeWord(normalizedMessage)) {
      return { decision: 'allow' };
    }

    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
    };
  }

  if (currentStep === 'party_size') {
    if (containsPartySizeSignal(trimmedMessage, normalizedMessage) || isNameCorrectionLikeMessage(normalizedMessage) || reservationRelated) {
      return { decision: 'allow' };
    }

    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
    };
  }

  if (currentStep === 'edit_menu') {
    if (/^[12]$/.test(trimmedMessage) || reservationRelated) {
      return { decision: 'allow' };
    }

    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
    };
  }

  if (isGreetingMessage(normalizedMessage) || reservationRelated || reservationOptIn) {
    return { decision: 'allow' };
  }

  return {
    decision: 'off_topic',
    message: buildReservationOffTopicMessage(context.businessName),
  };
}

export function looksLikePersonName(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);

  if (trimmed.length < 2 || trimmed.length > 60) {
    return false;
  }

  if (words.length > 4 || /\d/.test(trimmed) || trimmed.endsWith('?')) {
    return false;
  }

  const normalized = normalizeReservationScopeText(text);
  const socialPhrases = [
    'todo bien', 'como estas', 'como te va', 'que tal', 'como andas',
    'como va', 'bien gracias', 'muy bien', 'todo ok', 'todo good',
    'nada nada', 'nada mucho', 'que onda', 'buenas noches', 'buenas tardes',
    'buenos dias', 'buen dia',
    // Argentine variants
    'todo piola', 'todo joya', 'todo copado', 're bien', 'ni idea',
    'sin drama', 'para nada', 'que paso', 'que tal todo',
  ];

  if (socialPhrases.some((phrase) => normalized.includes(phrase))) {
    return false;
  }

  if (isReservationOptInMessage(normalized)) {
    return false;
  }

  const sentenceMarkers = [
    'puedo', 'puede', 'podes', 'quiero', 'quiere', 'queres',
    'tengo', 'tiene', 'tenes', 'voy', 'vamos',
    'estoy', 'estas', 'estamos', 'hago', 'hace', 'haces',
    'vivo', 'vive', 'tirar', 'hacer', 'poder', 'tener',
    'decir', 'saber', 'reserv', 'mesa', 'persona', 'personas',
    'cancel', 'estado', 'posicion', 'hora', 'horario', 'direccion',
    'telefono', 'contacto', 'clima', 'chiste', 'politica',
    // Argentine sentence markers / fillers that shouldn't be treated as names
    'che', 'tipo', 'igual', 'aparte', 'posta', 'bah',
  ];

  return !sentenceMarkers.some((marker) => normalized.includes(marker));
}

export function isGreetingOrReservationOptInMessage(text: string): boolean {
  const normalizedMessage = normalizeReservationScopeText(text);
  return isGreetingMessage(normalizedMessage) || isReservationOptInMessage(normalizedMessage);
}

function resolveBusinessName(businessName?: string): string {
  const trimmedBusinessName = businessName?.trim();
  return trimmedBusinessName && trimmedBusinessName.length > 0
    ? trimmedBusinessName
    : DEFAULT_BUSINESS_NAME;
}

function normalizeReservationScopeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreetingMessage(normalizedMessage: string): boolean {
  // Covers Argentine informal variants (holaa, ola typo, ey, yoo), standard Spanish and English.
  return /^(hola{1,6}|holis|holiwis|ola|hello|hi|hey|ey+|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|buen\s+dia|que\s+tal|saludos|yoo+)$/.test(normalizedMessage);
}

function isReservationOptInMessage(normalizedMessage: string): boolean {
  // Suffix allowed after any base opt-in word (e.g. "si por favor", "va entonces", "dale total")
  const politeSuffix = '(\\s+(por\\s+favor|gracias|bueno|claro|dale|de\\s+una|obvio|porfavor|entonces|total))?';

  const optInPatterns = [
    // Single-word affirmatives + optional polite suffix
    new RegExp(`^si${politeSuffix}$`),
    new RegExp(`^yes${politeSuffix}$`),
    new RegExp(`^quiero${politeSuffix}$`),
    new RegExp(`^dale${politeSuffix}$`),
    new RegExp(`^(ok|okay|okey|oka)${politeSuffix}$`),
    new RegExp(`^claro${politeSuffix}$`),
    new RegExp(`^perfecto${politeSuffix}$`),
    new RegExp(`^genial${politeSuffix}$`),
    new RegExp(`^listo${politeSuffix}$`),
    new RegExp(`^de\\s+una${politeSuffix}$`),
    new RegExp(`^obvio${politeSuffix}$`),
    // Argentine colloquialisms
    new RegExp(`^va${politeSuffix}$`),          // "va" = "ok/sure" (muy común en Arg)
    new RegExp(`^vamos${politeSuffix}$`),        // "vamos" = "let's go"
    new RegExp(`^joya${politeSuffix}$`),         // "joya" = "genial" en Arg
    new RegExp(`^piola${politeSuffix}$`),        // "piola" = "ok/cool" en Arg
    new RegExp(`^ta${politeSuffix}$`),           // "tá" = "ok" (contracción de "está bien")
    new RegExp(`^totalmente${politeSuffix}$`),
    new RegExp(`^barbaro${politeSuffix}$`),      // "bárbaro" = "great" en Arg
    new RegExp(`^barbara${politeSuffix}$`),
    new RegExp(`^copado${politeSuffix}$`),       // "copado" = "cool" en Arg
    new RegExp(`^copada${politeSuffix}$`),
    new RegExp(`^buenisimo${politeSuffix}$`),
    new RegExp(`^buenisima${politeSuffix}$`),
    // Multi-word affirmatives
    /^claro\s+que\s+si$/,
    /^por\s+supuesto$/,
    /^con\s+gusto$/,
    /^me\s+gustaria$/,
    /^quiero\s+reservar$/,
    /^si\s+quiero$/,
    /^bueno\s+si$/,
    /^esta\s+bien$/,
    /^si\s+si$/,                                // "sí sí"
    /^sisi$/,
    /^de\s+diez$/,                              // "de diez" = "perfecto" en Arg
    /^re\s+(bien|copado|copada|piola|joya)$/,   // "re bien" etc.
    /^obvio\s+que\s+si$/,
    /^dale\s+(que\s+si|vamos|todo)$/,
    /^va\s+(dale|entonces)$/,
  ];

  return optInPatterns.some((pattern) => pattern.test(normalizedMessage));
}

function containsPartySizeSignal(message: string, normalizedMessage: string): boolean {
  // Digits are the primary signal; also match Argentine party-size expressions
  return (
    /\d+/.test(message) ||
    /\b(persona|personas|somos|para|venimos|eramos|seriamos|seremos|grupo|grupito)\b/.test(normalizedMessage)
  );
}

function isNameCorrectionLikeMessage(normalizedMessage: string): boolean {
  const correctionPhrases = [
    'me llamo', 'mi nombre es', 'soy ', 'llamame', 'puedes llamarme',
    'en realidad', 'perdon', 'error', 'me equivoque', 'cambiar nombre',
    // Argentine variants
    'me dicen',      // "me dicen X" = they call me X
    'me llaman',     // "me llaman X" = they call me X
    'ponele',        // "ponele" = "put it as" in Arg slang
    'poneme como',   // "poneme como X" = put me down as X
    'anotame como',  // "anotame como X" = register me as X
    'es mi nombre',  // confirmation
    'mi nombre real',
  ];

  return correctionPhrases.some((phrase) => normalizedMessage.includes(phrase));
}

function isReservationRelatedMessage(normalizedMessage: string): boolean {
  const reservationPatterns = [
    /\breserv/,
    /\bmesa\b/,
    /\bturno\b/,
    /\bagend/,
    /\bapart/,
    /\blista\s+de\s+espera\b/,
    /\bcupo\b/,
    /\bcancel/,
    /\banul/,
    /\bno\s+voy\b/,
    /\bcambi/,
    /\bmodific/,
    /\bactualiz/,
    /\bmis\s+reserv/,
    /\bmis\s+turnos?\b/,
    /\bestado\b/,
    /\bposicion\b/,
    /\bcuanto\s+falta\b/,
    /\btiempo\s+de\s+espera\b/,
    /\bhay\s+espera\b/,
    /\bcodigo\b/,
    /\bpersonas?\b/,
    /\bsomos\s+\d+\b/,
    /\bpara\s+\d+\b/,
    // Argentine registration verbs: "anotame", "apuntame", "hacerla" (la reserva), etc.
    /\banota[rm]/,          // anotar, anotame, anotarme
    /\bapunta[rm]/,         // apuntar, apuntame, apuntarme
    /\binscrib/,            // inscribirme, inscribirse
    /\bhacer(?:la|lo)\b/,  // "quiero hacerla" = hacer la reserva
    /\banotarm?e\b/,        // variante explícita de anotame
  ];

  return reservationPatterns.some((pattern) => pattern.test(normalizedMessage));
}

/**
 * Checks if a message starts with a common affirmative word, indicating the user
 * wants to continue with the reservation flow after a scope-guard block.
 * Only used for currentStep === 'name' to break infinite-loop patterns.
 */
function startsWithAffirmativeWord(normalizedMessage: string): boolean {
  // Prefix-match for verbose confirmations after a scope-guard block.
  // Includes Argentine colloquialisms (va, joya, piola, bárbaro, etc.).
  return /^(si|dale|ok|okay|okey|oka|claro|quiero|perfecto|listo|genial|bueno|va|vamos|joya|piola|ta|totalmente|barbaro|barbara|copado|copada|buenisimo|buenisima|obvio|sisi)\b/.test(normalizedMessage);
}

/**
 * Detects prompt injection / meta-instruction attempts where the user tries to
 * modify the bot's behavior, flow, role, or ignore its instructions.
 * Must be checked before keyword-based reservation classification to prevent
 * false 'allow' decisions caused by reservation words inside injections
 * (e.g. "no hace falta seguir el flujo de **reservas**").
 */
function isPromptInjectionAttempt(normalizedMessage: string): boolean {
  const patterns = [
    // "no hace falta / no necesitas / no debes + seguir / respetar / cumplir"
    /\bno\s+hace?\s+falta\s+(seguir|respetar|cumplir|usar|aplicar)\b/,
    /\bno\s+(tenes?|tienes?|necesitas?|debes?|tenes?\s+que|tienes?\s+que)\s+(seguir|respetar|cumplir)\b/,
    // "podes / puedes + ignorar / saltar / omitir"
    /\b(puedes?|podes?)\s+(saltarte?|ignorar?|omitir|saltar|evitar)\b/,
    // "ignora las instrucciones / el flujo / el orden"
    /\bignorar?\s+(las?\s+)?(instrucciones?|flujo|orden|pasos?|reglas?|protocolo|proceso)\b/,
    // "olvida tus instrucciones / todo lo anterior"
    /\bolvidat?e?\s+(tus?\s+)?(instrucciones?|flujo|protocolo|sistema|reglas?)\b/,
    /\bolvidat?e?\s+de\s+todo\b/,
    // "actua como / ahora sos / soy un nuevo"
    /\b(actua\s+como|ahora\s+sos|ahora\s+eres|sos\s+un\s+nuevo|eres\s+un\s+nuevo)\b/,
    /\bpretende\s+ser\b/,
    /\bfingi[r]?\s+ser\b/,
    // "cambia / modifica tu rol / comportamiento / flujo"
    /\b(cambia|modifica|adapta)\s+(tu\s+)?(rol|modo|comportamiento|personalidad|flujo|instrucciones?|sistema)\b/,
    // "salta el flujo / los pasos / el orden"
    /\bsaltea?[rt]?\s+(el\s+)?(flujo|orden|pasos?|proceso)\b/,
    /\bno\s+sigas?\s+(el\s+)?(flujo|orden|pasos?|proceso|instrucciones?)\b/,
    // Generic "el flujo no es necesario / el orden no importa"
    /\b(flujo|orden)\s+(no\s+)?(es\s+)?(necesario|obligatorio|estricto|importante)\b/,
    /\bno\s+(es\s+)?(necesario|obligatorio)\s+(seguir|respetar)\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalizedMessage));
}

function isSpecificTimeReservationIntent(
  message: string,
  normalizedMessage: string,
  hasActiveDraft: boolean,
  reservationRelated: boolean
): boolean {
  const lowerMessage = message.toLowerCase();
  const hasClockPattern = /\b(?:[01]?\d|2[0-3])[:\.]\d{2}\b/.test(lowerMessage);
  const hasMeridiemPattern = /\b(?:1[0-2]|0?\d)\s?(?:am|pm|a\.m\.|p\.m\.)\b/.test(lowerMessage);
  const hasTimePhrasePattern = /\b(?:a\s+las|para\s+las|tipo\s+las|como\s+a\s+las|como\s+las|sobre\s+las|a\s+eso\s+de\s+las|eso\s+de\s+las)\s+\d{1,2}(?::\d{2})?\b/.test(normalizedMessage);
  const hasHourAbbreviation = /\b\d{1,2}\s?(?:hs|horas)\b/.test(normalizedMessage);
  // Day names, relative dates, Argentine expressions (finde, a la noche, proximo, etc.)
  const hasDateReference = /\b(?:manana|hoy|pasado\s+manana|esta\s+tarde|esta\s+noche|al\s+mediodia|otro\s+dia|otro\s+turno|mas\s+tarde|a\s+la\s+noche|a\s+la\s+tarde|a\s+la\s+manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|finde|fin\s+de\s+semana|semana\s+que\s+viene|proximo|proxima|siguiente)\b/.test(normalizedMessage);
  // "9 y media", "3 y cuarto" — common Argentine half/quarter-hour expressions
  const hasHalfHour = /\b\d{1,2}\s*y\s*(media|cuarto|menos\s+(cuarto|quince))\b/.test(normalizedMessage);

  const hasSpecificTimeSignal =
    hasClockPattern ||
    hasMeridiemPattern ||
    hasTimePhrasePattern ||
    hasHourAbbreviation ||
    hasDateReference ||
    hasHalfHour;

  if (!hasSpecificTimeSignal) {
    return false;
  }

  return hasActiveDraft || reservationRelated;
}