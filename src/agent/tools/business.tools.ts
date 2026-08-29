import { AgentTool, ToolResult, fail, ok } from './types.js';
import { loadBusinessRules } from './business-rules.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { describeScheduledAtUtc, nowInBuenosAires } from '../../utils/reservation-datetime.js';
import { formatBusinessAddress, formatWeeklyHoursForPrompt } from '../../utils/prompts.js';

/**
 * Herramientas de consulta sobre el comercio.
 *
 * Existen para que el modelo nunca invente datos del local. La dirección, los
 * horarios y los eventos salen siempre de la base — si el modelo no llamó a
 * estas herramientas, el system prompt le prohíbe afirmar nada al respecto.
 */

export const getBusinessInfoTool: AgentTool<Record<string, never>> = {
  definition: {
    type: 'function',
    function: {
      name: 'get_business_info',
      description:
        'Datos del local: nombre, dirección, descripción y horarios de la semana. ' +
        'Usala ante cualquier pregunta sobre dónde queda, cuándo abre o qué es el lugar. ' +
        'Nunca inventes estos datos: si no llamaste a esta herramienta, decí que vas a verificar.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },

  async run(_args, ctx): Promise<ToolResult> {
    const rules = await loadBusinessRules(ctx.businessId);
    if (!rules) return fail('business_not_found', 'No se pudo leer la información del local.');

    const { business } = rules;

    return ok({
      name: business.name,
      address: formatBusinessAddress(business.address, business.city) ?? null,
      description: business.description ?? null,
      weeklyHours: formatWeeklyHoursForPrompt(rules.weeklyHours) ?? null,
    });
  },
};

export const listEventsTool: AgentTool<Record<string, never>> = {
  definition: {
    type: 'function',
    function: {
      name: 'list_events',
      description:
        'Lista los eventos vigentes del local (cenas temáticas, shows, fechas especiales). ' +
        'Usala cuando el cliente pregunta por eventos o nombra algo que suena a uno. ' +
        'Una reserva de evento siempre queda pendiente de aprobación del local.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },

  async run(_args, ctx): Promise<ToolResult> {
    const events = await SupabaseService.getActiveEvents(ctx.businessId);
    const nowBA = nowInBuenosAires();

    if (events.length === 0) {
      return ok({ events: [], note: 'El local no tiene eventos publicados en este momento.' });
    }

    return ok({
      events: events.map((event) => ({
        eventId: event.id,
        title: event.title,
        description: event.description,
        whenLabel: describeScheduledAtUtc(event.startsAt, nowBA),
      })),
    });
  },
};
