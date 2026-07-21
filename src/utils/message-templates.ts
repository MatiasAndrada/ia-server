/**
 * Plantillas centralizadas de mensajes del asistente (Manual Conversacional Nubotik).
 * Cada plantilla corresponde a un módulo del manual (M1..M12); los mensajes de
 * guard/errores que no figuran en el manual también viven acá para que todos los
 * textos salientes tengan un único punto de edición.
 */

// ============================
// M1 — Nueva reserva
// ============================

export function welcomeMessage(businessName: string): string {
  return (
    `👋 ¡Hola!\n` +
    `Soy el asistente de reservas de *${businessName}*.\n` +
    `Voy a ayudarte a reservar tu mesa en pocos segundos.\n\n` +
    `¿Cómo te llamás?`
  );
}

export function askPartySize(name: string): string {
  return (
    `✅ Perfecto, *${name}*.\n\n` +
    `¿Para cuántas personas es la reserva?\n\n` +
    `Ejemplo: 2, 4 o 6 personas.`
  );
}

export function askScheduleChoice(): string {
  return (
    `📅 ¿La reserva es para...?\n\n` +
    `1️⃣ Hoy (turno actual)\n` +
    `2️⃣ Otra fecha\n\n` +
    `Respondé con el *número* de la opción, o directamente decime el día (ej: "el viernes").`
  );
}

export function askDay(openDays?: string | null): string {
  if (openDays) {
    return (
      `📅 ¿Qué día preferís?\n` +
      `Estamos abiertos los: *${openDays}*.\n\n` +
      `Podés decir "mañana", "el viernes", etc.`
    );
  }
  return `📅 ¿Qué día preferís? Podés decir "mañana", "el viernes", etc.`;
}

export function askTime(dayLabel: string, hoursRange?: string | null): string {
  const hoursNote = hoursRange ? ` (horario: *${hoursRange}*)` : '';
  return `🕐 ¿A qué hora te gustaría reservar para el ${dayLabel}${hoursNote}?`;
}

/** Asked when the customer chooses "hoy" and the business is open right now — before jumping to an instant reservation. */
export function askTodayTimeOpen(closeLabel: string | null): string {
  const closingNote = closeLabel ? ` (el local está abierto hasta las *${closeLabel}*)` : '';
  return (
    `🕐 ¿A qué hora te gustaría la reserva de hoy?${closingNote}\n\n` +
    `Escribí el horario (ej: "21:00" o "9 y media"), o respondé *ahora* si la querés para el turno actual.`
  );
}

/** Resumen previo a la confirmación (M1 — "Resumen y confirmación"). */
export function reservationSummary(
  name: string,
  partySize: number,
  whenLabel: string
): string {
  return (
    `📋 Antes de confirmar, verificá que los datos sean correctos:\n\n` +
    `👤 Nombre: ${name}\n` +
    `👥 Personas: ${partySize}\n` +
    `📅 Fecha y hora: ${whenLabel}\n\n` +
    `¿Está todo correcto?\n\n` +
    `1️⃣ Confirmar reserva\n` +
    `2️⃣ Modificar la reserva`
  );
}

/** Submenú de modificación dentro del resumen (estilo M2, sobre el borrador). */
export function summaryEditMenu(): string {
  return (
    `¿Qué querés modificar?\n\n` +
    `1️⃣ Cantidad de personas\n` +
    `2️⃣ Fecha\n` +
    `3️⃣ Horario\n\n` +
    `Respondé con el *número* de la opción.`
  );
}

/** Confirmación final de reserva (M1 — "Reserva confirmada"). */
export function reservationConfirmed(
  name: string,
  partySize: number,
  whenLabel: string,
  displayCode: string
): string {
  return (
    `✅ ¡Reserva confirmada!\n\n` +
    `Gracias, *${name}*. Tu reserva fue registrada correctamente.\n\n` +
    `👤 Nombre: ${name}\n` +
    `👥 Personas: ${partySize}\n` +
    `📅 Fecha y hora: ${whenLabel}\n` +
    `📁 Código de reserva: *${displayCode}*\n\n` +
    `✨ ¡Te esperamos! Esperamos que disfrutes una excelente experiencia.\n\n` +
    `Si necesitás cancelar, simplemente escribí: *CANCELAR*`
  );
}

/** Reserva registrada pero pendiente de confirmación del local (fuera del manual). */
export function reservationReceived(
  name: string,
  partySize: number,
  whenLabel: string,
  displayCode: string
): string {
  return (
    `⏳ *Reserva RECIBIDA*\n\n` +
    `👤 Nombre: ${name}\n` +
    `👥 Personas: ${partySize}\n` +
    `📅 Fecha y hora: ${whenLabel}\n` +
    `📁 Código: *${displayCode}*\n\n` +
    `⏰ Te notificaremos cuando confirmen tu reserva.\n\n` +
    `Si necesitás cancelar, simplemente escribí: *CANCELAR*`
  );
}

// ============================
// M2 — Modificar una reserva
// ============================

export function editMenu(
  partySize: number,
  whenLabel: string,
  displayCode: string,
  statusLabel: string
): string {
  return (
    `📋 Encontré una reserva activa.\n\n` +
    `👥 Personas: *${partySize}*\n` +
    `📅 Fecha y hora: ${whenLabel}\n` +
    `📁 Código: *${displayCode}*\n` +
    `📌 Estado: ${statusLabel}\n\n` +
    `¿Qué querés modificar?\n\n` +
    `1️⃣ Cantidad de personas\n` +
    `2️⃣ Fecha\n` +
    `3️⃣ Horario\n\n` +
    `Respondé con el *número* de la opción.\n\n` +
    `_Para cancelar tu reserva escribí *CANCELAR*._`
  );
}

export function editMenuInvalidChoice(): string {
  return `❌ Por favor respondé con *1*, *2* o *3* según la opción que elegiste.`;
}

export function partySizeUpdated(partySize: number): string {
  return `✅ ¡Listo! Tu reserva fue actualizada a *${partySize}* personas.`;
}

export function scheduleUpdated(whenLabel: string): string {
  return `✅ ¡Listo! Tu reserva fue actualizada para el ${whenLabel}.`;
}

// ============================
// M3 — Cancelar una reserva
// ============================

export function cancelMenu(partySize: number, whenLabel: string, displayCode: string): string {
  return (
    `📋 Encontré una reserva activa.\n\n` +
    `👥 Personas: *${partySize}*\n` +
    `📅 Fecha y hora: ${whenLabel}\n` +
    `📁 Código: *${displayCode}*\n\n` +
    `¿Qué te gustaría hacer?\n\n` +
    `1️⃣ Reprogramar la reserva\n` +
    `2️⃣ Cancelar definitivamente`
  );
}

export function activeReservationsMenu(reservations: {
  index: number;
  partySize: number;
  whenLabel: string;
  displayCode: string | null;
  statusLabel: string;
}[]): string {
  const reservationsList = reservations
    .map((reservation) => {
      const codeText = reservation.displayCode ? ` (${reservation.displayCode})` : '';
      return `*${reservation.index}* - ${reservation.partySize} personas, ${reservation.whenLabel}${codeText} — ${reservation.statusLabel}`;
    })
    .join('\n');

  return (
    `📋 Tengo varias reservas activas:\n\n` +
    `${reservationsList}\n\n` +
    `Respondé con el *número* de la reserva para ver opciones de modificación o cancelación.\n` +
    `O escribí *RESERVAR* para crear otra reserva.`
  );
}

export function activeReservationSelectionInvalid(): string {
  return `❌ No reconocí esa opción. Respondé con el número de la reserva que querés gestionar o escribí *RESERVAR* para crear otra.`;
}

export function cancelMenuInvalidChoice(): string {
  return `❌ Respondé *1* para reprogramar o *2* para cancelar definitivamente.`;
}

export function rescheduleIntro(): string {
  return `Perfecto 👍\nComencemos por elegir una nueva fecha.`;
}

export function cancelConfirmPrompt(): string {
  return (
    `¿Estás seguro de que querés cancelar tu reserva?\n\n` +
    `1️⃣ Sí, cancelar\n` +
    `2️⃣ No, conservar la reserva`
  );
}

export function cancelConfirmInvalidChoice(): string {
  return `❌ Respondé *1* para cancelar la reserva o *2* para conservarla.`;
}

export function reservationCancelled(): string {
  return (
    `✅ Tu reserva fue cancelada correctamente.\n\n` +
    `Esperamos volver a recibirte muy pronto.\n\n` +
    `Cuando quieras hacer una nueva reserva, escribí: *RESERVAR*`
  );
}

export function reservationKept(): string {
  return `👍 ¡Perfecto! Tu reserva sigue activa tal como estaba. ¿Algo más en lo que pueda ayudarte?`;
}

export function cancelFailed(): string {
  return `❌ No se pudo cancelar la reserva. Por favor contactá directamente al local.`;
}

export function reservationOverlapConflict(
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
}

export function noActiveReservation(): string {
  return `No encontré ninguna reserva activa. ¿Algo más en lo que pueda ayudarte?`;
}

// ============================
// M8 — Horarios no disponibles
// ============================

export function timeNotAvailable(reason: string, nextSlotTime: string): string {
  return (
    `Ese horario no se encuentra disponible. ${reason}\n\n` +
    `🕐 El próximo horario disponible ese día es a las *${nextSlotTime}*.\n\n` +
    `¿Reservamos para esa hora? Respondé *sí* o *no*.`
  );
}

export function noMoreSlotsToday(reason: string): string {
  return `Ese horario no se encuentra disponible. ${reason} No hay más turnos disponibles ese día. ¿Querés elegir otro horario o día?`;
}

/**
 * Proactively suggests the soonest available slot after the customer entered an
 * unavailable day or time. Optionally prefixes the reason it wasn't available.
 * The customer can accept with "sí" or just name another day/time to override.
 */
export function suggestNextSlot(slotLabel: string, reason?: string | null): string {
  const prefix = reason ? `❌ ${reason}\n\n` : '';
  return (
    `${prefix}El turno disponible más próximo es el *${slotLabel}*.\n\n` +
    `¿Reservamos para ese momento? Respondé *sí* para confirmarlo, o decime otro día u horario si preferís.`
  );
}

// ============================
// M8b — Bloqueos de fechas configurados por el negocio
// ============================

export function dateBlocked(dayLabel: string, reasonMessage?: string | null): string {
  if (reasonMessage) {
    return `❌ ${reasonMessage}\n\n¿Querés elegir otra fecha?`;
  }

  return (
    `❌ Lo siento, el *${dayLabel}* el local no está tomando reservas.\n\n` +
    `¿Querés elegir otra fecha?`
  );
}

export function futureReservationsBlockedToday(): string {
  return (
    `❌ Por hoy no estamos tomando reservas para turnos más tarde — solo para el turno que está en curso ahora.\n\n` +
    `¿Querés unirte a la fila para el turno actual, o reservar para otro día?`
  );
}

// ============================
// M9 — Validación de datos
// ============================

export function invalidDate(): string {
  return `No pude interpretar la fecha ingresada. ¿Podés escribirla nuevamente? Podés decir "hoy", "mañana" o un día de la semana (ej: "el viernes").`;
}

export function invalidTime(): string {
  return `¿Podrías escribir nuevamente el horario? Por ejemplo: "21:00", "9pm" o "a las 9 y media".`;
}

export function invalidPartySize(): string {
  return (
    `La cantidad de personas debe ser un número.\n\n` +
    `Ejemplo: 2, 4 o 6 personas.\n\n` +
    `_(Para cancelar escribí *cancelar* o *salir*)_`
  );
}

export function invalidName(): string {
  return `No reconocí eso como un nombre. ¿Cuál es tu nombre para la reserva?`;
}

export function nameChanged(name: string): string {
  return (
    `✅ ¡Listo! Cambié tu nombre a *${name}*.\n\n` +
    `¿Para cuántas personas es la reserva?\n\n` +
    `Ejemplo: 2, 4 o 6 personas.`
  );
}

/** Party-size prompt without a name prefix (fallback paths). */
export function askPartySizeShort(): string {
  return `¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4 o 6 personas.`;
}

// ============================
// M11 — Bienvenida al restaurante
// ============================

export function welcomeAtRestaurant(): string {
  return (
    `👋 ¡Bienvenido!\n\n` +
    `Tu mesa ya está lista.\n` +
    `Esperamos que disfrutes una excelente experiencia.`
  );
}

// ============================
// M12 — Mensaje posterior a la visita
// ============================

export function postVisitMessage(): string {
  return (
    `¡Gracias por visitarnos! 💛\n\n` +
    `Esperamos que hayas disfrutado tu experiencia.\n\n` +
    `Nos encantaría conocer tu opinión.\n` +
    `⭐⭐⭐⭐⭐ Dejanos tu reseña.`
  );
}

// ============================
// Mensajes de flujo/guards (fuera del manual)
// ============================

export function askName(): string {
  return `¿Cuál es tu nombre para la reserva?`;
}

export function askNameAgain(): string {
  return `¿Cuál es tu nombre para continuar con la reserva?`;
}

export function processCancelled(): string {
  return `✅ Proceso cancelado. Podés empezar de nuevo cuando quieras.`;
}

export function tooManyInvalidAttempts(): string {
  return `❌ Demasiados intentos inválidos. El proceso fue cancelado. Podés empezar de nuevo cuando quieras.`;
}

export function confirmSummaryInvalidChoice(): string {
  return `❌ Respondé *1* para confirmar la reserva o *2* para modificarla.`;
}
