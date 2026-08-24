import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto implícito que acompaña a cada línea de log.
 *
 * Mismo razonamiento que `src/i18n/context.ts`: los identificadores que
 * necesitamos para correlacionar (`conversationId`, `businessId`, `phone`) son
 * contexto del turno, no argumentos de negocio de cada función. Antes se
 * repetían a mano en cientos de llamadas a `logger.*` — y faltaban en módulos
 * enteros, como `realtime-sync.service.ts`.
 *
 * IMPORTANTE: este store vive en su propio módulo, separado de `logger.ts`, a
 * propósito. 11 suites de test hacen `jest.mock('../../utils/logger')`
 * (auto-mock); si `withLogContext` viviera ahí, el auto-mock devolvería
 * `undefined` y nunca ejecutaría el callback, matando el flujo de mensajes en
 * los tests. Acá no lo alcanza el mock.
 */
export interface LogContext {
  /** Identificador de la request HTTP en curso. */
  requestId?: string;
  /** UUID del comercio (tenant). */
  businessId?: string;
  /** `${businessId}-${phone}` — el hilo transversal de todo el dominio. */
  conversationId?: string;
  /** Teléfono del cliente, ya normalizado (sin sufijo de JID). */
  phone?: string;
  /** Id de la entrada de waitlist involucrada, cuando aplica. */
  entryId?: string;
}

const logContextStore = new AsyncLocalStorage<LogContext>();

/**
 * Corre `fn` con `ctx` mergeado sobre el contexto actual.
 *
 * El merge (en vez de reemplazo) permite anidar: el middleware HTTP abre con
 * `{ requestId }` y un handler más abajo agrega `{ businessId }` sin perderlo.
 * Las claves vacías se descartan para no pisar lo que ya venía.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = logContextStore.getStore();
  const merged: LogContext = { ...parent };

  for (const [key, value] of Object.entries(ctx)) {
    if (value !== undefined && value !== null && value !== '') {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  return logContextStore.run(merged, fn);
}

/** Contexto activo. Fuera de un `withLogContext` devuelve un objeto vacío. */
export function currentLogContext(): LogContext {
  return logContextStore.getStore() ?? {};
}
