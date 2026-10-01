import { AgentTool, ToolResult, fail, ok } from './types.js';
import { findSharedNumberAdaptation, handOffWithoutReply } from '../../adaptations/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Herramienta de los locales de número compartido (ver src/adaptations/):
 * deja el chat en manos de la persona del local y cierra el turno sin
 * responder nada.
 *
 * Existe para lo que las palabras del menú no atrapan. El amigo que escribe
 * "holaa simo todo bien?", el empleado que avisa que mañana falta, el
 * proveedor que ofrece mercadería: ninguno escribe PERSONAL, y antes el modelo
 * le contestaba a cada uno pidiéndoselo — el bot metiéndose en una charla
 * ajena, que es lo que hacía que los locales lo apagaran.
 *
 * Sólo se le ofrece al modelo cuando el comercio tiene una adaptación (ver
 * `getToolDefinitions`): en un número que atiende sólo el bot no hay a quién
 * derivar, y el cliente quedaría hablándole a la nada. El orquestador reconoce
 * la llamada y descarta cualquier texto del turno (ver `handedOff` en
 * orchestrator.ts), así que el modelo no puede "despedirse" por más que lo
 * intente.
 */
export const HAND_OFF_TO_HUMAN = 'hand_off_to_human';

const REASONS = ['personal', 'business', 'asks_for_person', 'other'] as const;

interface HandOffArgs {
  reason?: (typeof REASONS)[number];
}

export const handOffToHumanTool: AgentTool<HandOffArgs> = {
  definition: {
    type: 'function',
    function: {
      name: HAND_OFF_TO_HUMAN,
      description:
        'Deja esta conversación en manos de la persona del local que comparte el número y cierra ' +
        'el turno SIN responder: quien escribió no recibe nada del asistente. Usala cuando el ' +
        'mensaje no es para el asistente de reservas (ver "Este número también lo atiende una ' +
        'persona"). Después de llamarla no escribas nada: el texto no se envía.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: [...REASONS],
            description:
              'personal: le habla a la persona por su nombre o como a un conocido, o es un tema ' +
              'personal. business: empleados, proveedores, pagos, trámites u otro negocio. ' +
              'asks_for_person: pide hablar con una persona. other: cualquier otro caso.',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },

  async run({ reason }, ctx): Promise<ToolResult> {
    const adaptation = findSharedNumberAdaptation(ctx.businessId);
    if (!adaptation) {
      return fail(
        'no_human_on_this_number',
        'En este local nadie más atiende el chat: seguí atendiendo vos.'
      );
    }

    const validReason = reason && (REASONS as readonly string[]).includes(reason) ? reason : 'other';

    if (ctx.dryRun) {
      logger.debug('hand_off_to_human skipped (dry run)', {
        conversationId: ctx.conversationId,
        reason: validReason,
      });
      return ok({ handedOff: true, dryRun: true });
    }

    await handOffWithoutReply(adaptation, ctx.conversationId, validReason);
    return ok({ handedOff: true });
  },
};
