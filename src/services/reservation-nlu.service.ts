import { openRouterService } from './openrouter.service.js';
import { buildReservationSlotsTool } from '../agents/reservation-tools.js';
import { ConversationMessage, LlmMessage, ReservationDraft } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface ReservationSlots {
  customerName?: string;
  nameLooksInvalid?: boolean;
  partySizeText?: string;
  scheduleChoice?: 'today' | 'other_day';
  dateText?: string;
  timeText?: string;
  confirmation?: 'yes' | 'no';
  menuChoice?: number;
  wantsToCancel?: boolean;
  wantsToModify?: 'party_size' | 'date' | 'time';
  offTopic?: boolean;
}

/** Turn count-in-memory metrics for the /stats endpoint (Fase 6). Reset on process restart. */
export const reservationNluMetrics = {
  extracted: 0, // model returned a usable tool call
  empty: 0, // model responded with no tool call (nothing to extract, or degraded to the generic fallback text)
  error: 0, // extraction threw before a response was even attempted
};

// reasoningMaxTokens caps google/gemini-2.5-pro's internal "thinking" tokens
// (see LlmGenerationOptions) so the tool-call output always has guaranteed room.
const EXTRACTION_GENERATION_OPTIONS = { temperature: 0.1, maxTokens: 500, reasoningMaxTokens: 200 };

function buildExtractionSystemPrompt(
  draft: ReservationDraft | null,
  businessName?: string
): string {
  const resolvedBusinessName = businessName?.trim() || 'el local';
  const stateLines: string[] = [];

  if (draft) {
    stateLines.push(`Paso actual de la reserva: ${draft.step}`);
    if (draft.customerName) stateLines.push(`Nombre ya confirmado: ${draft.customerName}`);
    if (draft.partySize) stateLines.push(`Cantidad de personas ya confirmada: ${draft.partySize}`);
    if (draft.scheduledDate) stateLines.push(`Fecha ya confirmada: ${draft.scheduledDate}`);
    if (draft.scheduledTime) stateLines.push(`Horario ya confirmado: ${draft.scheduledTime}`);
  } else {
    stateLines.push('Todavía no hay ningún dato confirmado de la reserva.');
  }

  return `Sos el módulo de comprensión de lenguaje de un asistente de reservas de "${resolvedBusinessName}" por WhatsApp.

IDIOMA DE ENTRADA: el cliente puede escribir en español, inglés o portugués. Interpretá el mensaje igual en los tres casos. Los campos de texto crudo (dateText, timeText, partySizeText) se devuelven TAL CUAL los escribió el cliente, sin traducir: los normaliza el parser determinista.

Tu única tarea es leer el último mensaje del cliente y llamar a la herramienta "update_reservation" con los datos que ese mensaje efectivamente menciona. No inventes datos ausentes, no calcules fechas (devolvé el texto crudo), y no confirmes ni valides nada — de eso se encarga otro sistema.

Estado actual de la conversación:
${stateLines.join('\n')}

Si el mensaje no aporta ningún dato de reserva y no tiene relación con hacer/modificar/cancelar una reserva, llamá a la herramienta con offTopic: true y nada más.`;
}

/**
 * Asks the model for a structured reading of `message` given the current
 * draft state. Returns null when there's nothing usable to extract (the
 * model didn't call the tool, the call errored, or the JSON was malformed)
 * so callers can fall back to the existing regex-based parsing for that step.
 */
export async function extractReservationUpdate(
  message: string,
  draft: ReservationDraft | null,
  businessName: string | undefined,
  history: ConversationMessage[] = []
): Promise<ReservationSlots | null> {
  try {
    const systemPrompt = buildExtractionSystemPrompt(draft, businessName);

    const messages: LlmMessage[] = [
      ...history.slice(-6).map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      { role: 'user' as const, content: message },
    ];

    const { toolCalls } = await openRouterService.chatWithActions(
      messages,
      systemPrompt,
      [buildReservationSlotsTool()],
      EXTRACTION_GENERATION_OPTIONS
    );

    const call = toolCalls.find((tc) => tc.function?.name === 'update_reservation');
    if (!call) {
      reservationNluMetrics.empty += 1;
      logger.info('Reservation NLU: no tool call returned, caller will fall back to regex', {
        step: draft?.step,
      });
      return null;
    }

    const parsed = JSON.parse(call.function.arguments) as ReservationSlots;
    reservationNluMetrics.extracted += 1;
    logger.info('Reservation NLU: extracted slots', {
      step: draft?.step,
      fields: Object.keys(parsed),
    });
    return parsed;
  } catch (error) {
    reservationNluMetrics.error += 1;
    logger.warn('Reservation NLU extraction failed, caller will fall back to regex', {
      step: draft?.step,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}
