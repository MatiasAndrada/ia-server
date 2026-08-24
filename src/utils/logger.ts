import winston from 'winston';
import { currentLogContext } from './log-context.js';
import { EVENT_LABELS, LogEvent } from './log-events.js';

/**
 * Claves cuyo valor nunca se escribe al log, en cualquier nivel de anidamiento.
 *
 * La razón concreta: el patrón `logger.error('...', { error })` con un error de
 * Axios sin desenvolver serializaba `error.config.headers.Authorization`, es
 * decir la `OPENROUTER_API_KEY` en texto plano. `normalizeError` ya corta ese
 * caso, y esta denylist es la red de contención para todo lo demás.
 */
const SECRET_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'apikeys',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'password',
  'secret',
  'creds',
  'credentials',
  'cookie',
  'setcookie',
  'set-cookie',
  'supabasekey',
  'supabase_key',
  'openrouterapikey',
  'openrouter_api_key',
]);

/** Claves que el logger administra y no deben pasar por los transforms. */
const RESERVED_KEYS = new Set(['level', 'message', 'timestamp', 'service', 'event', 'stack']);

/** Máximo de caracteres por string. Corta payloads enteros volcados por descuido. */
const MAX_STRING_LENGTH = 500;
/** Máximo de elementos por array. */
const MAX_ARRAY_LENGTH = 20;
/** Profundidad máxima de objetos anidados. */
const MAX_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reduce un Error (incluidos los de Axios y Supabase) a los campos que sirven
 * para debuggear, descartando el resto del grafo — que es donde viajan las
 * credenciales y los payloads completos.
 */
function normalizeError(value: unknown, includeStack: boolean): unknown {
  if (value instanceof Error) {
    const anyError = value as Error & {
      code?: unknown;
      status?: unknown;
      response?: { status?: unknown; data?: unknown };
    };

    const normalized: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };

    if (anyError.code !== undefined) normalized.code = anyError.code;
    if (anyError.status !== undefined) normalized.status = anyError.status;
    if (anyError.response?.status !== undefined) {
      normalized.httpStatus = anyError.response.status;
    }
    if (anyError.response?.data !== undefined) {
      // Sólo el body de la respuesta, nunca `config` (que lleva los headers).
      normalized.responseData = anyError.response.data;
    }
    if (includeStack && value.stack) normalized.stack = value.stack;

    return normalized;
  }

  // Errores de Supabase (PostgrestError) no son instancias de Error.
  if (isPlainObject(value) && typeof value.message === 'string') {
    const { message, code, details, hint } = value;
    return { message, ...(code !== undefined && { code }), ...(details !== undefined && { details }), ...(hint !== undefined && { hint }) };
  }

  return value;
}

/** Redacta secretos y acota tamaño en un mismo recorrido. */
function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH} chars]`
      : value;
  }

  if (value === null || typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) return '[depth limit]';

  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) {
      capped.push(`…[+${value.length - MAX_ARRAY_LENGTH} items]`);
    }
    return capped;
  }

  if (value instanceof Error) return normalizeError(value, false);

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitize(nested, depth + 1);
  }
  return out;
}

/** Mergea el contexto implícito (`conversationId`, `businessId`, …) en cada línea. */
const injectContext = winston.format((info) => {
  const ctx = currentLogContext();
  for (const [key, value] of Object.entries(ctx)) {
    if (info[key] === undefined) info[key] = value;
  }
  return info;
});

/** Normaliza errores y aplica redacción + límites de tamaño al resto del meta. */
const sanitizeMeta = winston.format((info) => {
  const includeStack = info.level === 'error';

  for (const key of Object.keys(info)) {
    if (RESERVED_KEYS.has(key)) continue;

    const value = info[key];
    if (key === 'error' || key === 'err' || key === 'reason' || key === 'cause') {
      info[key] = sanitize(normalizeError(value, includeStack));
    } else {
      info[key] = sanitize(value);
    }
  }

  return info;
});

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  injectContext(),
  sanitizeMeta()
);

/**
 * Formato de desarrollo: una línea por log.
 *
 * El formato anterior usaba `JSON.stringify(meta, null, 2)`, que convertía cada
 * llamada en un bloque multilínea — el mayor amplificador de volumen que tenía
 * el sistema.
 */
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, event, service, ...meta }) => {
    void service;
    const pairs = Object.entries(meta)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const tag = event ? ` [${event}]` : '';
    return `${timestamp} ${level}${tag} ${message}${pairs ? ` | ${pairs}` : ''}`;
  })
);

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Un solo transport: stdout.
 *
 * Antes había dos transports `File` (`logs/error.log`, `logs/combined.log`) MÁS
 * la consola que PM2 volcaba a `logs/pm2-out.log`, o sea cada línea escrita dos
 * veces a disco con dos políticas de retención distintas — y la de PM2 no
 * rotaba (94 MB). Ahora el proceso sólo escribe a stdout/stderr y PM2 +
 * pm2-logrotate se encargan del archivo y la rotación.
 *
 * `stderrLevels: ['error']` hace que PM2 separe los errores en
 * `logs/pm2-error.log`, cubriendo lo que antes daba `logs/error.log`.
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: baseFormat,
  defaultMeta: { service: 'ia-server' },
  transports: [
    new winston.transports.Console({
      format: isProduction ? winston.format.json() : devFormat,
      stderrLevels: ['error'],
    }),
  ],
});

export type EventLevel = 'info' | 'warn' | 'error';

/**
 * Emite un evento del catálogo.
 *
 * Es la única forma de escribir en `info` o superior. Traza paso a paso va por
 * `logger.debug(...)` con texto libre y queda apagada en producción.
 *
 * @example
 * logEvent('info', 'session.linked', { phone });
 * logEvent('warn', 'msg.out_failed', { to, reason: 'no_session' });
 */
export function logEvent(
  level: EventLevel,
  event: LogEvent,
  meta: Record<string, unknown> = {}
): void {
  logger.log(level, EVENT_LABELS[event], { event, ...meta });
}
