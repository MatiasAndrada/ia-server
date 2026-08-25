/**
 * Deduplicación de avisos salientes.
 *
 * Un mismo hecho puede llegar por dos caminos: el flujo que lo provocó —el
 * handler de WhatsApp, que ya le respondió al cliente en el mismo turno— y el
 * suscriptor de Realtime, que ve el cambio en la DB unos milisegundos después.
 * Sin un acuerdo entre los dos, el cliente recibe el mensaje repetido.
 *
 * El acuerdo es esta clave: quien manda el aviso la marca, y el otro se calla.
 * El formato vivía duplicado como string literal en cinco lugares; acá está una
 * sola vez, que es lo que hace que el contrato se sostenga.
 *
 * Si Redis no está disponible el sistema falla abierto (se envía igual): un
 * mensaje repetido es peor que uno perdido, pero un cliente que no se entera de
 * su reserva es peor que los dos.
 */
import { RedisConfig } from '../config/redis.js';
import { logger } from './logger.js';

/** Un día: pasado ese plazo el hecho ya no se va a re-emitir. */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Ventana corta, para cuando lo único que hay que tapar es el eco inmediato de
 * Realtime sobre un estado que el handler acaba de escribir y avisar. Con el
 * TTL largo, un cambio legítimo al mismo estado horas después quedaría mudo.
 */
export const ECHO_TTL_SECONDS = 90;

/** Aviso de reserva recién creada (INSERT en `waitlist_entries`). */
export function createdNotificationKey(entryId: string): string {
  return `wa:created:${entryId}`;
}

/**
 * Aviso de cambio de estado. Lleva el estado en la clave a propósito: CONFIRMED
 * y NOTIFIED son dos avisos distintos y no deben bloquearse entre sí.
 */
export function statusNotificationKey(entryId: string, status: string): string {
  return `wa:status:sent:${entryId}:${status}`;
}

/** Recordatorio previo a la reserva. `kind` distingue el de antelación del de proximidad. */
export function reminderNotificationKey(entryId: string, kind: string): string {
  return `wa:reminder:sent:${entryId}:${kind}`;
}

/** True si este aviso ya salió. Ante un Redis caído devuelve false (falla abierto). */
export async function wasAlreadyNotified(key: string): Promise<boolean> {
  try {
    if (!RedisConfig.isReady()) {
      return false;
    }
    return !!(await RedisConfig.getClient().get(key));
  } catch (error) {
    logger.debug('Dedup check failed, assuming not sent', { key, error });
    return false;
  }
}

/** Marca el aviso como enviado. Nunca lanza: perder la marca no debe romper el envío. */
export async function markNotified(key: string, ttlSeconds = TTL_SECONDS): Promise<void> {
  try {
    if (!RedisConfig.isReady()) {
      return;
    }
    await RedisConfig.getClient().setEx(key, ttlSeconds, '1');
  } catch (error) {
    logger.debug('Failed to mark notification as sent', { key, error });
  }
}

/**
 * Levanta una marca puesta por adelantado.
 *
 * Quien silencia a Realtime tiene que marcar ANTES de escribir en la DB, porque
 * el evento llega a los pocos milisegundos. Si esa escritura después falla, la
 * marca quedaría suprimiendo un aviso legítimo: esto la deshace.
 */
export async function clearNotified(key: string): Promise<void> {
  try {
    if (!RedisConfig.isReady()) {
      return;
    }
    await RedisConfig.getClient().del(key);
  } catch (error) {
    logger.debug('Failed to clear notification mark', { key, error });
  }
}
