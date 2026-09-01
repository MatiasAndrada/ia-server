import { LlmToolDefinition } from '../types/index.js';

/**
 * Tool used to give the deterministic reservation flow (whatsapp-handler.service.ts)
 * an LLM-powered second look at a message the regex-based parsers in that same
 * file couldn't make sense of (no name found, no valid party size, no parseable
 * date/time, invalid menu choice, etc.) — see reservation-nlu.service.ts.
 *
 * All fields are optional and raw/uninterpreted on purpose: the model only
 * segments the message ("this part is a date reference", "this part is a
 * name"), it never computes actual dates or validates business rules. The
 * existing deterministic parsers (parseRelativeDay, parseTimeOfDay, the
 * party-size bounds check, etc.) still do all interpretation and validation,
 * exactly as they do today for the regex path.
 */
export function buildReservationSlotsTool(): LlmToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'update_reservation',
      description:
        'Registra los datos de la reserva que el cliente mencionó en este mensaje. ' +
        'Completá solo los campos que el mensaje realmente menciona; no inventes ni asumas datos ausentes. ' +
        'Para fecha y horario, devolvé el texto tal cual lo dijo el cliente (no calcules la fecha vos).',
      parameters: {
        type: 'object',
        properties: {
          customerName: {
            type: 'string',
            description: 'Nombre del cliente, tal cual lo escribió (sin saludos ni frases alrededor).',
          },
          nameLooksInvalid: {
            type: 'boolean',
            description:
              'true si customerName es claramente ofensivo, un insulto o no es un nombre de persona real.',
          },
          partySizeText: {
            type: 'string',
            description: 'Mención cruda de la cantidad de personas (ej. "4", "somos cuatro").',
          },
          scheduleChoice: {
            type: 'string',
            enum: ['today', 'other_day'],
            description: 'Si el cliente eligió el turno actual/hoy, o prefiere otro día.',
          },
          dateText: {
            type: 'string',
            description: 'Mención cruda de una fecha/día (ej. "el viernes", "mañana", "pasado mañana").',
          },
          timeText: {
            type: 'string',
            description: 'Mención cruda de un horario (ej. "a las 9", "21:00", "9 y media").',
          },
          confirmation: {
            type: 'string',
            enum: ['yes', 'no'],
            description: 'Respuesta afirmativa o negativa a una confirmación sí/no.',
          },
          menuChoice: {
            type: 'integer',
            description: 'Número de opción elegido en un menú (1, 2, 3...).',
          },
          wantsToCancel: {
            type: 'boolean',
            description: 'true si el cliente quiere cancelar la reserva.',
          },
          wantsToModify: {
            type: 'string',
            enum: ['party_size', 'date', 'time'],
            description: 'Campo que el cliente quiere modificar de una reserva existente.',
          },
          offTopic: {
            type: 'boolean',
            description: 'true si el mensaje no tiene relación alguna con hacer/modificar/cancelar una reserva.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
}
