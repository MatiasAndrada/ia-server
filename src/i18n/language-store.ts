import { RedisConfig } from '../config/redis.js';
import { SupabaseService } from '../services/supabase.service.js';
import { logger } from '../utils/logger.js';
import { coerceLanguage, DEFAULT_LANGUAGE, SupportedLanguage } from './languages.js';

/**
 * Persistencia y resolución del idioma preferido de cada cliente.
 *
 *   Redis lang:<businessId>:<phone>   ← hot path, evita un round-trip a la DB por mensaje
 *     ↓ miss
 *   customers.preferred_language      ← durable, sobrevive un flush de Redis
 *     ↓ null (nunca eligió)
 *   auto-detección sobre el mensaje   ← responsabilidad del caller (./detect)
 *     ↓ baja confianza
 *   businesses.language → 'es'
 *
 * El idioma NO vive en el ReservationDraft: el draft expira a la hora y además
 * tiene que persistir cuando no hay ninguna reserva en curso.
 *
 * La cache guarda además si el idioma fue ELEGIDO por el cliente o solo
 * INFERIDO del texto. La diferencia decide si se le vuelve a ofrecer el menú:
 * un idioma inferido es una apuesta nuestra, no una decisión suya, y no debe
 * hacer desaparecer la pregunta.
 */

const KEY_PREFIX = 'lang:';
/** 30 días, igual que la cache de JIDs — el idioma es una preferencia estable. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

/** De dónde salió el idioma. Se loguea en cada mensaje: sin esto, debuggear "quedó en el idioma equivocado" es adivinar. */
export type LanguageSource = 'redis' | 'db' | 'detected' | 'business' | 'default';

export interface ResolvedLanguage {
  language: SupportedLanguage;
  source: LanguageSource;
  /** true solo cuando el cliente eligió el idioma explícitamente (menú, bandera o frase). */
  isExplicit: boolean;
}

interface CachedEntry {
  language: SupportedLanguage;
  explicit: boolean;
}

function buildKey(businessId: string, phone: string): string {
  return `${KEY_PREFIX}${businessId}:${phone}`;
}

/**
 * Lee la cache. Acepta tanto el formato JSON actual como un string pelado
 * (formato anterior), que se interpreta como elección explícita para no
 * re-preguntarle el idioma a clientes que ya lo habían elegido.
 */
export async function getCachedLanguage(
  businessId: string,
  phone: string
): Promise<CachedEntry | null> {
  try {
    const client = RedisConfig.getClient();
    const stored = await client.get(buildKey(businessId, phone));
    if (!stored) return null;

    if (stored.startsWith('{')) {
      const parsed = JSON.parse(stored) as Partial<CachedEntry>;
      const language = coerceLanguage(parsed.language);
      return language ? { language, explicit: parsed.explicit !== false } : null;
    }

    const language = coerceLanguage(stored);
    return language ? { language, explicit: true } : null;
  } catch (error) {
    logger.warn('Failed to read cached language', { error, businessId, phone });
    return null;
  }
}

async function writeCache(
  businessId: string,
  phone: string,
  entry: CachedEntry
): Promise<void> {
  try {
    const client = RedisConfig.getClient();
    await client.setEx(buildKey(businessId, phone), TTL_SECONDS, JSON.stringify(entry));
  } catch (error) {
    logger.debug('Failed to cache language', { error, businessId, phone });
  }
}

/**
 * Guarda un idioma solo INFERIDO del texto del mensaje. No toca la DB: no es
 * una decisión del cliente, así que `customers.preferred_language` sigue en
 * NULL y el menú de idioma se le sigue ofreciendo.
 */
export async function cacheDetectedLanguage(
  businessId: string,
  phone: string,
  language: SupportedLanguage
): Promise<void> {
  await writeCache(businessId, phone, { language, explicit: false });
}

/**
 * Persiste la ELECCIÓN del cliente en Redis y en Supabase.
 *
 * La escritura en la DB es best-effort a propósito: si falla, la conversación
 * en curso ya tiene el idioma correcto por la cache, y perder la preferencia
 * de largo plazo es mucho menos grave que cortar el flujo de reserva.
 */
export async function persistLanguage(
  businessId: string,
  phone: string,
  language: SupportedLanguage
): Promise<void> {
  await writeCache(businessId, phone, { language, explicit: true });
  await SupabaseService.updateCustomerLanguage(phone, businessId, language);
}

/**
 * Resuelve el idioma del turno recorriendo Redis → DB → fallback del negocio.
 *
 * NO hace auto-detección: eso lo decide el caller, que es quien tiene el texto
 * del mensaje. Así este módulo se mantiene sin dependencias del LLM y testeable
 * sin mocks.
 */
export async function resolveLanguage(
  businessId: string,
  phone: string,
  businessLanguage?: string | null
): Promise<ResolvedLanguage> {
  const cached = await getCachedLanguage(businessId, phone);
  if (cached) {
    return { language: cached.language, source: 'redis', isExplicit: cached.explicit };
  }

  const stored = coerceLanguage(await SupabaseService.getCustomerLanguage(phone, businessId));
  if (stored) {
    // Repoblar la cache para que los siguientes mensajes no vuelvan a la DB.
    await writeCache(businessId, phone, { language: stored, explicit: true });
    return { language: stored, source: 'db', isExplicit: true };
  }

  const fromBusiness = coerceLanguage(businessLanguage);
  if (fromBusiness) {
    return { language: fromBusiness, source: 'business', isExplicit: false };
  }

  return { language: DEFAULT_LANGUAGE, source: 'default', isExplicit: false };
}

/** Borra la preferencia cacheada (para tests y para debug). */
export async function clearCachedLanguage(businessId: string, phone: string): Promise<void> {
  try {
    const client = RedisConfig.getClient();
    await client.del(buildKey(businessId, phone));
  } catch (error) {
    logger.warn('Failed to clear cached language', { error, businessId, phone });
  }
}
