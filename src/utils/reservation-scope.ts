import { ReservationDraft } from '../types/index.js';
import { isMultilingualGreeting } from '../i18n/keywords.js';
import { catalog } from '../i18n/catalogs/index.js';
import { normalizeTemporalTokens } from '../i18n/date-normalization.js';

export type ReservationScopeDecision = 'allow' | 'off_topic' | 'out_of_window';

export interface ReservationScopeContext {
  businessName?: string;
  currentStep?: ReservationDraft['step'] | null;
  // true right after the bot asked "¿Cuál es tu nombre correcto?" at the
  // party_size step — a bare name-like reply must be allowed through even
  // without an explicit correction phrase like "me llamo X".
  awaitingNameCorrection?: boolean;
  /**
   * Titles of the events offered in the `schedule_choice` menu the customer is
   * looking at. A customer may answer with the title instead of the number
   * ("la noche de jazz"), and an arbitrary event name matches none of the
   * date/time patterns — without this it would be bounced as off-topic.
   */
  scheduleChoiceEventTitles?: string[];
}

export interface ReservationScopeEvaluation {
  decision: ReservationScopeDecision;
  message?: string;
  /**
   * Only set when decision === 'off_topic'. Distinguishes a hard security
   * block (prompt injection / meta-instruction attempts, which must NEVER
   * reach the LLM) from a message that simply didn't match any known
   * reservation pattern (general questions like "¿para qué servís?", typos,
   * unusual phrasing) — callers should let the LLM answer the latter
   * naturally instead of always sending the canned bounce message.
   */
  reason?: 'prompt_injection' | 'unrelated';
}

const DEFAULT_BUSINESS_NAME = 'el comercio';

// Los textos viven en el catálogo (src/i18n/catalogs) y salen en el idioma
// activo del turno. Si estos tres mensajes quedaran hardcodeados, un cliente
// rebotado por el guard recibiría español aunque el resto del bot le hable en
// su idioma — que es justo cuando peor cae.
export function buildReservationIntroMessage(businessName?: string): string {
  return catalog().reservationIntro(resolveBusinessName(businessName));
}

export function buildReservationOffTopicMessage(businessName?: string): string {
  return catalog().reservationOffTopic(resolveBusinessName(businessName));
}

export function buildReservationOutOfWindowMessage(businessName?: string): string {
  return catalog().reservationOutOfWindow(resolveBusinessName(businessName));
}

/**
 * Whether the message names one of the events currently on offer. Mirrors the
 * matching `WhatsAppHandler.matchScheduleChoiceEvent` does, so a title this
 * guard lets through is one the handler will actually resolve.
 *
 * Requires at least 3 characters to avoid a one-letter title swallowing every
 * message that happens to contain that letter.
 */
function matchesOfferedEventTitle(normalizedMessage: string, titles?: string[]): boolean {
  if (!titles || titles.length === 0 || normalizedMessage.length < 3) return false;

  return titles.some((title) => {
    const normalizedTitle = normalizeReservationScopeText(title);
    return (
      normalizedTitle.length >= 3 &&
      (normalizedTitle === normalizedMessage || normalizedMessage.includes(normalizedTitle))
    );
  });
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
      reason: 'prompt_injection',
    };
  }

  const currentStep = context.currentStep ?? null;
  const hasActiveDraft = currentStep !== null && currentStep !== 'completed';
  const reservationRelated = isReservationRelatedMessage(normalizedMessage);
  const reservationOptIn = isReservationOptInMessage(normalizedMessage);

  if (isOutOfWindowDateIntent(normalizedMessage, hasActiveDraft, reservationRelated)) {
    return {
      decision: 'out_of_window',
      message: buildReservationOutOfWindowMessage(context.businessName),
    };
  }

  if (currentStep === 'name' || currentStep === 'last_name' || currentStep === 'edit_customer_name') {
    // Also allow messages that start with an affirmative word — the user is likely
    // responding to the scope-guard's "¿Querés hacer una reserva?" with a verbose
    // confirmation like "Si quiero hacerla" or "Dale, vamos" which don't match
    // exact opt-in patterns but clearly mean "yes, continue". At `last_name` the
    // expected reply is the apellido, which `looksLikePersonName` accepts.
    if (looksLikePersonName(trimmedMessage) || reservationRelated || reservationOptIn || startsWithAffirmativeWord(normalizedMessage)) {
      return { decision: 'allow' };
    }

    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
      reason: 'unrelated',
    };
  }

  // A bare greeting or opt-in reply ("Hola", "Si", "Dale") never satisfies any
  // of the step-specific allow-lists below (it's not a name, party size, menu
  // number, or date/time signal). Without this escape hatch, one accidental
  // off-topic classification permanently traps the customer: the draft step
  // never advances, so every following message — including a plain "Hola" —
  // gets bounced by the same restrictive branch, forever. Letting it through
  // here defers to the step handler, which re-asks its own question instead
  // of repeating the generic scope-guard message on every reply.
  const isGreetingOrOptIn = isGreetingMessage(normalizedMessage) || reservationOptIn;

  if (currentStep === 'party_size') {
    // We just asked "¿Cuál es tu nombre correcto?" — any reply is expected to
    // be that name, so (like confirm_slot's yes/no) always let it through and
    // let the step handler validate/retry instead of bouncing it as off-topic.
    if (context.awaitingNameCorrection) {
      return { decision: 'allow' };
    }

    if (
      containsPartySizeSignal(trimmedMessage, normalizedMessage) ||
      isNameCorrectionLikeMessage(normalizedMessage) ||
      reservationRelated ||
      isGreetingOrOptIn
    ) {
      return { decision: 'allow' };
    }

    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
      reason: 'unrelated',
    };
  }

  if (currentStep === 'edit_menu' || currentStep === 'summary_edit_menu') {
    if (/^[1234]$/.test(trimmedMessage) || reservationRelated || isGreetingOrOptIn) {
      return { decision: 'allow' };
    }

    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
      reason: 'unrelated',
    };
  }

  // M1 summary confirmation and M3 cancel menus accept short numeric / yes-no
  // answers whose words ("cancelar", "modificar", "reprogramar") would otherwise
  // trip the off-topic guard — always let their own step handlers resolve them.
  if (
    currentStep === 'confirm_summary' ||
    currentStep === 'cancel_menu' ||
    currentStep === 'cancel_confirm'
  ) {
    return { decision: 'allow' };
  }

  if (currentStep === 'schedule_choice' || currentStep === 'reservation_selection') {
    if (
      /^[0-9]+$/.test(trimmedMessage) ||
      isInstantChoiceMessage(normalizedMessage) ||
      hasDateOrTimeSignal(trimmedMessage, normalizedMessage) ||
      isAskingOtherDaysScheduleMessage(normalizedMessage) ||
      matchesOfferedEventTitle(normalizedMessage, context.scheduleChoiceEventTitles) ||
      reservationRelated ||
      isGreetingOrOptIn
    ) {
      return { decision: 'allow' };
    }

    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
      reason: 'unrelated',
    };
  }

  if (currentStep === 'date' || currentStep === 'time') {
    if (
      hasDateOrTimeSignal(trimmedMessage, normalizedMessage) ||
      isAskingOtherDaysScheduleMessage(normalizedMessage) ||
      reservationRelated ||
      isGreetingOrOptIn
    ) {
      return { decision: 'allow' };
    }

    return {
      decision: 'off_topic',
      message: buildReservationOffTopicMessage(context.businessName),
      reason: 'unrelated',
    };
  }

  if (currentStep === 'confirm_slot') {
    // Only "yes" or "no" style answers are valid here
    return { decision: 'allow' };
  }

  if (isGreetingMessage(normalizedMessage) || reservationRelated || reservationOptIn) {
    return { decision: 'allow' };
  }

  return {
    decision: 'off_topic',
    message: buildReservationOffTopicMessage(context.businessName),
    reason: 'unrelated',
  };
}

/**
 * Synchronous zero-latency check for obviously invalid name inputs.
 * Catches keyboard walks (qwerty/asdf/zxcv), character spam (aaaa), no-vowel strings,
 * and runs of 5+ consecutive consonants. Returns true when the string is clearly NOT a name.
 *
 * This is only a cheap pre-filter for the blatantly-garbage case so we don't
 * spend an LLM call on it. Offensive/insulting names (which used to be caught by
 * a hand-maintained profanity list here, with false positives like "Gordo" or
 * "Rata") are now flagged by the `nameLooksInvalid` field of the extraction tool
 * in reservation-nlu.service.ts.
 */
export function isObviouslyGibberish(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 50) return true;

  const lower = trimmed.toLowerCase();

  // Must contain at least one vowel
  if (!/[aeiouáéíóúü]/i.test(lower)) return true;

  // Three or more consecutive identical characters (aaaa, bbbbb, 1111)
  if (/(.)\1{2,}/.test(lower)) return true;

  // Keyboard walk patterns (rows of QWERTY layout)
  const walks = [
    'qwert', 'werty', 'ertyu', 'rtyui', 'tyuio', 'yuiop',
    'asdfg', 'sdfgh', 'dfghj', 'fghjk', 'ghjkl',
    'zxcvb', 'xcvbn', 'cvbnm',
    'qazxs', 'wsxed', 'edcrf', 'rfvtg', 'tgbyh',
  ];
  if (walks.some(w => lower.includes(w))) return true;

  // Five or more consecutive consonants after removing spaces/punctuation
  const lettersOnly = lower.replace(/[^a-záéíóúüñ]/g, '');
  if (/[^aeiouáéíóúü]{5,}/.test(lettersOnly)) return true;

  return false;
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

/**
 * Bare digits/punctuation with no letters at all (e.g. "1", "22", "..") carry
 * no interpretable intent on their own — most often stray taps or a reaction
 * to something outside the chat. When this falls through to 'off_topic', it
 * should get the canned bounce message rather than being routed to the LLM:
 * with no active draft to ground it, the LLM has nothing real to respond to
 * and tends to hallucinate a plausible-sounding but fake reservation flow.
 */
export function isPureNoiseMessage(trimmedMessage: string): boolean {
  return trimmedMessage.length > 0 && !/\p{L}/u.test(trimmedMessage);
}

function resolveBusinessName(businessName?: string): string {
  const trimmedBusinessName = businessName?.trim();
  return trimmedBusinessName && trimmedBusinessName.length > 0
    ? trimmedBusinessName
    : DEFAULT_BUSINESS_NAME;
}

export function normalizeReservationScopeText(text: string): string {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Traduce referencias temporales de ingles/portugues al canonico espanol
  // ("tomorrow"/"amanha" -> "manana") ANTES de que las vean los parsers.
  // parseRelativeDay, parseTimeOfDay y hasDateOrTimeSignal pasan todos por
  // aca, asi que heredan el soporte multilingue sin modificarse. Es idempotente
  // sobre texto en espanol. Ver src/i18n/date-normalization.ts.
  return normalizeTemporalTokens(normalized);
}

// Multilingual by union (ES/EN/PT), including Argentine informal variants
// (holaa, ola typo, ey, yoo) and Brazilian ones (oi, opa, eai) — see
// src/i18n/keywords.ts. A tourist greets in their own language before ever
// choosing one, so the scope guard must not bounce "hi" or "oi" as off-topic.

function isGreetingMessage(normalizedMessage: string): boolean {
  return isMultilingualGreeting(normalizedMessage);
}

function isReservationOptInMessage(normalizedMessage: string): boolean {
  // Suffix allowed after any base opt-in word (e.g. "si por favor", "va entonces", "dale total")
  const politeSuffix = '(\\s+(por\\s+favor|gracias|bueno|claro|dale|de\\s+una|obvio|porfavor|entonces|total))?';

  const optInPatterns = [
    // Single-word affirmatives + optional polite suffix
    new RegExp(`^si${politeSuffix}$`),
    new RegExp(`^yes${politeSuffix}$`),
    new RegExp(`^quiero${politeSuffix}$`),
    // Bare keyword the bot itself tells customers to send to start a new
    // reservation (see message-templates.ts's "escribí: RESERVAR"). Without
    // this, "reservar" alone fell through every fast path into the AI agent.
    new RegExp(`^reservar${politeSuffix}$`),
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

    // --- Inglés ---
    // `\breserv` arriba ya cubre "reservation"/"reserve"; `\bcancel` cubre "cancel".
    /\bbook(?:ing|ed)?\b/,
    /\btables?\b/,
    /\bseats?\b/,
    /\bparty\s+of\b/,
    /\bpeople\b/,
    /\bwaiting\s+list\b/,
    /\bwait(?:ing)?\s+time\b/,
    /\bavailab/,            // available, availability
    /\bhow\s+long\b/,
    /\bwe\s+are\s+\d+\b/,
    /\bfor\s+\d+\b/,

    // --- Portugués ---
    // `\breserv` cubre "reserva"/"reservar"; `\bmesa` y `\bcancel` son idénticos al español.
    /\bpessoas?\b/,
    /\blugares?\b/,
    /\bfila\s+de\s+espera\b/,
    /\btempo\s+de\s+espera\b/,
    /\bdisponib/,           // disponibilidade, disponível
    /\bsomos\s+\d+\b/,      // igual que en español
    /\bmarcar\b/,           // "marcar uma mesa"
    /\bagendar\b/,          // ya cubierto por \bagend, se deja explícito por claridad
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
    // "ignora las/tus instrucciones / el flujo / el orden"
    // El determinante `tus` se contempla igual que en el patrón de "olvidá",
    // que ya lo tenía: "ignorá TUS instrucciones" es la forma más frecuente del
    // intento y se colaba por no estar en la alternancia.
    /\bignorar?\s+(las?\s+|tus?\s+|el\s+)?(instrucciones?|flujo|orden|pasos?|reglas?|protocolo|proceso)\b/,
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

/**
 * Detects mentions of a clock time, a relative/weekday date reference, or both.
 * Used to ALLOW messages at the `schedule_choice`/`date`/`time` draft steps (the
 * customer is expected to answer with exactly this kind of content there), and as
 * part of the (narrower) out-of-window check below.
 */
export function hasDateOrTimeSignal(message: string, normalizedMessage: string): boolean {
  const lowerMessage = message.toLowerCase();
  const hasClockPattern = /\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/.test(lowerMessage);
  const hasMeridiemPattern = /\b(?:1[0-2]|0?\d)\s?(?:am|pm|a\.m\.|p\.m\.)\b/.test(lowerMessage);
  const hasTimePhrasePattern = /\b(?:a\s+las|para\s+las|tipo\s+las|como\s+a\s+las|como\s+las|sobre\s+las|a\s+eso\s+de\s+las|eso\s+de\s+las)\s+\d{1,2}(?::\d{2})?\b/.test(normalizedMessage);
  const hasHourAbbreviation = /\b\d{1,2}\s?(?:hs|horas)\b/.test(normalizedMessage);
  // Day names and near-term relative dates. Matches regardless of a trailing
  // "que viene"/"próximo" qualifier, since the weekday word alone matches.
  const hasDateReference = /\b(?:manana|hoy|pasado\s+manana|esta\s+tarde|esta\s+noche|al\s+mediodia|otro\s+dia|otro\s+turno|mas\s+tarde|a\s+la\s+noche|a\s+la\s+tarde|a\s+la\s+manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|finde|fin\s+de\s+semana)\b/.test(normalizedMessage);
  // "9 y media", "3 y cuarto" — common Argentine half/quarter-hour expressions
  const hasHalfHour = /\b\d{1,2}\s*y\s*(media|cuarto|menos\s+(cuarto|quince))\b/.test(normalizedMessage);
  // A bare 1-2 digit number alone (e.g. answering "21" or "9" to "¿A qué hora?").
  // Uses the normalized text so trailing punctuation ("14?", "14.") still counts.
  const hasBareNumber = /^\d{1,2}$/.test(normalizedMessage);
  // "23 30" — hour and minute separated by a space instead of a colon/dot.
  // Anchored so it only fires when the entire message is just two numbers
  // (e.g. a customer answering "¿A qué hora?" with "23 30" or "9 30").
  const hasSpacedTime = /^(\d{1,2})\s([0-5]\d)$/.test(normalizedMessage);
  // A slash-separated date (e.g. "09/07"). Neither parseRelativeDay nor
  // parseTimeOfDay understand this format, so it won't resolve into an actual
  // date/time — but it's clearly the customer naming a day, not off-topic
  // chatter. Treating it as on-topic here routes it to the step handler,
  // which replies with a targeted "no entendí, decime de nuevo" instead of
  // the generic scope-guard message. Regression: a customer echoed the
  // already-confirmed date ("09/07") when asked for the time, got bounced as
  // off-topic, and — because that reply never advanced draft.step — every
  // later message (including plain "Hola"/"Si") kept hitting the same wall.
  const hasSlashDate = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(message);

  return (
    hasClockPattern ||
    hasMeridiemPattern ||
    hasTimePhrasePattern ||
    hasHourAbbreviation ||
    hasDateReference ||
    hasHalfHour ||
    hasBareNumber ||
    hasSpacedTime ||
    hasSlashDate
  );
}

/**
 * Detects a customer asking about the schedule of OTHER days instead of
 * answering the pending day/time question — e.g. after being told Saturday's
 * hours, "¿y los horarios de los otros días?" or "¿qué días abren?". Used to
 * let this kind of question through as `allow` at the `schedule_choice`/
 * `date`/`time` steps (see whatsapp-handler.service.ts) instead of bouncing
 * it to the LLM fallback, which has no access to `weekly_hours` and ends up
 * falsely claiming it doesn't have the information.
 */
export function isAskingOtherDaysScheduleMessage(normalizedMessage: string): boolean {
  const patterns = [
    /\bhorarios?\b.*\b(otro|otros|dem[a]s|todos)\s+(los\s+)?dias?\b/,
    /\b(otro|otros|dem[a]s)\s+dias?\b.*\bhorarios?\b/,
    /\bhorarios?\s+de\s+(la\s+semana|todos\s+los\s+dias)\b/,
    /\bque\s+dias?\s+(abren|atienden|trabajan|estan\s+abiertos?)\b/,
    /\bcuales?\s+son\s+(sus|los)\s+horarios\b/,
    /\botro\s+dia\b.*\bhorario\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalizedMessage));
}

/**
 * Matches answers that mean "ahora" / "turno actual" at the `schedule_choice` step,
 * as opposed to naming a future day.
 */
export function isInstantChoiceMessage(normalizedMessage: string): boolean {
  return /\b(ahora|hoy\s+mismo|turno\s+actual|ya\s+mismo)\b/.test(normalizedMessage);
}

/**
 * Day-count threshold above which a date reference is clearly outside the
 * booking window. Mirrors `BOOKING_WINDOW_DAYS` in `reservation-datetime.ts`
 * (not imported directly — that module already imports FROM this one, so
 * importing back would create a cycle; keep the two in sync by hand).
 */
const OUT_OF_WINDOW_DAY_THRESHOLD = 30;

/**
 * Detects references to dates clearly OUTSIDE the booking window
 * (`OUT_OF_WINDOW_DAY_THRESHOLD` days), e.g. "el mes que viene", "en 40 días".
 * Near-term references (mañana, el viernes, la semana que viene, en 10 días,
 * etc.) are NOT flagged here — those are valid and handled by the
 * `schedule_choice`/`date`/`time` step branches instead (including, for a
 * named weekday, "que viene"/"próximo" qualifiers resolved directly by
 * `parseRelativeDay`).
 */
function isOutOfWindowDateIntent(
  normalizedMessage: string,
  hasActiveDraft: boolean,
  reservationRelated: boolean
): boolean {
  // No precise day count available for these — "next month"/"next year" is,
  // in practice, essentially always beyond the window regardless of when in
  // the current month it's said.
  const alwaysOutOfWindowPatterns = [
    /\bel\s+mes\s+que\s+viene\b/,
    /\bmes\s+que\s+viene\b/,
    /\bproximo\s+mes\b/,
    /\bel\s+ano\s+que\s+viene\b/,
  ];

  const hasAlwaysOutOfWindowSignal = alwaysOutOfWindowPatterns.some((pattern) =>
    pattern.test(normalizedMessage)
  );

  // "en N semanas" / "dentro de N semanas" and "en N días" / "dentro de N
  // días" DO give a precise count — only flag them once that count reaches
  // or exceeds the actual window, instead of hard-blocking every mention of
  // a week/day count the way the old 7-day window had to.
  const weeksMatch = normalizedMessage.match(/\b(?:en|dentro\s+de)\s+(\d+)\s+semanas?\b/);
  const daysMatch = normalizedMessage.match(/\b(?:en|dentro\s+de)\s+(\d+)\s+dias?\b/);
  const requestedDayCount = weeksMatch
    ? parseInt(weeksMatch[1], 10) * 7
    : daysMatch
      ? parseInt(daysMatch[1], 10)
      : null;
  const hasFarFutureDayCount = requestedDayCount !== null && requestedDayCount >= OUT_OF_WINDOW_DAY_THRESHOLD;

  if (!hasAlwaysOutOfWindowSignal && !hasFarFutureDayCount) {
    return false;
  }

  return hasActiveDraft || reservationRelated;
}