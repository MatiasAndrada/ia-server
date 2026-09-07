import { AgentTool, ToolResult, fail, ok } from './types.js';
import { loadBusinessRules } from './business-rules.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { describeScheduledAtUtc, nowInBuenosAires } from '../../utils/reservation-datetime.js';
import { formatBusinessAddress, formatWeeklyHoursForPrompt } from '../../utils/prompts.js';
import * as templates from '../../utils/message-templates.js';

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
        'Devuelve TODOS los vigentes: nunca informes disponibilidad ni cupo de un evento.',
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
        hasPhotos: event.imageUrls.length > 0,
      })),
    });
  },
};

interface ShowEventArgs {
  eventId: string;
}

/**
 * Cuando el cliente se interesa por un evento concreto, se le mandan sus fotos.
 *
 * Es una herramienta aparte de `list_events` a propósito — listar cinco eventos
 * no debe disparar quince imágenes; las fotos salen sólo del que el cliente
 * eligió.
 */
export const showEventDetailsTool: AgentTool<ShowEventArgs> = {
  definition: {
    type: 'function',
    function: {
      name: 'show_event_details',
      description:
        'Muestra el detalle de UN evento y le envía sus fotos al cliente. ' +
        'Usala cuando el cliente se interesa por un evento puntual (lo nombra o lo elige de la lista). ' +
        'No la uses para listar varios: para eso está list_events.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Id del evento, obtenido de list_events.' },
        },
        required: ['eventId'],
        additionalProperties: false,
      },
    },
  },

  async run({ eventId }, ctx): Promise<ToolResult> {
    const events = await SupabaseService.getActiveEvents(ctx.businessId);
    const event = events.find((e) => e.id === eventId);

    if (!event) {
      // El comercio pudo desactivarlo entre que se listó y que el cliente eligió.
      return fail(
        'event_not_available',
        'Ese evento ya no está disponible. Avisale al cliente y ofrecele los que sí están.'
      );
    }

    const nowBA = nowInBuenosAires();

    // Si el local autoacepta este evento y todavía entra gente, la reserva va a
    // nacer confirmada; si no, queda pendiente. Se expone el QUÉ, nunca el
    // PORQUÉ: el cupo es información interna y al cliente no se le menciona.
    const isFull = event.capacity !== null && event.occupiedGuests >= event.capacity;
    const requiresApproval = !event.autoAccept || isFull;

    return {
      ok: true,
      data: {
        eventId: event.id,
        title: event.title,
        description: event.description,
        whenLabel: describeScheduledAtUtc(event.startsAt, nowBA),
        // El modelo no debe prometer una confirmación inmediata cuando esto es
        // true. Nunca expliques el motivo: no se habla del cupo.
        requiresApproval,
        // Instrucción explícita en el resultado, no sólo en el system prompt:
        // el modelo la tiene delante justo cuando va a decidir el próximo paso.
        howToReserve:
          `Para reservar ESTE evento llamá a create_reservation con eventId: "${event.id}". ` +
          'NO uses resolve_date ni check_availability: la fecha la fija el evento. ' +
          'NO pases scheduledAt. Si omitís el eventId se crea una reserva común y se pierde el evento.',
      },
      // El detalle sale como texto fijo y no redactado por el modelo: el cliente
      // acaba de decir "me interesa" y lo que necesita es qué es, cuándo es y las
      // fotos — no una pregunta suelta por la cantidad de personas. El handler
      // manda primero los adjuntos, así que el bloque queda fotos → detalle.
      verbatim: templates.eventSelected(
        event.title,
        event.description,
        describeScheduledAtUtc(event.startsAt, nowBA)
      ),
      // Máximo 3: más que eso satura el chat. La primera lleva el título como
      // caption, porque llega antes que el texto.
      attachments: event.imageUrls.slice(0, 3).map((imageUrl, index) => ({
        imageUrl,
        ...(index === 0 ? { caption: `🎉 *${event.title}*` } : {}),
      })),
    };
  },
};
