import { AgentTool, ToolResult, fail, ok } from './types.js';
import { loadBusinessRules } from './business-rules.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { BusinessEvent, WaitlistEntry } from '../../types/index.js';
import {
  describeScheduledAtUtc,
  nowInBuenosAires,
  utcIsoToBaParts,
  describeBaDateKey,
} from '../../utils/reservation-datetime.js';
import * as templates from '../../utils/message-templates.js';
import { logEvent, logger } from '../../utils/logger.js';

/**
 * Herramientas que escriben en la base.
 *
 * Regla que las separa de las de disponibilidad: nada acá "decide" si algo se
 * puede — para cuando se llama a `create_reservation`, la fecha ya pasó por
 * `check_availability`. Igual se revalida antes de escribir, porque entre una
 * llamada y otra pueden pasar segundos y el comercio pudo bloquear la fecha.
 * Esa red de seguridad ya existía en `ReservationService.createReservation` y
 * se conserva con el mismo criterio.
 */

const MIN_PARTY_SIZE = 1;
const MAX_PARTY_SIZE = 20;

interface CreateArgs {
  customerName: string;
  customerLastName?: string;
  partySize: number;
  scheduledAt?: string;
  eventId?: string;
}

export const createReservationTool: AgentTool<CreateArgs> = {
  definition: {
    type: 'function',
    function: {
      name: 'create_reservation',
      description:
        'Crea la reserva. Llamala sólo cuando ya tenés nombre, cantidad de personas y — si el cliente eligió ' +
        'día y horario — un scheduledAt que devolvió check_availability. Sin scheduledAt la reserva queda para ' +
        'el turno actual (el cliente viene ahora). Devuelve el mensaje de confirmación ya redactado: no lo reescribas. ' +
        'RESERVA DE EVENTO: si el cliente eligió un evento, pasá su eventId y NO pases scheduledAt — la fecha la ' +
        'fija el evento. Omitir el eventId crea una reserva común y pierde el evento.',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string', description: 'Nombre de pila del cliente.' },
          customerLastName: { type: 'string', description: 'Apellido, sólo si el cliente lo dio.' },
          partySize: {
            type: 'integer',
            description: `Cantidad de personas (entre ${MIN_PARTY_SIZE} y ${MAX_PARTY_SIZE}).`,
          },
          scheduledAt: {
            type: 'string',
            description:
              'Instante ISO UTC devuelto por check_availability. Omitilo para una reserva del turno actual.',
          },
          eventId: {
            type: 'string',
            description:
              'Id del evento cuando el cliente eligió uno (de list_events o show_event_details). ' +
              'Obligatorio para una reserva de evento: sin esto queda como reserva común.',
          },
        },
        required: ['customerName', 'partySize'],
        additionalProperties: false,
      },
    },
  },

  async run(args, ctx): Promise<ToolResult> {
    const { customerName, customerLastName, partySize, scheduledAt, eventId } = args;

    if (!customerName?.trim()) {
      return fail('missing_name', 'Falta el nombre del cliente. Preguntáselo antes de crear la reserva.');
    }

    if (!Number.isInteger(partySize) || partySize < MIN_PARTY_SIZE || partySize > MAX_PARTY_SIZE) {
      return fail(
        'invalid_party_size',
        `La cantidad de personas debe estar entre ${MIN_PARTY_SIZE} y ${MAX_PARTY_SIZE}. Confirmá el número con el cliente.`
      );
    }

    // Una reserva activa por cliente: si ya tiene una, no se crea otra en
    // silencio — el modelo debe ofrecerle modificar la que tiene.
    const existing = await SupabaseService.getActiveReservationsByPhone(ctx.phone, ctx.businessId);
    if (existing.length > 0) {
      return fail(
        'already_has_active_reservation',
        'El cliente ya tiene una reserva activa. No crees otra: ofrecele modificar o cancelar la existente.'
      );
    }

    // Reserva de evento: la fecha SIEMPRE sale del evento, nunca del modelo.
    //
    // El modelo tiende a tratar un evento como una reserva común — resolver una
    // fecha con check_availability y mandar ese scheduledAt — y así se perdía la
    // asociación. Acá se ignora lo que haya mandado y se toma `startsAt` real
    // del evento, que es lo mismo que hacía `applyEventChoice` en v1. Si el
    // evento no existe se corta: es preferible a crear una reserva común
    // silenciosamente cuando el cliente pidió un evento.
    let effectiveScheduledAt = scheduledAt ?? null;
    let event: BusinessEvent | undefined;

    if (eventId) {
      const events = await SupabaseService.getActiveEvents(ctx.businessId);
      event = events.find((e) => e.id === eventId);

      if (!event) {
        return fail(
          'event_not_available',
          'Ese evento ya no está disponible. Avisale al cliente y ofrecele los que sí están, o una reserva común.'
        );
      }

      effectiveScheduledAt = event.startsAt;
    }

    if (ctx.dryRun) {
      // Modo sombra: se simula el alta para que el modelo cierre el turno igual
      // y el resultado sea comparable, pero no se toca la base.
      logger.debug('create_reservation skipped (dry run)', { conversationId: ctx.conversationId });
      return ok({
        reservationId: 'dry-run',
        displayCode: 'DRYRUN',
        partySize,
        whenLabel: effectiveScheduledAt ?? 'turno actual',
        status: 'WAITING',
        eventId: eventId ?? null,
        dryRun: true,
      });
    }

    const response = await SupabaseService.createReservation({
      businessId: ctx.businessId,
      customerName: customerName.trim(),
      customerLastName: customerLastName?.trim() || null,
      customerPhone: ctx.phone,
      partySize,
      scheduledAt: effectiveScheduledAt,
      eventId: eventId ?? null,
      source: 'AI_CHAT',
    });

    if (!response.success || !response.waitlistEntry) {
      // `blockedMessage` ya viene redactado para el cliente por la red de
      // seguridad de fechas bloqueadas — se manda literal.
      if (response.blockedMessage) {
        return {
          ok: false,
          error: {
            code: 'blocked_on_create',
            hint: 'La fecha quedó bloqueada. Ya se le explicó al cliente; ofrecele otra fecha.',
          },
          verbatim: response.blockedMessage,
        };
      }
      return fail(
        'create_failed',
        `No se pudo crear la reserva (${response.error ?? 'error desconocido'}). Pedile disculpas y sugerile reintentar.`
      );
    }

    const entry = response.waitlistEntry;
    const nowBA = nowInBuenosAires();
    const whenLabel = entry.scheduled_at
      ? describeScheduledAtUtc(entry.scheduled_at, nowBA)
      : templates.instantTurnLabel();

    const fullName = [customerName.trim(), customerLastName?.trim()].filter(Boolean).join(' ');
    // El evento ya se resolvió arriba, así que no hace falta volver a pedir el título.
    const eventTitle = event?.title ?? null;

    // Un evento siempre queda pendiente de aprobación del comercio, así que el
    // mensaje es distinto: "recibida" en vez de "confirmada".
    const confirmation = eventId
      ? templates.reservationReceived(
          customerName.trim(),
          partySize,
          whenLabel,
          entry.display_code ?? '',
          fullName,
          eventTitle
        )
      : templates.reservationConfirmed(
          customerName.trim(),
          partySize,
          whenLabel,
          entry.display_code ?? '',
          fullName,
          eventTitle
        );

    logEvent('info', 'reservation.created', {
      conversationId: ctx.conversationId,
      businessId: ctx.businessId,
      reservationId: entry.id,
      partySize,
      scheduledAt: entry.scheduled_at,
      via: 'agent_v2',
    });

    return ok(
      {
        reservationId: entry.id,
        displayCode: entry.display_code,
        partySize,
        whenLabel,
        status: entry.status,
      },
      confirmation
    );
  },
};

export const listMyReservationsTool: AgentTool<Record<string, never>> = {
  definition: {
    type: 'function',
    function: {
      name: 'list_my_reservations',
      description:
        'Lista las reservas activas del cliente que está escribiendo. Usala antes de modificar o cancelar ' +
        '(para saber cuál es), y cuando el cliente pregunta por sus reservas.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },

  async run(_args, ctx): Promise<ToolResult> {
    const reservations = await SupabaseService.getActiveReservationsByPhone(ctx.phone, ctx.businessId);
    const nowBA = nowInBuenosAires();

    if (reservations.length === 0) {
      return ok({ reservations: [], note: 'El cliente no tiene ninguna reserva activa.' });
    }

    return ok({
      reservations: await Promise.all(
        reservations.map(async (r: WaitlistEntry) => ({
          reservationId: r.id,
          displayCode: r.display_code,
          partySize: r.party_size,
          status: r.status,
          whenLabel: r.scheduled_at
            ? describeScheduledAtUtc(r.scheduled_at, nowBA)
            : templates.instantTurnLabel(),
          eventTitle: r.event_id ? await SupabaseService.getEventTitle(r.event_id) : null,
        }))
      ),
    });
  },
};

interface CancelArgs {
  reservationId: string;
}

export const cancelReservationTool: AgentTool<CancelArgs> = {
  definition: {
    type: 'function',
    function: {
      name: 'cancel_reservation',
      description:
        'Cancela una reserva del cliente. Obtené el reservationId con list_my_reservations. ' +
        'Confirmá con el cliente cuál quiere cancelar si tiene más de una. Devuelve el mensaje ya redactado.',
      parameters: {
        type: 'object',
        properties: {
          reservationId: { type: 'string', description: 'Id devuelto por list_my_reservations.' },
        },
        required: ['reservationId'],
        additionalProperties: false,
      },
    },
  },

  async run({ reservationId }, ctx): Promise<ToolResult> {
    // Se relee la lista del cliente para no cancelar por id una reserva que no
    // le pertenece: el id llega del modelo, así que no es una fuente confiable.
    const own = await SupabaseService.getActiveReservationsByPhone(ctx.phone, ctx.businessId);
    const target = own.find((r: WaitlistEntry) => r.id === reservationId);

    if (!target) {
      return fail(
        'reservation_not_found',
        'Esa reserva no existe o no es de este cliente. Usá list_my_reservations para ver las suyas.'
      );
    }

    if (ctx.dryRun) {
      logger.debug('cancel_reservation skipped (dry run)', { conversationId: ctx.conversationId });
      return ok({ reservationId, cancelled: true, dryRun: true });
    }

    const cancelled = await SupabaseService.updateReservationStatus(reservationId, 'CANCELLED');
    if (!cancelled) {
      return fail('cancel_failed', 'No se pudo cancelar. Pedile disculpas y sugerile reintentar.');
    }

    const nowBA = nowInBuenosAires();
    const whenLabel = target.scheduled_at
      ? describeScheduledAtUtc(target.scheduled_at, nowBA)
      : templates.instantTurnLabel();

    logEvent('info', 'reservation.cancelled', {
      conversationId: ctx.conversationId,
      businessId: ctx.businessId,
      reservationId,
      via: 'agent_v2',
    });

    return ok(
      { reservationId, cancelled: true },
      templates.reservationCancelledInline(whenLabel, target.display_code ?? null)
    );
  },
};

interface ModifyArgs {
  reservationId: string;
  partySize?: number;
  scheduledAt?: string;
}

export const modifyReservationTool: AgentTool<ModifyArgs> = {
  definition: {
    type: 'function',
    function: {
      name: 'modify_reservation',
      description:
        'Cambia la cantidad de personas y/o el día y horario de una reserva existente. ' +
        'Para cambiar el horario, pasá un scheduledAt que haya devuelto check_availability. ' +
        'Obtené el reservationId con list_my_reservations.',
      parameters: {
        type: 'object',
        properties: {
          reservationId: { type: 'string', description: 'Id devuelto por list_my_reservations.' },
          partySize: {
            type: 'integer',
            description: `Nueva cantidad de personas (${MIN_PARTY_SIZE}-${MAX_PARTY_SIZE}). Omitilo si no cambia.`,
          },
          scheduledAt: {
            type: 'string',
            description: 'Nuevo instante ISO UTC de check_availability. Omitilo si no cambia el horario.',
          },
        },
        required: ['reservationId'],
        additionalProperties: false,
      },
    },
  },

  async run({ reservationId, partySize, scheduledAt }, ctx): Promise<ToolResult> {
    if (partySize === undefined && !scheduledAt) {
      return fail('nothing_to_change', 'No se indicó qué cambiar. Preguntale al cliente qué quiere modificar.');
    }

    const own = await SupabaseService.getActiveReservationsByPhone(ctx.phone, ctx.businessId);
    const target = own.find((r: WaitlistEntry) => r.id === reservationId);
    if (!target) {
      return fail(
        'reservation_not_found',
        'Esa reserva no existe o no es de este cliente. Usá list_my_reservations para ver las suyas.'
      );
    }

    if (ctx.dryRun) {
      logger.debug('modify_reservation skipped (dry run)', { conversationId: ctx.conversationId });
      return ok({ reservationId, partySize: partySize ?? target.party_size, dryRun: true });
    }

    if (partySize !== undefined) {
      if (!Number.isInteger(partySize) || partySize < MIN_PARTY_SIZE || partySize > MAX_PARTY_SIZE) {
        return fail(
          'invalid_party_size',
          `La cantidad debe estar entre ${MIN_PARTY_SIZE} y ${MAX_PARTY_SIZE}.`
        );
      }
      const updated = await SupabaseService.updateReservationPartySize(reservationId, partySize);
      if (!updated) return fail('update_failed', 'No se pudo actualizar la cantidad de personas.');
    }

    if (scheduledAt) {
      // Revalidación: el scheduledAt vino del modelo y pudo quedar viejo si la
      // conversación se alargó o si el comercio bloqueó la fecha entretanto.
      const rules = await loadBusinessRules(ctx.businessId);
      if (rules) {
        const { dateKey } = utcIsoToBaParts(scheduledAt);
        if (rules.isBlocked(dateKey)) {
          return {
            ok: false,
            error: {
              code: 'date_blocked',
              hint: 'Esa fecha quedó bloqueada. Ofrecele otra.',
            },
            verbatim: templates.dateBlocked(describeBaDateKey(dateKey, rules.nowBA), null),
          };
        }
      }

      const updated = await SupabaseService.updateReservationSchedule(reservationId, scheduledAt);
      if (!updated) return fail('update_failed', 'No se pudo actualizar el horario.');
    }

    const nowBA = nowInBuenosAires();
    const newWhen = scheduledAt
      ? describeScheduledAtUtc(scheduledAt, nowBA)
      : target.scheduled_at
        ? describeScheduledAtUtc(target.scheduled_at, nowBA)
        : templates.instantTurnLabel();

    logEvent('info', 'reservation.updated', {
      conversationId: ctx.conversationId,
      businessId: ctx.businessId,
      reservationId,
      via: 'agent_v2',
    });

    logger.debug('modify_reservation applied', { reservationId, partySize, scheduledAt });

    return ok({
      reservationId,
      partySize: partySize ?? target.party_size,
      whenLabel: newWhen,
      displayCode: target.display_code,
    });
  },
};
