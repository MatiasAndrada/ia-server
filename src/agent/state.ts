import { RedisConfig } from '../config/redis.js';
import { SupabaseService } from '../services/supabase.service.js';
import { LlmMessage, WaitlistEntry } from '../types/index.js';
import { coerceLanguage, SupportedLanguage } from '../i18n/index.js';
import { describeScheduledAtUtc, nowInBuenosAires } from '../utils/reservation-datetime.js';
import * as templates from '../utils/message-templates.js';
import { logger } from '../utils/logger.js';

/**
 * Estado conversacional del agente v2.
 *
 * Reemplaza por completo a `ReservationDraft`: no hay `step`, ni campos
 * `pending*` / `awaiting*`. Lo único que se persiste es el historial (con sus
 * tool calls) — el "dónde estamos" queda implícito en esa conversación, que es
 * exactamente lo que un modelo sabe leer sin que nadie se lo codifique.
 */

const HISTORY_KEY_PREFIX = 'agent_v2:';
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

function historyKey(conversationId: string): string {
  return `${HISTORY_KEY_PREFIX}${conversationId}`;
}

/**
 * Historial persistido. Devuelve [] ante cualquier problema: perder memoria
 * degrada la conversación pero no la rompe, mientras que lanzar acá dejaría al
 * cliente sin respuesta.
 */
export async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  try {
    if (!RedisConfig.isReady()) return [];
    const raw = await RedisConfig.getClient().get(historyKey(conversationId));
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

export async function saveHistory(conversationId: string, messages: LlmMessage[]): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().setEx(
      historyKey(conversationId),
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

export async function clearHistory(conversationId: string): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().del(historyKey(conversationId));
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
