/**
 * Throttle de logs repetidos.
 *
 * Existe por evidencia concreta: en los logs actuales hay `Session not found`
 * 1754 veces, `Failed to send INSERT notification` 1678, y cada uno de los tres
 * `Error subscribing to ...` ~1000 veces. Son bucles de reintento que emiten la
 * misma línea sin parar y tapan todo lo demás.
 *
 * El contrato es: la primera ocurrencia de una clave pasa, y después se
 * suprimen hasta que venza la ventana. Cuando vuelve a pasar, informa cuántas
 * se suprimieron para que el log no mienta sobre la magnitud del problema.
 */

interface ThrottleEntry {
  /** Momento en que se dejó pasar la última línea de esta clave. */
  lastLoggedAt: number;
  /** Cuántas se suprimieron desde entonces. */
  suppressed: number;
}

const entries = new Map<string, ThrottleEntry>();

/** Ventana por defecto: un minuto. */
export const DEFAULT_THROTTLE_MS = 60_000;

/**
 * Evita que `entries` crezca sin techo si alguien usa una clave de alta
 * cardinalidad. Al llegar al límite se descarta la mitad más vieja.
 */
const MAX_ENTRIES = 500;

function evictIfNeeded(now: number): void {
  if (entries.size < MAX_ENTRIES) return;

  const sorted = [...entries.entries()].sort(
    (a, b) => a[1].lastLoggedAt - b[1].lastLoggedAt
  );
  for (const [key] of sorted.slice(0, Math.floor(MAX_ENTRIES / 2))) {
    entries.delete(key);
  }
  // `now` queda sin usar salvo para dejar claro que la decisión es temporal.
  void now;
}

export interface ThrottleDecision {
  /** True si esta ocurrencia debe loguearse. */
  allowed: boolean;
  /** Cuántas se suprimieron desde el último log permitido de esta clave. */
  suppressed: number;
}

/**
 * Decide si una línea identificada por `key` debe emitirse.
 *
 * @example
 * const t = throttle(`msg.out_failed:${businessId}`);
 * if (t.allowed) logEvent('warn', 'msg.out_failed', { reason, suppressed: t.suppressed });
 */
export function throttle(key: string, windowMs = DEFAULT_THROTTLE_MS): ThrottleDecision {
  const now = Date.now();
  const existing = entries.get(key);

  if (!existing || now - existing.lastLoggedAt >= windowMs) {
    const suppressed = existing?.suppressed ?? 0;
    evictIfNeeded(now);
    entries.set(key, { lastLoggedAt: now, suppressed: 0 });
    return { allowed: true, suppressed };
  }

  existing.suppressed += 1;
  return { allowed: false, suppressed: existing.suppressed };
}

/** Limpia el estado. Sólo para tests. */
export function resetThrottle(): void {
  entries.clear();
}
