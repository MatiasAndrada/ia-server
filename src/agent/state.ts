import { RedisConfig } from '../config/redis.js';
import { SupabaseService } from '../services/supabase.service.js';
import { LlmMessage, WaitlistEntry } from '../types/index.js';
import { coerceLanguage, SupportedLanguage } from '../i18n/index.js';
import { describeScheduledAtUtc, nowInBuenosAires } from '../utils/reservation-datetime.js';
import * as templates from '../utils/message-templates.js';
import { logger } from '../utils/logger.js';

/**
 * Estado conversacional del agente.
 *
 * Reemplaza por completo a `ReservationDraft`: no hay `step`, ni campos
 * `pending*` / `awaiting*`. Lo único que se persiste es el historial (con sus
 * tool calls) — el "dónde estamos" queda implícito en esa conversación, que es
 * exactamente lo que un modelo sabe leer sin que nadie se lo codifique.
 */

const HISTORY_KEY_PREFIX = 'agent_v2:';
const SHADOW_KEY_PREFIX = 'agent_v2_shadow:';
const HISTORY_TTL_SECONDS = 3600;

/**
 * Cuántos mensajes del historial se recuerdan.
 *
 * Se cuenta en mensajes crudos, no en turnos, porque un turno con herramientas
 * puede ocupar 5+ entradas (assistant con tool_calls + un `tool` por llamada).
 * 40 sostiene con holgura una conversación de reserva completa; el modelo tiene
 * 1M de contexto, así que el límite es por costo y latencia, no por capacidad.
 */
const MAX_HISTORY_MESSAGES = 40;

/**
 * Quién es el cliente que escribe, EN ESTE COMERCIO.
 *
 * `customers` está keyed por `(business_id, phone)`, así que el mismo teléfono
 * es un cliente distinto en cada local: alguien puede ser "Matías" y hablar
 * español en un restaurante, y no existir en otro.
 *
 * Se resuelve antes del primer token y viaja en el system prompt, no como tool
 * call, por dos razones: el saludo por nombre tiene que salir en la primera
 * respuesta (una tool call costaría una iteración entera del loop antes de
 * poder decir "hola"), y el idioma tiene que estar fijado antes de generar
 * cualquier texto.
 */
export interface CustomerProfile {
  /** false = no hay ficha para este teléfono en este comercio: es un cliente nuevo. */
  exists: boolean;
  name: string | null;
  lastName: string | null;
  /** Idioma preferido guardado. null = nunca eligió, se infiere del mensaje. */
  preferredLanguage: SupportedLanguage | null;
  /**
   * true cuando hay ficha CON nombre utilizable. Un cliente puede existir sin
   * nombre (creado por una reserva de otro canal), y en ese caso hay que
   * preguntárselo igual que a uno nuevo.
   */
  isReturning: boolean;
  activeReservations: {
    reservationId: string;
    displayCode: string | null;
    partySize: number | null;
    status: string;
    whenLabel: string;
  }[];
}

/**
 * Arma el perfil del cliente para este comercio.
 *
 * Nunca lanza: si Supabase falla, se devuelve un perfil de cliente nuevo y la
 * conversación arranca preguntando el nombre — degradado, pero funcional.
 */
export async function loadCustomerProfile(
  phone: string,
  businessId: string
): Promise<CustomerProfile> {
  const empty: CustomerProfile = {
    exists: false,
    name: null,
    lastName: null,
    preferredLanguage: null,
    isReturning: false,
    activeReservations: [],
  };

  try {
    const [customer, reservations] = await Promise.all([
      SupabaseService.getCustomerByPhone(phone, businessId),
      SupabaseService.getActiveReservationsByPhone(phone, businessId),
    ]);

    const nowBA = nowInBuenosAires();
    const activeReservations = (reservations ?? []).map((r: WaitlistEntry) => ({
      reservationId: r.id,
      displayCode: r.display_code ?? null,
      partySize: r.party_size ?? null,
      status: r.status,
      whenLabel: r.scheduled_at
        ? describeScheduledAtUtc(r.scheduled_at, nowBA)
        : templates.instantTurnLabel(),
    }));

    if (!customer) {
      return { ...empty, activeReservations };
    }

    const name = customer.name?.trim() || null;
    // 'unknown' es el placeholder que dejan las altas sin nombre real; tratarlo
    // como nombre haría que el bot salude "¡Hola unknown!".
    const usableName = name && name.toLowerCase() !== 'unknown' ? name : null;

    return {
      exists: true,
      name: usableName,
      lastName: customer.lastName?.trim() || null,
      preferredLanguage: coerceLanguage(customer.preferred_language),
      isReturning: !!usableName,
      activeReservations,
    };
  } catch (error) {
    logger.error('Failed to load customer profile, degrading to new-customer', {
      businessId,
      phone,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return empty;
  }
}

/**
 * El modo dry-run usa su propio namespace: la conversación "imaginada" diverge
 * de la real desde el primer turno (responde distinto, así que el cliente
 * contesta otra cosa). Compartir la key haría que cada flujo corrompiera la
 * memoria del otro.
 */
function historyKey(conversationId: string, shadow = false): string {
  return `${shadow ? SHADOW_KEY_PREFIX : HISTORY_KEY_PREFIX}${conversationId}`;
}

/**
 * Historial persistido. Devuelve [] ante cualquier problema: perder memoria
 * degrada la conversación pero no la rompe, mientras que lanzar acá dejaría al
 * cliente sin respuesta.
 */
export async function loadHistory(conversationId: string, shadow = false): Promise<LlmMessage[]> {
  try {
    if (!RedisConfig.isReady()) return [];
    const raw = await RedisConfig.getClient().get(historyKey(conversationId, shadow));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LlmMessage[]) : [];
  } catch (error) {
    logger.warn('Failed to load agent history', {
      conversationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return [];
  }
}

export async function saveHistory(
  conversationId: string,
  messages: LlmMessage[],
  shadow = false
): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().setEx(
      historyKey(conversationId, shadow),
      HISTORY_TTL_SECONDS,
      JSON.stringify(trimHistory(messages))
    );
  } catch (error) {
    logger.warn('Failed to save agent history', {
      conversationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Agrega un mensaje del assistant al historial sin pasar por el modelo.
 *
 * Lo usan los mensajes que se envían FUERA del orquestador (hoy, el menú de
 * idiomas del primer contacto). Sin esto, el cliente contesta "2" en el turno
 * siguiente y el modelo no tiene a la vista qué se le ofreció.
 */
export async function appendAssistantMessage(
  conversationId: string,
  content: string
): Promise<void> {
  const history = await loadHistory(conversationId);
  await saveHistory(conversationId, [...history, { role: 'assistant', content }]);
}

/**
 * Agrega el turno completo (lo que dijo el cliente y lo que se le contestó).
 *
 * Los mensajes deterministas del alta no pasan por el modelo, así que nadie
 * persiste el lado del cliente. Sin él, el modelo hereda tres mensajes del
 * assistant seguidos y ningún "1" ni "Daniel" que los explique.
 */
export async function appendExchange(
  conversationId: string,
  userText: string,
  assistantText: string
): Promise<void> {
  const history = await loadHistory(conversationId);
  await saveHistory(conversationId, [
    ...history,
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  ]);
}

/**
 * Alta de un cliente nuevo: idioma → nombre → menú de apertura.
 *
 * Son tres mensajes fijos, sin nada que el modelo tenga que decidir, y por eso
 * el paso vive acá y no en el historial: preguntar "¿el último mensaje fue el
 * menú de idiomas?" comparando textos es frágil, y el modelo no necesita saber
 * que existe una máquina de estados de dos pasos.
 *
 * TTL igual al del historial: si el cliente vuelve al día siguiente, el alta
 * arranca de cero en vez de esperar un nombre que ya nadie le pidió.
 */
export type OnboardingStep = 'language' | 'name';

const ONBOARDING_KEY_PREFIX = 'agent_v2_onboarding:';

export async function loadOnboardingStep(conversationId: string): Promise<OnboardingStep | null> {
  try {
    if (!RedisConfig.isReady()) return null;
    const raw = await RedisConfig.getClient().get(`${ONBOARDING_KEY_PREFIX}${conversationId}`);
    return raw === 'language' || raw === 'name' ? raw : null;
  } catch (error) {
    logger.warn('Failed to load onboarding step', { conversationId, error });
    return null;
  }
}

export async function setOnboardingStep(
  conversationId: string,
  step: OnboardingStep
): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().setEx(
      `${ONBOARDING_KEY_PREFIX}${conversationId}`,
      HISTORY_TTL_SECONDS,
      step
    );
  } catch (error) {
    logger.warn('Failed to set onboarding step', { conversationId, error });
  }
}

export async function clearOnboardingStep(conversationId: string): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().del(`${ONBOARDING_KEY_PREFIX}${conversationId}`);
  } catch (error) {
    logger.warn('Failed to clear onboarding step', { conversationId, error });
  }
}

const STUCK_KEY_PREFIX = 'agent_v2_stuck:';

/**
 * Turnos consecutivos improductivos.
 *
 * Si el agente no logra avanzar dos turnos seguidos, hay que sacar al cliente
 * del loop en vez de dejarlo dando vueltas. "Improductivo" quiere decir que el
 * modelo agotó las iteraciones sin cerrar el turno, o que todas las
 * herramientas del turno fallaron.
 *
 * Vive en su propia key con TTL corto: es estado de recuperación, no memoria de
 * la conversación, y no debe sobrevivir a una pausa larga del cliente.
 */
const STUCK_TTL_SECONDS = 600;

export async function bumpUnproductiveStreak(conversationId: string): Promise<number> {
  try {
    if (!RedisConfig.isReady()) return 0;
    const client = RedisConfig.getClient();
    const key = `${STUCK_KEY_PREFIX}${conversationId}`;
    const next = await client.incr(key);
    await client.expire(key, STUCK_TTL_SECONDS);
    return next;
  } catch (error) {
    logger.warn('Failed to bump unproductive streak', { conversationId, error });
    return 0;
  }
}

export async function clearUnproductiveStreak(conversationId: string): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().del(`${STUCK_KEY_PREFIX}${conversationId}`);
  } catch (error) {
    logger.warn('Failed to clear unproductive streak', { conversationId, error });
  }
}

export async function clearHistory(conversationId: string): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().del(historyKey(conversationId));
    await RedisConfig.getClient().del(historyKey(conversationId, true));
    await RedisConfig.getClient().del(`${ONBOARDING_KEY_PREFIX}${conversationId}`);
  } catch (error) {
    logger.warn('Failed to clear agent history', { conversationId, error });
  }
}

/**
 * Recorta el historial sin partir un par assistant→tool.
 *
 * OpenRouter rechaza un mensaje `tool` cuyo `tool_call_id` no aparezca en el
 * assistant inmediatamente anterior. Un corte ciego por longitud puede dejar
 * huérfano el primer `tool` del array y hacer fallar todos los turnos
 * siguientes de esa conversación — por eso el punto de corte se adelanta hasta
 * el primer mensaje que no sea `tool`.
 */
export function trimHistory(messages: LlmMessage[]): LlmMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;

  let start = messages.length - MAX_HISTORY_MESSAGES;
  while (start < messages.length && messages[start].role === 'tool') {
    start += 1;
  }

  return messages.slice(start);
}
