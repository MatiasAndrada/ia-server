/**
 * Catálogo español (idioma por defecto y fuente de verdad de la forma del tipo).
 *
 * `MessageCatalog` se deriva de este objeto (`typeof esCatalog`), así que los
 * demás idiomas están obligados en compile-time a implementar todas las claves
 * con la misma firma. Agregar un template acá rompe la compilación de en.ts y
 * pt.ts hasta que se traduzca — que es exactamente lo que queremos.
 *
 * Los textos corresponden a los módulos M1..M12 del Manual Conversacional Nubotik.
 */

import { LANGUAGE_MENU_ORDER, LANGUAGE_NATIVE_NAMES } from '../languages.js';

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

/**
 * Filas del menú de idiomas, compartidas por los tres catálogos (no se
 * traducen: cada idioma se nombra a sí mismo). Sin bandera: el idioma se
 * infiere de una bandera recibida, pero no se muestran banderas en los
 * mensajes salientes.
 */
export function buildLanguageMenuLines(): string {
  return LANGUAGE_MENU_ORDER.map(
    (language, index) => `${NUMBER_EMOJI[index]} ${LANGUAGE_NATIVE_NAMES[language]}`
  ).join('\n');
}

/**
 * `checkBusinessHours` puede no devolver motivo. Antes se interpolaba directo y
 * el cliente llegaba a ver literalmente "❌ undefined"; estos helpers omiten el
 * motivo cuando no existe.
 */
function prefix(reason?: string): string {
  return reason ? `${reason} ` : '';
}

function prefixBlock(reason?: string): string {
  return reason ? `${reason}\n\n` : '';
}

export const esCatalog = {
  // ============================
  // M0 — Selección de idioma
  // ============================

  languageWelcomeMenu(businessName: string): string {
    return (
      `🌎 ¡Bienvenido a *${businessName}*!\n\n` +
      `¿En qué idioma te acompañamos con tu reserva?\n\n` +
      `${buildLanguageMenuLines()}\n\n` +
      `Respondé con el *número* del idioma que preferís, o seguí escribiendo y te atiendo en tu idioma.`
    );
  },

  languageChanged(): string {
    return `✅ ¡Listo! Seguimos en español.`;
  },

  /** Línea corta que se anexa al saludo de clientes recurrentes. */
  languageChangeHint(): string {
    return `_🌐 Para cambiar de idioma, escribí el nombre del idioma o mandá una bandera._`;
  },

  /** Etiqueta de "reserva para el turno en curso" (sin fecha/hora puntual). */
  instantTurnLabel(): string {
    return `Hoy (turno actual)`;
  },

  // ============================
  // M1 — Nueva reserva
  // ============================

  welcomeMessage(businessName: string): string {
    return (
      `👋 ¡Hola!\n` +
      `Soy el asistente de reservas de *${businessName}*.\n` +
      `Voy a ayudarte a reservar tu mesa en pocos segundos.\n\n` +
      `¿Cómo te llamás? Decime tu *nombre y apellido*.`
    );
  },

  askPartySize(name: string): string {
    return (
      `✅ Perfecto, *${name}*.\n\n` +
      `¿Para cuántas personas es la reserva?\n\n` +
      `Ejemplo: 2, 4 o 6 personas.`
    );
  },

  welcomeBackAskPartySize(customerName: string): string {
    return (
      `👋 ¡Hola ${customerName}!\n\n` +
      `¿Para cuántas personas es la reserva?\n\n` +
      `Ejemplo: 2, 4 o 6 personas.`
    );
  },

  askScheduleChoice(): string {
    return (
      `📅 ¿La reserva es para...?\n\n` +
      `1️⃣ Hoy (turno actual)\n` +
      `2️⃣ Otra fecha\n\n` +
      `Respondé con el *número* de la opción, o directamente decime el día (ej: "el viernes").`
    );
  },

  askDayClosedToday(openDays?: string | null): string {
    if (openDays) {
      return (
        `❌ Hoy el local está cerrado.\n\n` +
        `📅 ¿Qué día preferís?\n` +
        `Estamos abiertos los: *${openDays}*.\n\n` +
        `Podés decir "mañana", "el viernes", etc.`
      );
    }
    return (
      `❌ Hoy el local está cerrado.\n\n` +
      `📅 ¿Qué día preferís? Podés decir "mañana", "el viernes", etc.`
    );
  },

  askDayClosedTodayWithSchedule(dayLines: string[]): string {
    if (dayLines.length === 0) {
      return (
        `⛔ Hoy está cerrado y no encontré disponibilidad en los próximos 7 días.\n\n` +
        `Escribinos más adelante para coordinar tu reserva.`
      );
    }
    const list = dayLines.join('\n');
    return (
      `⛔ Hoy está cerrado.\n\n` +
      `📅 ¿Para cuál de estos días querés la reserva?\n\n` +
      `${list}\n\n` +
      `Respondé con el día que preferís (ej: "jueves" o "jueves 09:15").`
    );
  },

  askDay(openDays?: string | null): string {
    if (openDays) {
      return (
        `📅 ¿Qué día preferís?\n` +
        `Estamos abiertos los: *${openDays}*.\n\n` +
        `Podés decir "mañana", "el viernes", etc.`
      );
    }
    return `📅 ¿Qué día preferís? Podés decir "mañana", "el viernes", etc.`;
  },

  otherDaysSchedule(dayLines: string[]): string {
    if (dayLines.length === 0) {
      return '📅 Por ahora no tengo más días con disponibilidad para mostrarte.';
    }
    const list = dayLines.map((line) => `• ${line}`).join('\n');
    return `📅 Estos son los horarios de los próximos días:\n\n${list}`;
  },

  askTime(dayLabel: string, hoursRange?: string | null): string {
    const hoursNote = hoursRange ? ` (horario: *${hoursRange}*)` : '';
    return `🕐 ¿A qué hora te gustaría reservar para el ${dayLabel}${hoursNote}?`;
  },

  askTodayTimeOpen(closeLabel: string | null): string {
    const closingNote = closeLabel ? ` (el local está abierto hasta las *${closeLabel}*)` : '';
    return (
      `🕐 ¿A qué hora te gustaría la reserva de hoy?${closingNote}\n\n` +
      `Escribí el horario (ej: "21:00" o "9 y media"), o respondé *ahora* si la querés para el turno actual.`
    );
  },

  reservationSummary(
    name: string,
    partySize: number,
    whenLabel: string,
    fullName: string = name
  ): string {
    return (
      `📋 Antes de confirmar, verificá que los datos sean correctos:\n\n` +
      `👤 Nombre: ${fullName}\n` +
      `👥 Personas: ${partySize}\n` +
      `📅 Fecha y hora: ${whenLabel}\n\n` +
      `¿Está todo correcto?\n\n` +
      `1️⃣ Confirmar reserva\n` +
      `2️⃣ Modificar la reserva`
    );
  },

  summaryEditMenu(): string {
    return (
      `¿Qué querés modificar?\n\n` +
      `1️⃣ Cantidad de personas\n` +
      `2️⃣ Fecha\n` +
      `3️⃣ Horario\n\n` +
      `Respondé con el *número* de la opción.`
    );
  },

  reservationConfirmed(
    name: string,
    partySize: number,
    whenLabel: string,
    displayCode: string,
    fullName: string = name
  ): string {
    return (
      `✅ ¡Reserva confirmada!\n\n` +
      `Gracias, *${name}*. Tu reserva fue registrada correctamente.\n\n` +
      `👤 Nombre: ${fullName}\n` +
      `👥 Personas: ${partySize}\n` +
      `📅 Fecha y hora: ${whenLabel}\n` +
      `📁 Código de reserva: *${displayCode}*\n\n` +
      `✨ ¡Te esperamos! Esperamos que disfrutes una excelente experiencia.\n\n` +
      `Si necesitás cancelar, simplemente escribí: *CANCELAR*`
    );
  },

  reservationReceived(
    name: string,
    partySize: number,
    whenLabel: string,
    displayCode: string,
    fullName: string = name
  ): string {
    return (
      `⏳ *Reserva RECIBIDA*\n\n` +
      `👤 Nombre: ${fullName}\n` +
      `👥 Personas: ${partySize}\n` +
      `📅 Fecha y hora: ${whenLabel}\n` +
      `📁 Código: *${displayCode}*\n\n` +
      `⏰ Te notificaremos cuando confirmen tu reserva.\n\n` +
      `Si necesitás cancelar, simplemente escribí: *CANCELAR*`
    );
  },

  // ============================
  // M2 — Modificar una reserva
  // ============================

  editMenu(
    partySize: number,
    whenLabel: string,
    displayCode: string,
    statusLabel: string,
    customerName?: string | null
  ): string {
    const greeting = customerName ? `👋 ¡Hola ${customerName}! ¿Qué necesitás hoy?\n\n` : '';
    return (
      `${greeting}📋 Tenés 1 reserva activa:\n` +
      `• ${partySize} personas, ${whenLabel} (${displayCode}) ${statusLabel}\n\n` +
      `¿Qué querés hacer?\n\n` +
      `1️⃣ Cantidad de personas\n` +
      `2️⃣ Fecha\n` +
      `3️⃣ Horario\n` +
      `4️⃣ Crear otra reserva\n\n` +
      `Respondé con el *número* de la opción.\n\n` +
      `_Para cancelar tu reserva escribí *CANCELAR*._`
    );
  },

  editMenuInvalidChoice(): string {
    return `❌ Por favor respondé con *1*, *2*, *3* o *4* según la opción que elegiste.`;
  },

  partySizeUpdated(partySize: number): string {
    return `✅ ¡Listo! Tu reserva fue actualizada a *${partySize}* personas.`;
  },

  scheduleUpdated(whenLabel: string): string {
    return `✅ ¡Listo! Tu reserva fue actualizada para el ${whenLabel}.`;
  },

  // ============================
  // M3 — Cancelar una reserva
  // ============================

  cancelMenu(partySize: number, whenLabel: string, displayCode: string): string {
    return (
      `📋 Encontré una reserva activa.\n\n` +
      `👥 Personas: *${partySize}*\n` +
      `📅 Fecha y hora: ${whenLabel}\n` +
      `📁 Código: *${displayCode}*\n\n` +
      `¿Qué te gustaría hacer?\n\n` +
      `1️⃣ Reprogramar la reserva\n` +
      `2️⃣ Cancelar definitivamente`
    );
  },

  cancelDirectConfirmPrompt(
    partySize: number,
    whenLabel: string,
    displayCode: string
  ): string {
    return (
      `📋 Encontré tu reserva de *${partySize}* personas para ${whenLabel} (código *${displayCode}*).\n\n` +
      `¿Cancelamos esta reserva?\n\n` +
      `1️⃣ Sí, cancelar\n` +
      `2️⃣ Volver atrás`
    );
  },

  activeReservationsMenu(
    reservations: {
      index: number;
      partySize: number;
      whenLabel: string;
      displayCode: string | null;
      statusLabel: string;
    }[],
    action: 'edit' | 'cancel' | 'view' = 'view'
  ): string {
    const reservationsList = reservations
      .map((reservation) => {
        const codeText = reservation.displayCode ? ` (${reservation.displayCode})` : '';
        return `*${reservation.index}* - ${reservation.partySize} personas, ${reservation.whenLabel}${codeText} — ${reservation.statusLabel}`;
      })
      .join('\n');

    const prompt =
      action === 'cancel'
        ? `Respondé con el *número* de la reserva que querés cancelar.`
        : action === 'edit'
          ? `Respondé con el *número* de la reserva que querés modificar.`
          : `Respondé con el *número* de la reserva para ver opciones de modificación o cancelación.`;

    return (
      `📋 Tengo varias reservas activas:\n\n` +
      `${reservationsList}\n\n` +
      `${prompt}\n` +
      `O escribí *RESERVAR* para crear otra reserva.`
    );
  },

  activeReservationSelectionInvalid(): string {
    return `❌ No reconocí esa opción. Respondé con el número de la reserva que querés gestionar o escribí *RESERVAR* para crear otra.`;
  },

  cancelMenuInvalidChoice(): string {
    return `❌ Respondé *1* para reprogramar o *2* para cancelar definitivamente.`;
  },

  rescheduleIntro(): string {
    return `Perfecto 👍\nComencemos por elegir una nueva fecha.`;
  },

  cancelConfirmPrompt(): string {
    return (
      `¿Estás seguro de que querés cancelar tu reserva?\n\n` +
      `1️⃣ Sí, cancelar\n` +
      `2️⃣ No, conservar la reserva`
    );
  },

  cancelConfirmInvalidChoice(): string {
    return `❌ Respondé *1* para cancelar la reserva o *2* para conservarla.`;
  },

  reservationCancelled(): string {
    return (
      `✅ Tu reserva fue cancelada correctamente.\n\n` +
      `Esperamos volver a recibirte muy pronto.\n\n` +
      `Cuando quieras hacer una nueva reserva, escribí: *RESERVAR*`
    );
  },

  reservationKept(): string {
    return `👍 ¡Perfecto! Tu reserva sigue activa tal como estaba. ¿Algo más en lo que pueda ayudarte?`;
  },

  cancelFailed(): string {
    return `❌ No se pudo cancelar la reserva. Por favor contactá directamente al local.`;
  },

  reservationOverlapConflict(
    requestedWhenLabel: string,
    conflictingWhenLabel: string,
    conflictingDisplayCode: string | null,
    conflictingStatusLabel: string
  ): string {
    const displayCodeText = conflictingDisplayCode ? ` (código *${conflictingDisplayCode}*)` : '';
    return (
      `⚠️ No puedo crear la reserva para ${requestedWhenLabel} porque se superpone con otra reserva activa para ${conflictingWhenLabel}` +
      `${displayCodeText} con estado *${conflictingStatusLabel}*.` +
      `\n\nDebe haber al menos 120 minutos entre reservas para evitar solapamientos.` +
      `\n\nSi querés, respondé *CANCELAR* para anularla y después crear una nueva.`
    );
  },

  noActiveReservation(): string {
    return `No encontré ninguna reserva activa. ¿Algo más en lo que pueda ayudarte?`;
  },

  // ============================
  // M8 — Horarios no disponibles
  // ============================

  timeNotAvailable(reason: string, nextSlotTime: string): string {
    return (
      `Ese horario no se encuentra disponible. ${reason}\n\n` +
      `🕐 El próximo horario disponible ese día es a las *${nextSlotTime}*.\n\n` +
      `¿Reservamos para esa hora? Respondé *sí* o *no*.`
    );
  },

  noMoreSlotsToday(reason: string): string {
    return `Ese horario no se encuentra disponible. ${reason} No hay más turnos disponibles ese día. ¿Querés elegir otro horario o día?`;
  },

  suggestNextSlot(slotLabel: string, reason?: string | null): string {
    const prefix = reason ? `❌ ${reason}\n\n` : '';
    return (
      `${prefix}El turno disponible más próximo es el *${slotLabel}*.\n\n` +
      `¿Reservamos para ese momento? Respondé *sí* para confirmarlo, o decime otro día u horario si preferís.`
    );
  },

  // ============================
  // M8b — Bloqueos de fechas configurados por el negocio
  // ============================

  dateBlocked(dayLabel: string, reasonMessage?: string | null): string {
    if (reasonMessage) {
      return `❌ ${reasonMessage}\n\n¿Querés elegir otra fecha?`;
    }
    return (
      `❌ Lo siento, el *${dayLabel}* el local no está tomando reservas.\n\n` +
      `¿Querés elegir otra fecha?`
    );
  },

  futureReservationsBlockedToday(): string {
    return (
      `❌ Por hoy no estamos tomando reservas para turnos más tarde — solo para el turno que está en curso ahora.\n\n` +
      `¿Querés unirte a la fila para el turno actual, o reservar para otro día?`
    );
  },

  // ============================
  // M9 — Validación de datos
  // ============================

  invalidDate(): string {
    return `No pude interpretar la fecha ingresada. ¿Podés escribirla nuevamente? Podés decir "hoy", "mañana" o un día de la semana (ej: "el viernes").`;
  },

  invalidTime(): string {
    return `¿Podrías escribir nuevamente el horario? Por ejemplo: "21:00", "9pm" o "a las 9 y media".`;
  },

  invalidPartySize(): string {
    return (
      `La cantidad de personas debe ser un número.\n\n` +
      `Ejemplo: 2, 4 o 6 personas.\n\n` +
      `_(Para cancelar escribí *cancelar* o *salir*)_`
    );
  },

  invalidName(): string {
    return `No reconocí eso como un nombre. ¿Cuál es tu nombre para la reserva?`;
  },

  nameChanged(name: string): string {
    return (
      `✅ ¡Listo! Cambié tu nombre a *${name}*.\n\n` +
      `¿Para cuántas personas es la reserva?\n\n` +
      `Ejemplo: 2, 4 o 6 personas.`
    );
  },

  askPartySizeShort(): string {
    return `¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4 o 6 personas.`;
  },


  // ============================
  // Guards y prompts de flujo consolidados desde whatsapp-handler (T1b)
  // ============================

  invalidNameRetry(): string {
    return `No reconocí eso como un nombre. ¿Cuál es tu nombre para continuar con la reserva?`;
  },

  askCorrectName(): string {
    return `¿Cuál es tu nombre correcto para continuar con la reserva?`;
  },

  invalidLastNameRetry(): string {
    return `No reconocí ese nombre. ¿Me lo repetís, por favor?`;
  },

  noStoredCustomerData(): string {
    return `Todavía no tengo tus datos guardados. Cuando hagas una reserva se guardará tu nombre. 😊`;
  },

  customerNameUpdated(fullName: string): string {
    return `✅ Listo, actualicé tu nombre. Ahora figurás como *${fullName}*.`;
  },

  closedNoAvailability(): string {
    return `❌ El local está cerrado en este momento y no encontré disponibilidad en los próximos 7 días.`;
  },

  closedSuggestNextSlot(slotLabel: string): string {
    return `❌ El local está cerrado en este momento.\n\nEl próximo horario disponible es el *${slotLabel}*.\n\n¿Reservamos para esa hora? Respondé *sí* o *no*.`;
  },

  outOfWindowPrefix(): string {
    return `Por ahora solo puedo tomar reservas dentro de los próximos 7 días. `;
  },

  outOfWindowAskDay(): string {
    return `Por ahora solo puedo tomar reservas dentro de los próximos 7 días. ¿Para qué día de esa semana la querés?`;
  },

  scheduleChoiceInvalid(): string {
    return `❌ Respondé *1* para ahora o *2* para elegir día y horario.`;
  },

  didntUnderstandTimeSuggest(slotTime: string): string {
    return `No entendí el horario. El primer turno disponible ese día es a las *${slotTime}*.\n\n¿Reservamos para esa hora? Respondé *sí* o *no*.`;
  },

  hoursRejectedAskOther(reason: string | undefined): string {
    return `❌ ${prefix(reason)}¿Para qué otro día y hora lo querés?`;
  },

  hoursRejectedSuggestSlot(reason: string | undefined, slotTime: string): string {
    return `❌ ${prefixBlock(reason)}El próximo horario disponible ese día es a las *${slotTime}*. ¿Reservamos para esa hora? Respondé *sí* o *no*.`;
  },

  hoursRejectedNoMoreSlots(reason: string | undefined): string {
    return `❌ ${prefix(reason)}No hay más turnos disponibles ese día. ¿Querés elegir otro horario o día?`;
  },

  confirmSlotPrompt(slotLabel: string, hoursNote: string): string {
    return `¿Confirmamos la reserva para el *${slotLabel}*?${hoursNote}\n\nRespondé *sí* o *no*.`;
  },

  /** El día elegido está cerrado; a diferencia de hoursRejectedAskOther, acá solo falta el DÍA (la hora se pide después). */
  dayClosedAskOtherDay(reason: string | undefined): string {
    return `❌ ${prefix(reason)}¿Para qué otro día querés reservar?`;
  },

  /** Nota que se anexa al prompt de confirmación cuando se arrastró el horario de un día a otro. */
  carriedTimeHoursNote(hoursRange: string): string {
    return `\n\nEse día atendemos de *${hoursRange}*. Decime otro horario si preferís.`;
  },

  didNotUnderstandDayAndTime(): string {
    return `❌ No entendí bien el día y la hora. ¿Para qué día y hora lo querés?`;
  },

  askTimeAgain(): string {
    return `¿A qué hora preferís entonces?`;
  },

  /** Recordatorio sí/no cuando la respuesta en confirm_slot no fue ninguna de las dos. */
  confirmSlotYesNoReminder(slotLabel: string | null): string {
    return slotLabel
      ? `Respondé *sí* o *no*: ¿confirmamos la reserva para el *${slotLabel}*? (Si preferís otro día u horario, decímelo directamente).`
      : `Respondé *sí* para confirmar ese horario o *no* para elegir otro.`;
  },

  reservationRescheduled(whenLabel: string): string {
    return `✅ ¡Listo! Tu reserva fue actualizada para el ${whenLabel}.`;
  },

  reservationUpdateFailed(): string {
    return `❌ No se pudo actualizar tu reserva. Por favor intentá de nuevo.`;
  },

  askNewPartySize(): string {
    return `¿Para cuántas personas querés cambiar la reserva?\n\nEjemplo: 2, 4 o 6 personas.`;
  },

  weekdayAmbiguityPrompt(weekdayLabel: string, nextLabel: string): string {
    return `¿Te referís a *hoy ${weekdayLabel}* o al *${nextLabel}* que viene?\n\nRespondé *1* para hoy o *2* para la semana que viene.`;
  },

  weekdayAmbiguityInvalid(weekday: string): string {
    return `No te entendí. Respondé *1* para hoy o *2* para el ${weekday} que viene.`;
  },

  weekdayDayMismatchPrompt(weekdayLabel: string, requestedDayNumber: number, nearestLabel: string): string {
    return `Por ahora solo puedo tomar reservas para *esta semana y la que viene*, así que no puedo agendar para el *${weekdayLabel} ${requestedDayNumber}*.\n\n¿Querés que sea para el *${nearestLabel}* (el próximo ${weekdayLabel}) en su lugar?\n\nRespondé *sí* o *no*.`;
  },

  weekdayDayMismatchInvalid(nearestLabel: string): string {
    return `No te entendí. Respondé *sí* para el ${nearestLabel} o *no* para elegir otro día.`;
  },

  timeAlreadyPassedSuggestTomorrow(timeLabel: string, tomorrowLabel: string): string {
    return `Ese horario ya pasó para hoy. ¿Podemos reservar para mañana a las *${timeLabel}* (${tomorrowLabel})?\n\nRespondé *sí* o *no*.`;
  },

  timeAlreadyPassed(): string {
    return `❌ Ese horario ya pasó. Decime otro horario, o otro día si preferís.`;
  },

  noActiveReservationsInquiry(): string {
    return `No tenés reservas activas en este momento. Si querés, podés crear una nueva reserva escribiendo *RESERVAR*.`;
  },

  /**
   * Misma pregunta ("¿tengo reservas?") pero de alguien que nunca escribió a este
   * local: en vez del texto corto pensado para quien ya conoce el flujo, se
   * presenta el local y explica qué puede hacer. Incluye el hint de idioma porque
   * esta rama corre ANTES del menú de idioma, así que si no va acá no lo ve nunca.
   */
  firstContactNoReservations(businessName: string): string {
    return (
      `👋 ¡Hola! Soy el asistente de reservas de *${businessName}*.\n\n` +
      `Todavía no tenés ninguna reserva con nosotros — es la primera vez que hablamos.\n\n` +
      `Puedo ayudarte a *reservar una mesa*, y más adelante a *modificarla* o *cancelarla*.\n\n` +
      `¿Querés reservar? Escribime *RESERVAR* y arrancamos.`
    );
  },

  /** Notificación proactiva: la reserva pasó a CONFIRMED. */
  reservationConfirmedNotice(name: string, partySize: number, displayCode: string): string {
    return (
      `✅ ¡Tu reserva está CONFIRMADA!\n\n` +
      `👤 Nombre: ${name}\n` +
      `👥 Personas: ${partySize}\n` +
      `📁 Código de reserva: *${displayCode}*\n\n` +
      `✨ Te avisaremos cuando falten 20 minutos para que puedas ocupar tu mesa.\n` +
      `Apreciamos tu puntualidad.\n\n` +
      `_Si necesitás cancelar, respondé CANCELAR._`
    );
  },

  /** Notificación proactiva: la reserva quedó registrada, pendiente de confirmación. */
  reservationRegisteredNotice(name: string, partySize: number, displayCode: string): string {
    return (
      `✅ ¡Tu reserva ha sido registrada!\n\n` +
      `👤 Nombre: ${name}\n` +
      `👥 Personas: ${partySize}\n` +
      `📁 Código de reserva: *${displayCode}*\n\n` +
      `⏰ Te notificaremos cuando confirmen tu reserva.\n\n` +
      `_Si necesitás cancelar, respondé CANCELAR._`
    );
  },

  /** Notificación proactiva: la mesa quedó libre (NOTIFIED). */
  tableReadyNotice(): string {
    return (
      `🚀 ¡Es tu momento!\n` +
      `Tu mesa está disponible.\n` +
      `Podés ocuparla dentro de los próximos 20 minutos.\n` +
      `Luego de ese tiempo, la reserva podría liberarse.`
    );
  },

  // ============================
  // M11 — Bienvenida al restaurante
  // ============================

  welcomeAtRestaurant(): string {
    return (
      `👋 ¡Bienvenido!\n\n` +
      `Tu mesa ya está lista.\n` +
      `Esperamos que disfrutes una excelente experiencia.`
    );
  },

  // ============================
  // M12 — Mensaje posterior a la visita
  // ============================

  postVisitMessage(): string {
    return (
      `¡Gracias por visitarnos! 💛\n\n` +
      `Esperamos que hayas disfrutado tu experiencia.\n\n` +
      `Nos encantaría conocer tu opinión.\n` +
      `⭐⭐⭐⭐⭐ Dejanos tu reseña.`
    );
  },

  // ============================
  // Mensajes de flujo/guards (fuera del manual)
  // ============================

  askName(): string {
    return `¿Cuál es tu nombre y apellido para la reserva?`;
  },

  askNameAgain(): string {
    return `¿Cuál es tu nombre y apellido para continuar con la reserva?`;
  },

  askLastName(firstName: string): string {
    return `Gracias, *${firstName}*. ¿Cuál es tu apellido?`;
  },

  askLastNameAgain(): string {
    return `No reconocí el apellido. ¿Me lo repetís, por favor?`;
  },

  processCancelled(): string {
    return `✅ Proceso cancelado. Podés empezar de nuevo cuando quieras.`;
  },

  tooManyInvalidAttempts(): string {
    return `❌ Demasiados intentos inválidos. El proceso fue cancelado. Podés empezar de nuevo cuando quieras.`;
  },

  confirmSummaryInvalidChoice(): string {
    return `❌ Respondé *1* para confirmar la reserva o *2* para modificarla.`;
  },

  // ============================
  // Guards de alcance (movidos desde reservation-scope.ts — T1b)
  // ============================

  reservationIntro(businessName: string): string {
    return `¡Hola! 👋 Soy el asistente de ${businessName} y estoy para generar reservas. ¿Cuál es tu nombre?`;
  },

  reservationOffTopic(businessName: string): string {
    return `Hola 😊 Solo puedo ayudarte con consultas relacionadas a reservas para “${businessName}” en el turno actual. ¿Querés hacer una reserva?`;
  },

  reservationOutOfWindow(businessName: string): string {
    return `Hola 😊 En “${businessName}” por ahora solo puedo tomar reservas dentro de los próximos 7 días. ¿Querés elegir un día más cercano?`;
  },

  inactiveFallback(): string {
    return `Lo siento, nuestro servicio de WhatsApp no está disponible en este momento. Por favor intenta más tarde.`;
  },

  /**
   * Error inesperado a mitad de un turno. Distinto de `inactiveFallback`, que
   * significa "el servicio está apagado": acá el servicio está vivo y algo puntual
   * falló, así que invitamos a reintentar el mismo mensaje.
   */
  genericError(): string {
    return `Uy, tuve un problema procesando tu mensaje. ¿Me lo repetís?`;
  },
};

/**
 * Forma del catálogo. Los demás idiomas deben implementarla completa —
 * TypeScript falla la compilación si falta una clave o cambia una firma.
 */
export type MessageCatalog = typeof esCatalog;
