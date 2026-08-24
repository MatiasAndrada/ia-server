import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contadores del turno de conversación en curso.
 *
 * Sirven para emitir una única línea `turn.completed` al final de cada turno,
 * con lo que realmente pasó adentro. Antes había que reconstruir eso leyendo
 * decenas de líneas `info` sueltas repartidas por toda la máquina de estados.
 *
 * Es un objeto mutable dentro de un AsyncLocalStorage — mismo alcance que
 * `withLogContext` y que `runWithLanguage`: la cadena async de un turno. Un
 * contador en `this` sería una race condition, porque `WhatsAppHandler` es un
 * singleton que atiende conversaciones en paralelo.
 */
export interface TurnStats {
  /** Llamadas al LLM hechas durante el turno. */
  llmCalls: number;
  /** Milisegundos acumulados esperando al LLM. */
  llmMs: number;
  /** Mensajes efectivamente enviados al cliente. */
  outbound: number;
  /** Último paso del draft de reserva que se procesó. */
  step?: string;
  /** Motivo por el que el turno se cortó antes de llegar al agente. */
  blocked?: string;
}

const turnStatsStore = new AsyncLocalStorage<TurnStats>();

/** Corre `fn` con un juego de contadores nuevo y se lo pasa al terminar. */
export function withTurnStats<T>(fn: (stats: TurnStats) => T): T {
  const stats: TurnStats = { llmCalls: 0, llmMs: 0, outbound: 0 };
  return turnStatsStore.run(stats, () => fn(stats));
}

/** Contadores activos, o `undefined` fuera de un turno (rutas HTTP, jobs). */
export function currentTurnStats(): TurnStats | undefined {
  return turnStatsStore.getStore();
}

export function recordLlmCall(durationMs: number): void {
  const stats = turnStatsStore.getStore();
  if (!stats) return;
  stats.llmCalls += 1;
  stats.llmMs += durationMs;
}

export function recordOutbound(): void {
  const stats = turnStatsStore.getStore();
  if (stats) stats.outbound += 1;
}

export function recordDraftStep(step: string): void {
  const stats = turnStatsStore.getStore();
  if (stats) stats.step = step;
}

export function recordBlocked(reason: string): void {
  const stats = turnStatsStore.getStore();
  if (stats) stats.blocked = reason;
}
