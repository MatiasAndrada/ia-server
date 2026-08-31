import { AgentTool, ToolResult, fail, ok } from './types.js';
import { loadBusinessRules } from './business-rules.js';
import {
  checkBusinessHours,
  combineToUtcISO,
  describeBaDateKey,
  findSoonestBookableSlot,
  findNextSlotOnDay,
  formatBaDateKey,
  formatDayHoursForDate,
  getBlockedDateReasonMessage,
  getUpcomingOpenDaysWithHours,
  isFutureReservationBlockedToday,
  isInPast,
  isWithinBookingWindow,
  parseBaDateKey,
  parseRelativeDay,
  parseTimeOfDay,
} from '../../utils/reservation-datetime.js';
import * as templates from '../../utils/message-templates.js';
import { logger } from '../../utils/logger.js';

/**
 * Herramientas de disponibilidad.
 *
 * Acá vive la parte del dominio que el modelo NO puede decidir: qué día es
 * "el jueves", si esa fecha entra en la ventana de 30 días, si el comercio abre,
 * si la fecha está bloqueada. El modelo aporta la comprensión (qué quiso decir
 * el cliente) y estas herramientas aportan el veredicto.
 *
 * Todas devuelven texto crudo del cliente como entrada (`dateText`, `timeText`)
 * en vez de fechas ya calculadas: si el modelo calculara la fecha, un error
 * suyo se volvería una reserva mal creada. El parser determinista
 * (`parseRelativeDay` / `parseTimeOfDay`) es el mismo que usa el flujo v1.
 */

interface ResolveDateArgs {
  dateText: string;
}

export const resolveDateTool: AgentTool<ResolveDateArgs> = {
  definition: {
    type: 'function',
    function: {
      name: 'resolve_date',
      description:
        'Convierte una mención de fecha del cliente ("mañana", "el viernes", "hoy", "pasado mañana", ' +
        '"el jueves que viene", "15/09") en una fecha concreta, y valida que sea reservable. ' +
        'Usala SIEMPRE antes de dar por buena una fecha: no calcules vos la fecha ni asumas que el local abre. ' +
        'Si la fecha es ambigua o está fuera de la ventana de 30 días, te lo indica para que se lo consultes al cliente.',
      parameters: {
        type: 'object',
        properties: {
          dateText: {
            type: 'string',
            description: 'La mención de fecha tal cual la escribió el cliente, sin interpretar.',
          },
        },
        required: ['dateText'],
        additionalProperties: false,
      },
    },
  },

  async run({ dateText }, ctx): Promise<ToolResult> {
    const rules = await loadBusinessRules(ctx.businessId);
    if (!rules) return fail('business_not_found', 'No se pudo leer la configuración del local.');

    const parsed = parseRelativeDay(dateText ?? '', rules.nowBA);
    if (!parsed) {
      return fail(
        'unparseable_date',
        'No se entendió a qué día se refiere. Pedile que lo diga de otra forma (ej. "mañana", "el viernes").'
      );
    }

    const dateKey = formatBaDateKey(parsed.baDate);

    // Ventana de 30 días: regla dura del producto, no negociable por el modelo.
    if (!isWithinBookingWindow(parsed.baDate, rules.nowBA)) {
      return fail(
        'out_of_window',
        'Esa fecha está fuera de la ventana de reservas: sólo se puede reservar dentro de los próximos 30 días.'
      );
    }

    if (rules.isBlocked(dateKey)) {
      // El motivo lo redactó el comercio (o se generó por IA al bloquear la
      // fecha) y se envía literal — no es del modelo reformularlo.
      const reason = getBlockedDateReasonMessage(dateKey, rules.blockedDates);
      return {
        ok: false,
        error: {
          code: 'date_blocked',
          hint: 'Ese día el local no toma reservas. Ya se le explicó el motivo al cliente; ofrecele otra fecha.',
        },
        verbatim: templates.dateBlocked(describeBaDateKey(dateKey, rules.nowBA), reason),
      };
    }

    // "El jueves" dicho un jueves es genuinamente ambiguo: puede ser hoy o el
    // de la semana que viene. No se resuelve por defecto — se le devuelve la
    // ambigüedad al modelo para que pregunte, que es exactamente el caso que
    // en v1 requería el campo `pendingWeekdayDisambiguation` en el draft.
    const ambiguous = parsed.matchedWeekdayName && parsed.isToday;

    const hours = formatDayHoursForDate(parsed.baDate, rules.weeklyHours);

    return ok({
      dateKey,
      label: parsed.label,
      isToday: parsed.isToday,
      ambiguous,
      ambiguityNote: ambiguous
        ? `El cliente nombró "${parsed.label}", que es hoy mismo. Preguntale si se refiere a hoy o al de la semana que viene antes de seguir.`
        : undefined,
      openingHours: hours,
    });
  },
};

interface CheckAvailabilityArgs {
  dateKey: string;
  timeText?: string;
  partySize?: number;
}

export const checkAvailabilityTool: AgentTool<CheckAvailabilityArgs> = {
  definition: {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        'Verifica si el local puede tomar una reserva en una fecha y horario concretos. ' +
        'Llamala antes de confirmar cualquier horario. Si el horario no sirve, devuelve la alternativa más cercana ' +
        'para que se la propongas al cliente. Requiere una dateKey obtenida antes con resolve_date.',
      parameters: {
        type: 'object',
        properties: {
          dateKey: {
            type: 'string',
            description: 'Fecha en formato YYYY-MM-DD, tal como la devolvió resolve_date.',
          },
          timeText: {
            type: 'string',
            description:
              'Horario tal cual lo dijo el cliente ("a las 9", "21:00", "9 y media de la noche"). ' +
              'Omitilo para preguntar sólo si el día tiene algún horario disponible.',
          },
          partySize: {
            type: 'integer',
            description: 'Cantidad de personas, si ya se sabe.',
          },
        },
        required: ['dateKey'],
        additionalProperties: false,
      },
    },
  },

  async run({ dateKey, timeText }, ctx): Promise<ToolResult> {
    const rules = await loadBusinessRules(ctx.businessId);
    if (!rules) return fail('business_not_found', 'No se pudo leer la configuración del local.');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey ?? '')) {
      return fail('invalid_date_key', 'La fecha debe venir de resolve_date, en formato YYYY-MM-DD.');
    }

    const baDate = parseBaDateKey(dateKey);

    if (rules.isBlocked(dateKey)) {
      return {
        ok: false,
        error: {
          code: 'date_blocked',
          hint: 'Ese día el local no toma reservas. Ya se le explicó el motivo; ofrecele otra fecha.',
        },
        verbatim: templates.dateBlocked(
          describeBaDateKey(dateKey, rules.nowBA),
          getBlockedDateReasonMessage(dateKey, rules.blockedDates)
        ),
      };
    }

    // Sin horario: sólo se informa si el día es viable y desde cuándo.
    if (!timeText?.trim()) {
      const nextSlot = findNextSlotOnDay(baDate, 0, rules.weeklyHours, rules.openingMargin, rules.closingMargin);
      if (!nextSlot) {
        return fail('day_closed', `El local no abre ese día. Ofrecele otra fecha.`);
      }
      return ok({
        dateKey,
        available: true,
        openingHours: formatDayHoursForDate(baDate, rules.weeklyHours),
        earliestSlot: `${String(nextSlot.hour).padStart(2, '0')}:${String(nextSlot.minute).padStart(2, '0')}`,
      });
    }

    const parsedTime = parseTimeOfDay(timeText);
    if (!parsedTime) {
      return fail(
        'unparseable_time',
        'No se entendió el horario. Pedile que lo diga de otra forma (ej. "21:00", "a las 9 de la noche").'
      );
    }

    const { hour, minute } = parsedTime;
    const verdict = checkBusinessHours(
      baDate,
      hour,
      minute,
      rules.weeklyHours,
      rules.closingMargin,
      rules.openingMargin
    );

    if (!verdict.allowed) {
      // Se busca la alternativa más cercana ese mismo día para que el modelo
      // proponga algo concreto en vez de un "no se puede" seco.
      const alternative = findNextSlotOnDay(
        baDate,
        hour * 60 + minute,
        rules.weeklyHours,
        rules.openingMargin,
        rules.closingMargin
      );

      return {
        ok: false,
        error: {
          code: 'outside_hours',
          hint: alternative
            ? `Ese horario no entra (${verdict.reason ?? 'fuera del horario de atención'}). Proponele las ${String(alternative.hour).padStart(2, '0')}:${String(alternative.minute).padStart(2, '0')} de ese mismo día.`
            : `Ese horario no entra (${verdict.reason ?? 'fuera del horario de atención'}) y no queda ningún otro horario ese día. Ofrecele otra fecha.`,
        },
        data: {
          openingHours: formatDayHoursForDate(baDate, rules.weeklyHours),
          suggestedAlternative: alternative
            ? { hour: alternative.hour, minute: alternative.minute, dateKey }
            : null,
        },
      } as ToolResult;
    }

    const scheduledAt = combineToUtcISO(baDate, hour, minute);

    // Horario ya pasado: `checkBusinessHours` sólo mira el horario de atención,
    // no la hora actual, así que "hoy a las 21" cuando ya son las 22 pasa esa
    // validación igual. Se detecta acá aparte para no confundir el mensaje
    // ("fuera de horario") con el real ("esa hora ya fue").
    if (isInPast(scheduledAt)) {
      const nowMin = rules.nowBA.getUTCHours() * 60 + rules.nowBA.getUTCMinutes();
      const alternative = findNextSlotOnDay(
        baDate,
        nowMin,
        rules.weeklyHours,
        rules.openingMargin,
        rules.closingMargin
      );

      return {
        ok: false,
        error: {
          code: 'time_already_passed',
          hint: alternative
            ? `Esa hora ya pasó hoy. Avisale al cliente y proponele las ${String(alternative.hour).padStart(2, '0')}:${String(alternative.minute).padStart(2, '0')} de hoy, o preguntale si prefiere otro día.`
            : `Esa hora ya pasó hoy y no queda otro horario disponible hoy. Avisale al cliente y ofrecele otra fecha.`,
        },
        data: {
          suggestedAlternative: alternative
            ? { hour: alternative.hour, minute: alternative.minute, dateKey }
            : null,
        },
      } as ToolResult;
    }

    // Bloqueo de reservas futuras para hoy: el comercio puede cortar la toma
    // de reservas del día en curso sin bloquear la fecha entera.
    if (
      isFutureReservationBlockedToday(
        dateKey,
        hour,
        minute,
        rules.nowBA,
        rules.business.future_reservations_blocked_for_date,
        rules.weeklyHours,
        rules.closingMargin
      )
    ) {
      return {
        ok: false,
        error: {
          code: 'future_reservations_blocked_today',
          hint: 'Hoy el local no está tomando reservas anticipadas. Ya se le explicó; ofrecele otro día.',
        },
        verbatim: templates.futureReservationsBlockedToday(),
      };
    }

    return ok({
      dateKey,
      hour,
      minute,
      scheduledAt,
      available: true,
      label: describeBaDateKey(dateKey, rules.nowBA),
    });
  },
};

export const findSoonestSlotTool: AgentTool<Record<string, never>> = {
  definition: {
    type: 'function',
    function: {
      name: 'find_soonest_slot',
      description:
        'Devuelve el horario reservable más próximo disponible. Usala cuando el cliente pide "lo antes posible", ' +
        '"cuando haya lugar", o cuando su horario preferido no sirve y no tenés una alternativa para ofrecerle.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },

  async run(_args, ctx): Promise<ToolResult> {
    const rules = await loadBusinessRules(ctx.businessId);
    if (!rules) return fail('business_not_found', 'No se pudo leer la configuración del local.');

    const slot = findSoonestBookableSlot(rules.nowBA, rules.weeklyHours, rules.openingMargin, rules.closingMargin, {
      isDateBlocked: rules.isBlocked,
    });

    if (!slot) {
      return fail(
        'no_slot_available',
        'No hay ningún horario disponible en los próximos 30 días. Sugerile contactar al local directamente.'
      );
    }

    const dateKey = formatBaDateKey(slot.baDate);
    logger.debug('find_soonest_slot resolved', { businessId: ctx.businessId, dateKey, hour: slot.hour });

    return ok({
      dateKey,
      hour: slot.hour,
      minute: slot.minute,
      label: describeBaDateKey(dateKey, rules.nowBA),
      scheduledAt: combineToUtcISO(slot.baDate, slot.hour, slot.minute),
    });
  },
};

export const listOpenDaysTool: AgentTool<Record<string, never>> = {
  definition: {
    type: 'function',
    function: {
      name: 'list_open_days',
      description:
        'Lista los próximos días en que el local abre y toma reservas, con sus horarios. ' +
        'Usala cuando el cliente pregunta "¿qué días abren?" o cuando hay que ofrecerle alternativas.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },

  async run(_args, ctx): Promise<ToolResult> {
    const rules = await loadBusinessRules(ctx.businessId);
    if (!rules) return fail('business_not_found', 'No se pudo leer la configuración del local.');

    const days = getUpcomingOpenDaysWithHours(
      rules.weeklyHours,
      rules.nowBA,
      rules.isBlocked,
      rules.openingMargin,
      rules.closingMargin,
      7
    );

    if (days.length === 0) {
      return fail('no_open_days', 'No hay días disponibles en la próxima semana.');
    }

    return ok({ days });
  },
};
