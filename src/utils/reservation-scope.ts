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
    if (looksLikePersonName(trimmedMessage) || reservationRelated || reservationOptIn) {
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
  return /^(hola|holis|hello|hi|hey|buenas|buenos dias|buenas tardes|buenas noches|buen dia|que tal)$/.test(normalizedMessage);
}

function isReservationOptInMessage(normalizedMessage: string): boolean {
  const optInPatterns = [
    /^si$/,
    /^yes$/,
    /^quiero$/,
    /^dale$/,
    /^(ok|okay|okey)$/,
    /^claro$/,
    /^perfecto$/,
    /^genial$/,
    /^listo$/,
    /^de\s+una$/,
    /^obvio$/,
  ];

  return optInPatterns.some((pattern) => pattern.test(normalizedMessage));
}

function containsPartySizeSignal(message: string, normalizedMessage: string): boolean {
  return /\d+/.test(message) || /\b(persona|personas|somos|para)\b/.test(normalizedMessage);
}

function isNameCorrectionLikeMessage(normalizedMessage: string): boolean {
  const correctionPhrases = [
    'me llamo', 'mi nombre es', 'soy ', 'llamame', 'puedes llamarme',
    'en realidad', 'perdon', 'error', 'me equivoque', 'cambiar nombre',
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
  ];

  return reservationPatterns.some((pattern) => pattern.test(normalizedMessage));
}

function isSpecificTimeReservationIntent(
  message: string,
  normalizedMessage: string,
  hasActiveDraft: boolean,
  reservationRelated: boolean
): boolean {
  const lowerMessage = message.toLowerCase();
  const hasClockPattern = /\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/.test(lowerMessage);
  const hasMeridiemPattern = /\b(?:1[0-2]|0?\d)\s?(?:am|pm|a\.m\.|p\.m\.)\b/.test(lowerMessage);
  const hasTimePhrasePattern = /\b(?:a\s+las|para\s+las|tipo\s+las|como\s+a\s+las|como\s+las|sobre\s+las)\s+\d{1,2}(?::\d{2})?\b/.test(normalizedMessage);
  const hasHourAbbreviation = /\b\d{1,2}\s?(?:hs|horas)\b/.test(normalizedMessage);
  const hasDateReference = /\b(?:manana|hoy|pasado\s+manana|esta\s+tarde|esta\s+noche|al\s+mediodia|otro\s+dia|otro\s+turno|mas\s+tarde)\b/.test(normalizedMessage);

  const hasSpecificTimeSignal =
    hasClockPattern ||
    hasMeridiemPattern ||
    hasTimePhrasePattern ||
    hasHourAbbreviation ||
    hasDateReference;

  if (!hasSpecificTimeSignal) {
    return false;
  }

  return hasActiveDraft || reservationRelated;
}