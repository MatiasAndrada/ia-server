import { AgentTool, ToolContext, ToolResult } from './types.js';
import {
  checkAvailabilityTool,
  findSoonestSlotTool,
  listOpenDaysTool,
  resolveDateTool,
} from './availability.tools.js';
import {
  cancelReservationTool,
  createReservationTool,
  listMyReservationsTool,
  modifyReservationTool,
} from './reservation.tools.js';
import { getBusinessInfoTool, listEventsTool, showEventDetailsTool } from './business.tools.js';
import { setLanguageTool, updateCustomerNameTool } from './customer.tools.js';
import { LlmToolCall, LlmToolDefinition } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export type { ToolContext, ToolResult } from './types.js';

/**
 * Registro de herramientas del agente v2.
 *
 * El ORDEN importa y es deliberado: OpenRouter reenvía este array en cada
 * request del loop, así que mantenerlo estable es lo que permite que el
 * prefijo del prompt (tools → system → messages) se cachee entre turnos.
 * Reordenarlo invalida el cache de toda conversación en curso.
 */
const TOOLS: readonly AgentTool<any>[] = [
  // Consulta — baratas, sin efectos, el modelo las llama con libertad.
  getBusinessInfoTool,
  listOpenDaysTool,
  listEventsTool,
  showEventDetailsTool,
  listMyReservationsTool,
  // Resolución — traducen lo que dijo el cliente a datos validados.
  resolveDateTool,
  checkAvailabilityTool,
  findSoonestSlotTool,
  // Escritura — cambian estado real.
  createReservationTool,
  modifyReservationTool,
  cancelReservationTool,
  updateCustomerNameTool,
  setLanguageTool,
];

const BY_NAME = new Map<string, AgentTool<any>>(
  TOOLS.map((tool) => [tool.definition.function.name, tool])
);

/** Definiciones para mandarle al modelo. Se reenvían en CADA request del loop. */
export function getToolDefinitions(): LlmToolDefinition[] {
  return TOOLS.map((tool) => tool.definition);
}

/**
 * Ejecuta una tool call del modelo.
 *
 * Nunca lanza: un error acá es información que el modelo puede usar (para
 * reintentar con otros argumentos, o para explicarle al cliente qué pasó), no
 * una falla del turno. Por eso todo camino de error vuelve como `ToolResult`
 * con `ok: false`, incluidos los argumentos mal formados.
 */
export async function executeToolCall(call: LlmToolCall, ctx: ToolContext): Promise<ToolResult> {
  const name = call.function?.name;
  const tool = name ? BY_NAME.get(name) : undefined;

  if (!tool) {
    logger.warn('Agent requested an unknown tool', { name });
    return {
      ok: false,
      error: {
        code: 'unknown_tool',
        hint: `No existe una herramienta llamada "${name}". Usá sólo las disponibles.`,
      },
    };
  }

  let args: unknown;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    logger.warn('Agent sent malformed tool arguments', { name, raw: call.function.arguments });
    return {
      ok: false,
      error: {
        code: 'malformed_arguments',
        hint: 'Los argumentos no eran JSON válido. Reintentá la llamada con el formato correcto.',
      },
    };
  }

  try {
    return await tool.run(args, ctx);
  } catch (error) {
    // Una excepción de una herramienta no puede tumbar el turno: el cliente
    // está esperando en WhatsApp. Se le informa al modelo y sigue.
    logger.error('Agent tool threw', {
      name,
      conversationId: ctx.conversationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      ok: false,
      error: {
        code: 'tool_failed',
        hint: 'La operación falló por un problema técnico. Pedile disculpas al cliente y ofrecele reintentar.',
      },
    };
  }
}
