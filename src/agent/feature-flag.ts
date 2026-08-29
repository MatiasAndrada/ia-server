import { logger } from '../utils/logger.js';

/**
 * Enrutamiento entre el flujo determinista (v1) y el orquestador (v2).
 *
 * El flag es POR COMERCIO, no global, y esa es toda la estrategia de rollout:
 * se habilita un local, se mira cómo se comporta con clientes reales, y se
 * amplía. Sacar el id de la variable de entorno es el rollback — no hace falta
 * deploy ni revertir código.
 *
 * `AGENT_MODE=v2` habilita a TODOS los comercios; `AGENT_V2_BUSINESS_IDS` es la
 * lista blanca que se usa durante el rollout.
 */

let mode: 'v1' | 'v2' = 'v1';
let allowList: ReadonlySet<string> = new Set();
let shadowList: ReadonlySet<string> = new Set();

function parseIds(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

export function configureAgentMode(
  rawMode: string | undefined,
  rawIds: string | undefined,
  rawShadowIds?: string | undefined
): void {
  mode = rawMode?.trim().toLowerCase() === 'v2' ? 'v2' : 'v1';
  allowList = parseIds(rawIds);
  shadowList = parseIds(rawShadowIds);

  logger.info('Agent mode configured', {
    mode,
    allowListSize: allowList.size,
    shadowListSize: shadowList.size,
  });
}

export function isAgentV2Enabled(businessId: string): boolean {
  return mode === 'v2' || allowList.has(businessId);
}

/**
 * Modo sombra: v1 atiende al cliente y v2 corre en paralelo sin enviar nada,
 * para poder compararlos sobre tráfico real.
 *
 * Un comercio ya servido por v2 nunca corre en sombra — sería computar el mismo
 * turno dos veces para compararlo consigo mismo.
 */
export function isAgentShadowEnabled(businessId: string): boolean {
  return shadowList.has(businessId) && !isAgentV2Enabled(businessId);
}

/** Sólo para tests: fuerza el modo sin pasar por variables de entorno. */
export function __setAgentModeForTests(
  next: 'v1' | 'v2',
  ids: string[] = [],
  shadowIds: string[] = []
): void {
  mode = next;
  allowList = new Set(ids);
  shadowList = new Set(shadowIds);
}
