import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Request } from 'express';
import { logEvent } from '../utils/logger.js';

/**
 * Rate limiting por negocio, no por IP.
 *
 * Por qué: todo el tráfico llega desde el mismo backend (el panel Next.js llama
 * server-to-server), así que keyear por `req.ip` — el default de
 * express-rate-limit — mete a TODOS los negocios en un único balde de 100
 * req/min. Un local con mucho movimiento un viernes a la noche podía devolver
 * 429 a clientes de otro local que no tenía nada que ver.
 */

/**
 * Un `businessId` plausible. Se valida para no fabricar keys basura a partir de
 * un segmento de ruta que no sea un id (ej. el listado `GET /api/sessions`, que
 * no tiene segmento, o un `businessId` vacío en el body).
 *
 * Deliberadamente más laxo que el `z.string().uuid()` de validation.middleware:
 * acá un id con otro formato debe seguir funcionando como key, no caer en
 * silencio al balde compartido de IP.
 */
function isPlausibleBusinessId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 64 && !value.includes('/');
}

/**
 * Rescata el `businessId` de la URL para las rutas montadas por router.
 *
 * Hace falta porque Express solo puebla `req.params` desde el *mount path* del
 * middleware, y los limiters se montan con `use()` sobre `/api` — que no tiene
 * segmento `:businessId`. Sin esto, `req.params` está vacío en el 100% de los
 * requests y todo el keyGenerator degrada a IP, dejando el bug intacto.
 */
function extractBusinessIdFromPath(url: string): string | null {
  const match = /^\/api\/(?:sessions|messages)\/([^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

/**
 * Balde al que se imputa un request: el negocio cuando se lo puede identificar,
 * la IP si no.
 *
 * Los prefijos (`biz:` / `ip:`) evitan que un businessId colisione con una IP.
 *
 * Nota sobre la rama IP: como el panel llama server-to-server, el servidor ve
 * una sola IP para todos los negocios. O sea que las rutas sin businessId
 * (`/health`, `GET /api/sessions`, `/api/batch`, `/stats`) siguen compartiendo
 * un balde único. No es una regresión — es exactamente el estado previo — pero
 * conviene saberlo antes de asumir que el aislamiento es total.
 */
export function resolveRateLimitKey(req: Request): string {
  // 1. Params: solo funciona si el limiter se adjunta a una ruta concreta.
  if (isPlausibleBusinessId(req.params?.businessId)) {
    return `biz:${req.params.businessId}`;
  }

  // 2. Body: cubre /api/chat, /api/reservations, /api/blocked-dates.
  //    express.json() ya corrió, pero en GET/DELETE el body es {} y en
  //    /api/batch el limiter corre ANTES de validate(), así que puede venir
  //    malformado — de ahí el acceso defensivo.
  const bodyBusinessId = (req.body as { businessId?: unknown } | undefined)?.businessId;
  if (isPlausibleBusinessId(bodyBusinessId)) {
    return `biz:${bodyBusinessId}`;
  }

  // 3. Path: el caso real del panel, que manda el id en la URL y sin body.
  const pathBusinessId = extractBusinessIdFromPath(req.originalUrl || req.url || '');
  if (isPlausibleBusinessId(pathBusinessId)) {
    return `biz:${pathBusinessId}`;
  }

  // 4. Sin negocio identificable. /api/batch cae siempre acá a propósito: cada
  //    mensaje lleva su propio businessId y un request puede abarcar hasta 50
  //    negocios distintos, así que una sola key no lo mediría bien.
  // `ipKeyGenerator` agrupa las IPv6 por /56: sin él, un cliente IPv6 rota de
  // dirección dentro de su propio prefijo y esquiva el límite (express-rate-limit
  // v8 avisa de esto al arrancar si el keyGenerator toca `req.ip` a mano).
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

/**
 * General rate limiter: 100 requests per minute per business (IP as fallback)
 */
export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per windowMs
  keyGenerator: resolveRateLimitKey,
  message: {
    error: 'Too Many Requests',
    message: 'You have exceeded the 100 requests per minute limit.',
    retryAfter: 60,
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  handler: (req, res) => {
    logEvent('warn', 'ratelimit.exceeded', {
      scope: 'general',
      key: resolveRateLimitKey(req),
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'You have exceeded the 100 requests per minute limit.',
      retryAfter: 60,
    });
  },
});

/**
 * Strict rate limiter for batch endpoint: 10 requests per minute per business
 * (in practice per IP — a batch can span several businesses, see resolveRateLimitKey)
 */
export const batchRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per windowMs
  keyGenerator: resolveRateLimitKey,
  message: {
    error: 'Too Many Requests',
    message: 'You have exceeded the 10 batch requests per minute limit.',
    retryAfter: 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: (req, res) => {
    logEvent('warn', 'ratelimit.exceeded', {
      scope: 'batch',
      key: resolveRateLimitKey(req),
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'You have exceeded the 10 batch requests per minute limit.',
      retryAfter: 60,
    });
  },
});

/**
 * Health check rate limiter: More permissive.
 * Sin keyGenerator propio: /health no tiene businessId ni auth, así que la IP
 * es la única señal disponible.
 */
export const healthCheckRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
});
