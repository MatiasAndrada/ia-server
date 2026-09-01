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

/** Numeración de los menús. Compartida por los tres catálogos: los dígitos
 * no se traducen, y así el orden de las opciones no puede divergir. */
export const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

/**
 * "una hora" / "45 minutos". Los recordatorios tienen la antelación
 * configurable, así que el texto no puede tener el número escrito a mano.
 */
function countdownLabel(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours === 1 ? 'una' : hours} hora${hours === 1 ? '' : 's'}`;
}

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

/** "hoy 31/08 a las 21:30" → "Hoy 31/08 a las 21:30": el label abre la línea. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Los datos operativos de una reserva en un solo renglón.
 *
 * Antes cada confirmación repetía cuatro líneas etiquetadas ("👤 Nombre: …",
 * "👥 Personas: …", "📅 Fecha y hora: …", "📁 Código: …"): media pantalla de
 * WhatsApp para decir tres datos que entran en una línea.
 */
function reservationLine(whenLabel: string, partySize: number): string {
  const people = `${partySize} ${partySize === 1 ? 'persona' : 'personas'}`;
  return `📅 ${capitalize(whenLabel)} · 👥 ${people}`;
}

/**
 * La retención sólo aplica a una reserva con horario: para una instantánea
 * ("el turno actual") no hay un "horario reservado" desde el cual contar.
 */
function retentionLine(isScheduled: boolean): string {
  return isScheduled
    ? `\nTu reserva se mantendrá hasta *20 minutos después* del horario reservado.`
    : '';
}

/** El evento va en su propia línea: el título es largo y rompería el renglón de datos. */
function eventLine(eventTitle?: string | null): string {
  return eventTitle ? `\n🎉 ${eventTitle}` : '';
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

  /**
   * Saludo de primer contacto del agente v2: se presenta y ofrece las dos cosas
   * que sabe hacer.
   *
   * El menú es un ATAJO, no un formulario. El cliente puede responder 1 o 2,
   * escribir su pedido entero ("hoy 21:30 para 4") o preguntar cualquier otra
   * cosa: el agente lo atiende igual. Por eso no hay un template de "opción
   * inválida" que lo acompañe — para este menú no existe la opción inválida.
   *
   * No reemplaza a `welcomeMessage`: ese es el saludo del flujo por pasos de
   * v1, donde lo único que se espera a continuación es el nombre.
   */
  welcomeMenu(
    businessName: string,
    customerName?: string | null,
    events: { title: string; whenLabel: string }[] = []
  ): string {
    const lines = [
      customerName ? `¡Hola, ${customerName}! 👋` : `¡Hola! 👋`,
      `Por acá te ayudamos con tus reservas en ${businessName} 😊`,
      '',
      `¿Qué querés hacer?`,
      '',
      `${NUMBER_EMOJI[0]} Reservar una mesa`,
      `${NUMBER_EMOJI[1]} Modificar o cancelar una reserva`,
      '',
    ];

    // Sin eventos no va ni la sección ni la invitación a nombrar uno: ofrecer
    // algo que no existe deja al cliente escribiendo contra la nada.
    if (events.length > 0) {
      lines.push(`✨ *Próximos eventos:*`, '');
      lines.push(...events.map((event) => `• ${event.title} · ${capitalize(event.whenLabel)}`));
      lines.push('', `Respondé *1* o *2*, o escribí el nombre del evento.`);
    } else {
      lines.push(`Respondé *1* o *2*, o contame qué necesitás.`);
    }

    return lines.join('\n');
  },

  /**
   * Segundo mensaje del alta de un cliente nuevo: entre elegir idioma y el menú
   * de apertura. Se le pide sólo el nombre — el apellido, si hace falta, lo pide
   * el agente cuando llega el momento de reservar.
   */
  onboardingAskName(): string {
    return (
      `¡Perfecto! 😊\n` +
      `Antes de comenzar, ¿cómo te llamás? Así podemos acompañarte de forma más personalizada.`
    );
  },

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

  askScheduleChoice(eventTitles: string[] = [], includeToday: boolean = true): string {
    const options: string[] = [];
    if (includeToday) options.push('Hoy (turno actual)');
    options.push('Otra fecha');
    options.push(...eventTitles);

    const lines = options.map((option, index) => `${NUMBER_EMOJI[index]} ${option}`).join('\n');
    const eventsNote = eventTitles.length > 0 ? ` También podés elegir uno de nuestros eventos.` : '';

    return (
      `📅 ¿La reserva es para...?\n\n` +
      `${lines}\n\n` +
      `Respondé con el *número* de la opción, o directamente decime el día (ej: "el viernes").${eventsNote}`
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

  /**
   * El detalle del evento que eligió el cliente. Se envía DESPUÉS de las fotos,
   * así el bloque queda "fotos → detalle → siguiente pregunta".
   *
   * No cierra ni invita a seguir: de eso se encarga el mensaje que va después
   * (el resumen en v1, la pregunta del modelo en v2).
   */
  eventSelected(title: string, description: string | null, whenLabel: string): string {
    return (
      `🎉 *${title}*\n` +
      `📅 ${capitalize(whenLabel)}` +
      (description ? `\n\n${description}` : '')
    );
  },

  /** El evento dejó de estar disponible entre que se mostró el menú y la respuesta. */
  eventNoLongerAvailable(title: string): string {
    return `😔 *${title}* ya no está disponible. Elegí otra opción, por favor.`;
  },

  /** Menú de edición del resumen cuando la reserva es para un evento: la fecha y el horario los fija el evento. */
  summaryEditMenuEvent(): string {
    return (
      `¿Qué querés modificar?\n\n` +
      `1️⃣ Cantidad de personas\n` +
      `2️⃣ Elegir otra fecha o evento\n\n` +
      `Respondé con el *número* de la opción.`
    );
  },

  reservationSummary(
    name: string,
    partySize: number,
    whenLabel: string,
    fullName: string = name,
    eventTitle?: string | null
  ): string {
    const eventLine = eventTitle ? `🎉 Evento: ${eventTitle}\n` : '';
    return (
      `📋 Antes de confirmar, verificá que los datos sean correctos:\n\n` +
      `👤 Nombre: ${fullName}\n` +
      `👥 Personas: ${partySize}\n` +
      `${eventLine}` +
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
    partySize: number,
    whenLabel: string,
    displayCode: string,
    isScheduled: boolean,
    eventTitle?: string | null
  ): string {
    return (
      `✅ ¡Reserva confirmada!\n` +
      `${reservationLine(whenLabel, partySize)}${eventLine(eventTitle)}\n` +
      `Código: *${displayCode}*\n` +
      `Te esperamos 🙌` +
      retentionLine(isScheduled)
    );
  },

  reservationReceived(
    partySize: number,
    whenLabel: string,
    displayCode: string,
    eventTitle?: string | null
  ): string {
    return (
      `Listo ✅\n` +
      `${reservationLine(whenLabel, partySize)} · Código: *${displayCode}*${eventLine(eventTitle)}\n` +
      `Te aviso apenas el restaurante confirme.`
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
    customerName?: string | null,
    eventTitle?: string | null
  ): string {
    const greeting = customerName ? `👋 ¡Hola ${customerName}! ¿Qué necesitás hoy?\n\n` : '';
    const eventSuffix = eventTitle ? ` — 🎉 ${eventTitle}` : '';
    return (
      `${greeting}📋 Tenés 1 reserva activa:\n` +
      `• ${partySize} personas, ${whenLabel} (${displayCode}) ${statusLabel}${eventSuffix}\n\n` +
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

  partySizeUpdateFailed(): string {
    return `❌ No se pudo actualizar la cantidad. Por favor intentá de nuevo.`;
  },

  scheduleUpdated(whenLabel: string): string {
    return `✅ ¡Listo! Tu reserva fue actualizada para el ${whenLabel}.`;
  },

  /** La reserva de edición vuelve a ser instantánea (sin fecha/hora puntual). */
  scheduleRevertedToInstant(): string {
    return `✅ ¡Listo! Tu reserva vuelve a ser para el turno actual.`;
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
      eventTitle?: string | null;
    }[],
    action: 'edit' | 'cancel' | 'view' = 'view'
  ): string {
    const reservationsList = reservations
      .map((reservation) => {
        const codeText = reservation.displayCode ? ` (${reservation.displayCode})` : '';
        const eventSuffix = reservation.eventTitle ? ` — 🎉 ${reservation.eventTitle}` : '';
        return `*${reservation.index}* - ${reservation.partySize} personas, ${reservation.whenLabel}${codeText} — ${reservation.statusLabel}${eventSuffix}`;
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

  /**
   * Igual que {@link reservationOverlapConflict} pero para el guard que corre
   * ANTES de empezar el draft de una reserva nueva (enforceSingleActiveReservationPolicy):
   * todavía no hay un requestedWhenLabel puntual, así que el texto habla de
   * "tu nueva reserva" en general.
   */
  newReservationOverlapReminder(
    conflictingWhenLabel: string,
    conflictingDisplayCode: string | null,
    conflictingStatusLabel: string
  ): string {
    const displayCodeText = conflictingDisplayCode ? ` (código *${conflictingDisplayCode}*)` : '';
    return (
      `⚠️ Tu nueva reserva se superpone con una reserva activa para ${conflictingWhenLabel}` +
      `${displayCodeText} con estado *${conflictingStatusLabel}*.` +
      `\n\nNo puedo crearla porque debe haber al menos 120 minutos entre reservas.` +
      `\n\nSi querés, respondé *CANCELAR* para anularla y después crear una nueva.`
    );
  },

  // ============================
  // Mensajes multi-acción (cancelar/consultar varias reservas en un turno)
  // ============================

  /** `hasActiveReservations` = el cliente tiene otras reservas activas pero no se pudo identificar cuál. */
  cancelTargetNotFound(hasActiveReservations: boolean): string {
    return hasActiveReservations
      ? `⚠️ No pude identificar cuál reserva cancelar; escribí *CANCELAR* y te muestro tus reservas.`
      : `⚠️ No encontré una reserva activa para cancelar.`;
  },

  reservationCancelledInline(whenLabel: string, displayCode: string | null): string {
    const codeText = displayCode ? ` (código *${displayCode}*)` : '';
    return `✅ Cancelé tu reserva para ${whenLabel}${codeText}.`;
  },

  cancelActionFailed(): string {
    return `❌ No pude cancelar una de las reservas. Intentá de nuevo.`;
  },

  /** Variante corta de {@link noActiveReservationsInquiry}, para insertar como una línea más de un resumen multi-acción. */
  noActiveReservationsShort(): string {
    return `No tenés reservas activas en este momento.`;
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

  /** Re-pregunta de corrección de nombre/apellido en el flujo de edición de datos del cliente. */
  askCorrectNameField(field: 'full' | 'lastName'): string {
    return field === 'lastName'
      ? `¿Cuál es tu apellido correcto?`
      : `¿Cuál es tu nombre y apellido correcto?`;
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
    return `❌ El local está cerrado en este momento y no encontré disponibilidad en los próximos 60 días.`;
  },

  closedSuggestNextSlot(slotLabel: string): string {
    return `❌ El local está cerrado en este momento.\n\nEl próximo horario disponible es el *${slotLabel}*.\n\n¿Reservamos para esa hora? Respondé *sí* o *no*.`;
  },

  outOfWindowPrefix(): string {
    return `Por ahora solo puedo tomar reservas dentro de los próximos 60 días. `;
  },

  outOfWindowAskDay(): string {
    return `Por ahora solo puedo tomar reservas dentro de los próximos 60 días. ¿Para qué día la querés?`;
  },

  scheduleChoiceInvalid(optionCount: number = 2): string {
    if (optionCount <= 2) {
      return `❌ Respondé *1* para ahora o *2* para elegir día y horario.`;
    }
    return `❌ Respondé con un *número* del *1* al *${optionCount}*, o decime directamente qué día querés.`;
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
    return `Por ahora solo puedo tomar reservas dentro de los *próximos 60 días*, así que no puedo agendar para el *${weekdayLabel} ${requestedDayNumber}*.\n\n¿Querés que sea para el *${nearestLabel}* (el próximo ${weekdayLabel}) en su lugar?\n\nRespondé *sí* o *no*.`;
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

  /**
   * Notificación proactiva: el local aprobó la reserva (pasó a CONFIRMED).
   *
   * Mismo texto que `reservationConfirmed` a propósito: el cliente no tiene por
   * qué recibir dos confirmaciones distintas según quién la haya disparado. Lo
   * que cambia es el camino — acá la aprobación llegó desde el panel, no del
   * chat — y por eso son dos claves y no una.
   */
  reservationConfirmedNotice(
    partySize: number,
    displayCode: string,
    whenLabel: string,
    isScheduled: boolean,
    eventTitle?: string | null
  ): string {
    return (
      `✅ ¡Reserva confirmada!\n` +
      `${reservationLine(whenLabel, partySize)}${eventLine(eventTitle)}\n` +
      `Código: *${displayCode}*\n` +
      `Te esperamos 🙌` +
      retentionLine(isScheduled)
    );
  },

  /** Notificación proactiva: la reserva quedó registrada, pendiente de confirmación. */
  reservationRegisteredNotice(
    partySize: number,
    displayCode: string,
    whenLabel: string,
    eventTitle?: string | null
  ): string {
    return (
      `Listo ✅\n` +
      `${reservationLine(whenLabel, partySize)} · Código: *${displayCode}*${eventLine(eventTitle)}\n` +
      `Te aviso apenas el restaurante confirme.`
    );
  },

  /**
   * M10a — Recordatorio con antelación (por defecto, una hora antes).
   *
   * Es el único mensaje del recorrido que le llega al cliente sin que él haya
   * hecho nada, así que lleva la salida explícita: si no va a venir, que lo
   * diga acá y no ocupando una mesa vacía.
   */
  reservationUpcomingReminder(
    name: string,
    partySize: number,
    whenLabel: string,
    displayCode: string,
    minutesUntil: number
  ): string {
    return (
      `⏰ Te recordamos tu reserva\n\n` +
      `👤 Nombre: ${name}\n` +
      `👥 Personas: ${partySize}\n` +
      `🗓️ ${whenLabel}\n` +
      `📁 Código de reserva: *${displayCode}*\n\n` +
      `Falta ${countdownLabel(minutesUntil)}. ¡Te esperamos!\n\n` +
      `_Si no vas a poder venir, respondé *CANCELAR* y liberamos la mesa._`
    );
  },

  /** M10b — Aviso de proximidad (por defecto, quince minutos antes). */
  reservationArrivalReminder(
    whenLabel: string,
    displayCode: string,
    minutesUntil: number
  ): string {
    return (
      `🔔 Faltan ${countdownLabel(minutesUntil)} para tu reserva\n\n` +
      `🗓️ ${whenLabel}\n` +
      `📁 Código de reserva: *${displayCode}*\n\n` +
      `Ya deberías estar cerca. ¡Te esperamos!`
    );
  },

  /**
   * Notificación proactiva: el restaurante canceló la reserva (CANCELLED).
   *
   * No se confunde con `reservationCancelled()`, que es el acuse de recibo
   * cuando quien cancela es el cliente desde el chat: acá la decisión no fue
   * suya, así que el mensaje tiene que explicar qué pasó y ofrecerle rehacerla.
   */
  /**
   * El comercio eliminó un evento y con él las reservas que tenía.
   * Se nombra el evento: para el cliente "tu reserva fue cancelada" a secas
   * no explica nada, y lo que se dio de baja no fue su reserva sino la noche.
   */
  eventCancelledByBusiness(
    name: string,
    eventTitle: string,
    displayCode: string,
    whenLabel: string | null
  ): string {
    return (
      `❌ El evento *${eventTitle}* fue cancelado por el restaurante.\n\n` +
      `Tu reserva para ese evento queda sin efecto.\n\n` +
      `👤 Nombre: ${name}\n` +
      (whenLabel ? `🗓️ Era para: ${whenLabel}\n` : '') +
      `📁 Código de reserva: *${displayCode}*\n\n` +
      `Lamentamos el inconveniente.\n` +
      `_Si querés reservar para otro momento, escribinos y lo resolvemos._`
    );
  },

  reservationCancelledByBusiness(
    name: string,
    displayCode: string,
    whenLabel: string | null
  ): string {
    return (
      `❌ Tu reserva fue cancelada por el restaurante.\n\n` +
      `👤 Nombre: ${name}\n` +
      (whenLabel ? `🗓️ Era para: ${whenLabel}\n` : '') +
      `📁 Código de reserva: *${displayCode}*\n\n` +
      `Lamentamos el inconveniente.\n` +
      `_Si querés reservar para otro momento, escribinos y lo resolvemos._`
    );
  },

  /** Notificación proactiva: la mesa quedó libre (NOTIFIED). */
  tableReadyNotice(): string {
    return (
      `🍽️ ¡Tu mesa está lista!\n` +
      `Podés ocuparla dentro de los próximos 20 minutos.\n\n` +
      `Luego de ese tiempo, la reserva podría liberarse.`
    );
  },

  /**
   * Respuesta a un mensaje de cortesía (agradecimiento o simple "ok") después de
   * que el cliente ya tiene una reserva activa. `isPending` distingue WAITING de
   * CONFIRMED/NOTIFIED; `isGratitude` distingue un "gracias" de un "ok"/"dale".
   */
  postReservationCourtesyReply(reservationRef: string, isPending: boolean, isGratitude: boolean): string {
    if (isPending) {
      return isGratitude
        ? `¡De nada! 🙌\n\nTu reserva${reservationRef} sigue pendiente de confirmación. Apenas confirmen, te avisamos por acá.`
        : `¡Perfecto! 🙌\n\nTu reserva${reservationRef} sigue pendiente de confirmación. Apenas confirmen, te avisamos por acá.`;
    }
    return isGratitude
      ? `¡De nada! 🙌\n\nTu reserva${reservationRef} ya está confirmada. Si necesitas algo más, estoy para ayudarte.`
      : `¡Genial! 🙌\n\nTu reserva${reservationRef} ya está confirmada. Si necesitas algo más, estoy para ayudarte.`;
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
    return `Hola 😊 En “${businessName}” por ahora solo puedo tomar reservas dentro de los próximos 60 días. ¿Querés elegir un día más cercano?`;
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
