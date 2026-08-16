import { openRouterService } from './openrouter.service';
import { buildReservationPlannerTool } from '../agents/reservation-tools';
import { ConversationMessage, LlmMessage } from '../types';
import { logger } from '../utils/logger';

export type PlannedActionIntent = 'create' | 'cancel' | 'modify' | 'query' | 'other';

export interface PlannedAction {
  intent: PlannedActionIntent;
  customerName?: string;
  partySizeText?: string;
  dateText?: string;
  timeText?: string;
  targetReservationText?: string;
}

interface PlannerToolResult {
  actions?: PlannedAction[];
}

// reasoningMaxTokens caps google/gemini-2.5-pro's internal "thinking" tokens
// (see LlmGenerationOptions) so planning multiple actions from a longer
// conversation still leaves guaranteed room for the tool-call output.
const PLANNER_GENERATION_OPTIONS = { temperature: 0.1, maxTokens: 700, reasoningMaxTokens: 300 };

/** Action families that the deterministic executor actually knows how to run. */
const ACTIONABLE: ReadonlySet<PlannedActionIntent> = new Set(['create', 'cancel', 'modify', 'query']);

function buildPlannerSystemPrompt(businessName?: string): string {
  const resolvedBusinessName = businessName?.trim() || 'el local';
  return `Sos el planificador de un asistente de reservas de "${resolvedBusinessName}" por WhatsApp.

IDIOMA DE ENTRADA: el cliente puede escribir en español, inglés o portugués. Interpretá el mensaje igual en los tres casos. Los campos de texto crudo (dateText, timeText, partySizeText) se devuelven TAL CUAL los escribió el cliente, sin traducir: los normaliza el parser determinista.

Tu tarea es leer el último mensaje del cliente y, si contiene VARIAS acciones distintas, devolverlas TODAS y en ORDEN llamando a la herramienta "plan_reservation_actions".

Ejemplos de mensajes con varias acciones:
- "cancelá mi reserva del viernes y creá una nueva para mañana a las 21" → [cancel (target: la del viernes), create (dateText: mañana, timeText: a las 21)]
- "quiero cambiar la cantidad a 6 y también reservar otra para el sábado" → [modify, create]

Reglas:
- Devolvé una acción por cada intención separada. Si el mensaje pide una sola cosa, devolvé un solo elemento.
- No inventes datos que el mensaje no menciona; dejá los campos vacíos si no aparecen.
- Para fecha y horario devolvé el texto crudo (no calcules la fecha).`;
}

/**
 * Asks the model to decompose a message into an ordered list of distinct
 * actions. Returns null when the model didn't call the tool or the call failed,
 * so callers fall back to single-intent handling.
 */
export async function planReservationActions(
  message: string,
  businessName: string | undefined,
  history: ConversationMessage[] = []
): Promise<PlannedAction[] | null> {
  try {
    const systemPrompt = buildPlannerSystemPrompt(businessName);
    const messages: LlmMessage[] = [
      ...history.slice(-4).map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      { role: 'user' as const, content: message },
    ];

    const { toolCalls } = await openRouterService.chatWithActions(
      messages,
      systemPrompt,
      [buildReservationPlannerTool()],
      PLANNER_GENERATION_OPTIONS
    );

    const call = toolCalls.find((tc) => tc.function?.name === 'plan_reservation_actions');
    if (!call) {
      logger.info('Reservation planner: no tool call returned');
      return null;
    }

    const parsed = JSON.parse(call.function.arguments) as PlannerToolResult;
    const actions = (parsed.actions ?? []).filter(
      (action): action is PlannedAction => !!action && typeof action.intent === 'string'
    );

    logger.info('Reservation planner: actions extracted', {
      count: actions.length,
      intents: actions.map((a) => a.intent),
    });
    return actions;
  } catch (error) {
    logger.warn('Reservation planner failed, caller will fall back to single-intent', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/** Number of distinct, executable actions in a plan (create/cancel/modify/query). */
export function countActionableIntents(actions: PlannedAction[]): number {
  return actions.filter((action) => ACTIONABLE.has(action.intent)).length;
}
