import { Action, ActionType, LlmToolCall, LlmToolDefinition } from '../types/index.js';
import { logger } from './logger.js';

const VALID_ACTION_TYPES: ActionType[] = ['REGISTER', 'CHECK_STATUS', 'CANCEL', 'INFO_REQUEST'];

/**
 * Tool definition passed to the LLM so it emits structured, schema-validated
 * actions via native tool calling instead of a hand-rolled [ACTION:...] text
 * marker that had to be regex-parsed (and could be malformed or hallucinated).
 */
export function buildActionTool(): LlmToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'emit_action',
      description:
        'Registra la acción concreta que corresponde a la intención del cliente en este turno. ' +
        'Llamala solo cuando el mensaje del cliente efectivamente dispara una de estas acciones; ' +
        'si el turno es solo conversación (saludo, pregunta general sin acción clara), no la llames.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: VALID_ACTION_TYPES,
            description:
              'REGISTER: anotar al cliente en la lista de espera. CHECK_STATUS: consultar posición/tiempo de espera. ' +
              'CANCEL: cancelar la entrada del cliente. INFO_REQUEST: el cliente pide información del local.',
          },
          name: { type: 'string', description: 'Nombre del cliente, si lo mencionó.' },
          partySize: { type: 'integer', description: 'Cantidad de personas, si la mencionó.' },
          preferences: { type: 'string', description: 'Preferencias especiales mencionadas.' },
          reason: { type: 'string', description: 'Motivo de cancelación, si aplica.' },
        },
        required: ['type'],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Converts tool_calls returned by the LLM into the Action[] shape the rest
 * of the app expects. Unlike the old regex-based parseActions, every action
 * here already validated against the tool's JSON schema before arriving.
 */
export function parseToolCallActions(toolCalls: LlmToolCall[]): Action[] {
  const actions: Action[] = [];

  for (const call of toolCalls) {
    if (call.function?.name !== 'emit_action') continue;

    try {
      const parsed = JSON.parse(call.function.arguments);
      const type = parsed.type as ActionType;

      if (!VALID_ACTION_TYPES.includes(type)) {
        logger.warn('Model emitted an action with an unknown type', { type });
        continue;
      }

      const { type: _discard, ...data } = parsed;

      actions.push({
        type,
        data,
        confidence: 0.9,
      });
    } catch (error) {
      logger.warn('Failed to parse tool call arguments', {
        arguments: call.function?.arguments,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return actions;
}

/**
 * Calculates confidence score based on response characteristics
 */
export function calculateConfidence(responseText: string, actions: Action[]): number {
  let confidence = 0.5; // Base confidence

  // Higher confidence if explicit actions are present
  if (actions.length > 0 && actions.some((a) => !a.data.inferred)) {
    confidence = 0.9;
  } else if (actions.length > 0) {
    // Actions were inferred
    const avgActionConfidence =
      actions.reduce((sum, a) => sum + (a.confidence || 0), 0) / actions.length;
    confidence = avgActionConfidence;
  }

  // Adjust based on response length and structure
  if (responseText.length > 50 && responseText.length < 500) {
    confidence += 0.05; // Good length
  }

  // Check for professional markers
  const professionalMarkers = [
    'con gusto',
    'por favor',
    'disculpa',
    'gracias',
    'claro',
  ];
  const hasMarkers = professionalMarkers.some((marker) =>
    responseText.toLowerCase().includes(marker)
  );
  if (hasMarkers) {
    confidence += 0.05;
  }

  // Cap at 1.0
  return Math.min(confidence, 1.0);
}

/**
 * Extracts entities from text (name, party size, etc.)
 */
export function extractEntities(text: string): Record<string, any> {
  const entities: Record<string, any> = {};

  // Extract party size
  const partySizeMatch = text.match(/(\d+)\s*(persona|people|pax)/i);
  if (partySizeMatch) {
    entities.partySize = parseInt(partySizeMatch[1], 10);
  }

  // Extract name (simple pattern - capitalized words)
  const nameMatch = text.match(/me llamo ([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
  if (nameMatch) {
    entities.name = nameMatch[1];
  } else {
    // Try "soy [Name]"
    const nameMatch2 = text.match(/soy ([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
    if (nameMatch2) {
      entities.name = nameMatch2[1];
    }
  }

  // Extract preferences
  const preferenceKeywords = ['ventana', 'terraza', 'interior', 'tranquil', 'silencio'];
  for (const keyword of preferenceKeywords) {
    if (text.toLowerCase().includes(keyword)) {
      entities.preferences = entities.preferences || [];
      entities.preferences.push(keyword);
    }
  }

  return entities;
}

/**
 * Cleans AI response text by removing action markers
 */
export function cleanResponseText(text: string): string {
  // Remove [ACTION:...] markers
  return text.replace(/\[ACTION:\w+:.*?\]/g, '').trim();
}

/**
 * Validates if an action has required data
 */
export function validateAction(action: Action): boolean {
  switch (action.type) {
    case 'REGISTER':
      // At minimum needs partySize or name
      return !!(action.data.partySize || action.data.name);
    
    case 'CHECK_STATUS':
    case 'CANCEL':
      // These might work with just phone from context
      return true;
    
    case 'INFO_REQUEST':
      return true;
    
    default:
      return false;
  }
}
