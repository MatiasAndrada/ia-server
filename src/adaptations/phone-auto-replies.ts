import { RedisConfig } from '../config/redis.js';
import { logger } from '../utils/logger.js';

/**
 * ¿Un mensaje que salió del celular del local lo escribió la persona, o lo
 * mandó el celular solo?
 *
 * WhatsApp Business contesta automáticamente — el "mensaje de bienvenida" a
 * quien escribe por primera vez (o tras 14 días sin hablar), el "mensaje de
 * ausencia" fuera de horario — y al servidor eso le llega igual que algo que
 * ella tipeó: un mensaje propio (`fromMe`) en ese chat. Tomarlo como "la
 * persona está atendiendo" callaría al bot con cada cliente nuevo de De La
 * Fonte, que tiene su propio saludo configurado en el celular ("Hola! 👏🏻
 * Bienvenido/a. Este número es compartido...").
 *
 * El protocolo no marca esos mensajes de ninguna forma, así que se reconocen
 * por dos señales:
 *
 * 1. Tiempo: la respuesta automática sale uno o dos segundos después del
 *    mensaje del cliente, y una persona tarda bastante más. En los logs de
 *    producción (De La Fonte, 29 y 30/09): el saludo automático llegó a 1–2 s
 *    del cliente, la respuesta humana más rápida a 12 s.
 * 2. Texto: lo que la ventana de tiempo identificó como automático se
 *    recuerda por su texto, así también se reconoce cuando el celular lo
 *    manda tarde — por ejemplo, porque estaba sin conexión cuando llegó el
 *    mensaje del cliente.
 *
 * El error de este módulo es siempre hacia el mismo lado: ante la duda, el
 * mensaje lo escribió la persona. Un "Hola!" que ella tipeó en tres segundos
 * se toma como automático, pero el siguiente mensaje suyo ya no — y entonces
 * el bot se corre igual.
 */

/** Hasta cuánto después del cliente un mensaje propio se considera automático. */
export const AUTO_REPLY_WINDOW_MS = 8_000;

/**
 * Largo mínimo para recordar un texto como automático. Un "Hola!" que ella
 * tipeó rápido cae en la ventana, pero no puede volver automático a cada
 * "Hola!" que escriba después. Los saludos y ausencias de WhatsApp Business
 * son siempre párrafos.
 */
const MIN_TEMPLATE_LENGTH = 40;

/** Cuánto se recuerda un texto automático desde la última vez que se vio. */
const TEMPLATE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * A partir de cuántas entradas se poda el mapa de últimos mensajes. Sólo
 * importan las que están dentro de la ventana, así que podar no pierde nada.
 */
const PRUNE_THRESHOLD = 5_000;

/** Cuándo llegó el último mensaje de cada cliente, por comercio y teléfono. */
const lastCustomerMessageAt = new Map<string, number>();

function chatKey(businessId: string, phone: string): string {
  return `${businessId}:${phone}`;
}

function templatesKey(businessId: string): string {
  return `adaptation:auto-replies:${businessId}`;
}

function asTemplate(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * El cliente escribió — cualquier tipo de mensaje, también un audio o una
 * foto: el saludo automático sale igual.
 *
 * `at` tiene que ser la hora de LLEGADA, tomada antes de cualquier espera: si
 * se tomara al procesar, una consulta lenta a Supabase podría dejar el
 * mensaje del cliente registrado después del saludo automático que provocó.
 */
export function noteCustomerMessage(businessId: string, phone: string, at: number): void {
  if (lastCustomerMessageAt.size > PRUNE_THRESHOLD) {
    for (const [key, time] of lastCustomerMessageAt) {
      if (at - time > AUTO_REPLY_WINDOW_MS) lastCustomerMessageAt.delete(key);
    }
  }
  lastCustomerMessageAt.set(chatKey(businessId, phone), at);
}

/**
 * ¿Este mensaje propio lo mandó el celular solo?
 *
 * `at` es su hora de llegada, con el mismo criterio que en
 * `noteCustomerMessage`. Nunca lanza.
 */
export async function isPhoneAutoReply(
  businessId: string,
  phone: string,
  text: string,
  at: number
): Promise<boolean> {
  const template = asTemplate(text);
  const lastCustomerAt = lastCustomerMessageAt.get(chatKey(businessId, phone));
  const rightAfterCustomer =
    lastCustomerAt !== undefined && at >= lastCustomerAt && at - lastCustomerAt <= AUTO_REPLY_WINDOW_MS;
  const memorable = template.length >= MIN_TEMPLATE_LENGTH;

  try {
    if (!RedisConfig.isReady()) return rightAfterCustomer;
    const client = RedisConfig.getClient();
    const key = templatesKey(businessId);

    if (rightAfterCustomer) {
      if (memorable) {
        await client.sAdd(key, template);
        await client.expire(key, TEMPLATE_TTL_SECONDS);
      }
      return true;
    }

    return memorable && Boolean(await client.sIsMember(key, template));
  } catch (error) {
    logger.warn('Failed to check the phone auto-reply templates', {
      businessId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return rightAfterCustomer;
  }
}

/** Sólo para tests: olvida los últimos mensajes de clientes. */
export function resetPhoneAutoRepliesForTests(): void {
  lastCustomerMessageAt.clear();
}
