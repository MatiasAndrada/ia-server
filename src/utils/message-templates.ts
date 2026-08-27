/**
 * Plantillas centralizadas de mensajes del asistente (Manual Conversacional Nubotik).
 *
 * Este archivo ya NO contiene los textos: son dispatchers de una línea sobre el
 * catálogo del idioma activo (ver src/i18n/). Los textos en español viven en
 * src/i18n/catalogs/es.ts, y sus traducciones en en.ts / pt.ts.
 *
 * Se mantiene la misma superficie de API (mismos nombres, mismas firmas) para
 * que los ~200 call sites del handler no necesiten cambiar: el idioma se resuelve
 * por AsyncLocalStorage, no por parámetro. Fuera de un runWithLanguage() el
 * catálogo activo es el español, así que los tests y las rutas REST existentes
 * se comportan igual que antes.
 *
 * Para emitir en un idioma explícito (senders de background que corren fuera de
 * un turno de conversación), usar getTemplates(lang) de src/i18n directamente.
 */

import { catalog } from '../i18n/catalogs/index.js';

// ============================
// M0 — Selección de idioma
// ============================

export function languageWelcomeMenu(businessName: string): string {
  return catalog().languageWelcomeMenu(businessName);
}

export function languageChanged(): string {
  return catalog().languageChanged();
}

export function languageChangeHint(): string {
  return catalog().languageChangeHint();
}

/** Etiqueta de "reserva para el turno en curso" (sin fecha/hora puntual). */
export function instantTurnLabel(): string {
  return catalog().instantTurnLabel();
}

// ============================
// M1 — Nueva reserva
// ============================

export function welcomeMessage(businessName: string): string {
  return catalog().welcomeMessage(businessName);
}

export function askPartySize(name: string): string {
  return catalog().askPartySize(name);
}

/**
 * Greets a customer already known by phone (name on file) and asks party
 * size directly — skips the name/apellido question entirely.
 */
export function welcomeBackAskPartySize(customerName: string): string {
  return catalog().welcomeBackAskPartySize(customerName);
}

/**
 * Menú del paso `schedule_choice`. Es dinámico: "Hoy" desaparece cuando el día
 * ya no tiene disponibilidad, y detrás de "Otra fecha" va un ítem por cada
 * evento activo del comercio. Los call sites lo arman con
 * `WhatsAppHandler.buildScheduleChoiceMessage`, que resuelve ambas cosas.
 */
export function askScheduleChoice(
  eventTitles: string[] = [],
  includeToday: boolean = true
): string {
  return catalog().askScheduleChoice(eventTitles, includeToday);
}

export function askDayClosedToday(openDays?: string | null): string {
  return catalog().askDayClosedToday(openDays);
}

/**
 * Shown instead of {@link askScheduleChoice} when today is already closed —
 * skips the "Hoy / Otra fecha" question entirely and jumps straight to
 * concrete day + hour-range alternatives so the customer never picks an
 * option that turns out to be unavailable.
 */
export function askDayClosedTodayWithSchedule(dayLines: string[]): string {
  return catalog().askDayClosedTodayWithSchedule(dayLines);
}

export function askDay(openDays?: string | null): string {
  return catalog().askDay(openDays);
}

/**
 * Answers "¿y los horarios de los otros días?" with the real upcoming
 * open days/hours, instead of the bot falsely claiming it doesn't have
 * that information (see reservation-scope.ts's isAskingOtherDaysScheduleMessage).
 */
export function otherDaysSchedule(dayLines: string[]): string {
  return catalog().otherDaysSchedule(dayLines);
}

export function askTime(dayLabel: string, hoursRange?: string | null): string {
  return catalog().askTime(dayLabel, hoursRange);
}

/** Asked when the customer chooses "hoy" and the business is open right now — before jumping to an instant reservation. */
export function askTodayTimeOpen(closeLabel: string | null): string {
  return catalog().askTodayTimeOpen(closeLabel);
}

/** Resumen previo a la confirmación (M1 — "Resumen y confirmación"). */
export function reservationSummary(
  name: string,
  partySize: number,
  whenLabel: string,
  fullName: string = name,
  eventTitle?: string | null
): string {
  return catalog().reservationSummary(name, partySize, whenLabel, fullName, eventTitle);
}

/** Submenú de modificación dentro del resumen (estilo M2, sobre el borrador). */
export function summaryEditMenu(): string {
  return catalog().summaryEditMenu();
}

/**
 * Submenú de modificación cuando la reserva es para un evento: la fecha y el
 * horario los fija el evento, así que sólo se puede cambiar la cantidad de
 * personas o salirse del evento.
 */
export function summaryEditMenuEvent(): string {
  return catalog().summaryEditMenuEvent();
}

/** Presentación del evento elegido, enviada después de las fotos. */
export function eventSelected(
  title: string,
  description: string | null,
  whenLabel: string
): string {
  return catalog().eventSelected(title, description, whenLabel);
}

/** El evento se desactivó entre que se mostró el menú y llegó la respuesta. */
export function eventNoLongerAvailable(title: string): string {
  return catalog().eventNoLongerAvailable(title);
}

/** Confirmación final de reserva (M1 — "Reserva confirmada"). */
export function reservationConfirmed(
  name: string,
  partySize: number,
  whenLabel: string,
  displayCode: string,
  fullName: string = name,
  eventTitle?: string | null
): string {
  return catalog().reservationConfirmed(name, partySize, whenLabel, displayCode, fullName, eventTitle);
}

/** Reserva registrada pero pendiente de confirmación del local (fuera del manual). */
export function reservationReceived(
  name: string,
  partySize: number,
  whenLabel: string,
  displayCode: string,
  fullName: string = name,
  eventTitle?: string | null
): string {
  return catalog().reservationReceived(name, partySize, whenLabel, displayCode, fullName, eventTitle);
}

// ============================
// M2 — Modificar una reserva
// ============================

export function editMenu(
  partySize: number,
  whenLabel: string,
  displayCode: string,
  statusLabel: string,
  customerName?: string | null,
  eventTitle?: string | null
): string {
  return catalog().editMenu(partySize, whenLabel, displayCode, statusLabel, customerName, eventTitle);
}

export function editMenuInvalidChoice(): string {
  return catalog().editMenuInvalidChoice();
}

export function partySizeUpdated(partySize: number): string {
  return catalog().partySizeUpdated(partySize);
}

export function partySizeUpdateFailed(): string {
  return catalog().partySizeUpdateFailed();
}

export function scheduleUpdated(whenLabel: string): string {
  return catalog().scheduleUpdated(whenLabel);
}

export function scheduleRevertedToInstant(): string {
  return catalog().scheduleRevertedToInstant();
}

// ============================
// M3 — Cancelar una reserva
// ============================

export function cancelMenu(partySize: number, whenLabel: string, displayCode: string): string {
  return catalog().cancelMenu(partySize, whenLabel, displayCode);
}

/**
 * Direct cancellation confirmation (CAMBIO 2): merges the reservation
 * summary and the yes/no question into a single message, skipping the
 * reprogramar/cancelar-definitivamente menu entirely for the CANCELAR
 * fast path.
 */
export function cancelDirectConfirmPrompt(
  partySize: number,
  whenLabel: string,
  displayCode: string
): string {
  return catalog().cancelDirectConfirmPrompt(partySize, whenLabel, displayCode);
}

export function activeReservationsMenu(
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
  return catalog().activeReservationsMenu(reservations, action);
}

export function activeReservationSelectionInvalid(): string {
  return catalog().activeReservationSelectionInvalid();
}

export function cancelMenuInvalidChoice(): string {
  return catalog().cancelMenuInvalidChoice();
}

export function rescheduleIntro(): string {
  return catalog().rescheduleIntro();
}

export function cancelConfirmPrompt(): string {
  return catalog().cancelConfirmPrompt();
}

export function cancelConfirmInvalidChoice(): string {
  return catalog().cancelConfirmInvalidChoice();
}

export function reservationCancelled(): string {
  return catalog().reservationCancelled();
}

export function reservationKept(): string {
  return catalog().reservationKept();
}

export function cancelFailed(): string {
  return catalog().cancelFailed();
}

export function reservationOverlapConflict(
  requestedWhenLabel: string,
  conflictingWhenLabel: string,
  conflictingDisplayCode: string | null,
  conflictingStatusLabel: string
): string {
  return catalog().reservationOverlapConflict(
    requestedWhenLabel,
    conflictingWhenLabel,
    conflictingDisplayCode,
    conflictingStatusLabel
  );
}

export function noActiveReservation(): string {
  return catalog().noActiveReservation();
}

export function newReservationOverlapReminder(
  conflictingWhenLabel: string,
  conflictingDisplayCode: string | null,
  conflictingStatusLabel: string
): string {
  return catalog().newReservationOverlapReminder(
    conflictingWhenLabel,
    conflictingDisplayCode,
    conflictingStatusLabel
  );
}

// ============================
// Mensajes multi-acción (cancelar/consultar varias reservas en un turno)
// ============================

export function cancelTargetNotFound(hasActiveReservations: boolean): string {
  return catalog().cancelTargetNotFound(hasActiveReservations);
}

export function reservationCancelledInline(whenLabel: string, displayCode: string | null): string {
  return catalog().reservationCancelledInline(whenLabel, displayCode);
}

export function cancelActionFailed(): string {
  return catalog().cancelActionFailed();
}

export function noActiveReservationsShort(): string {
  return catalog().noActiveReservationsShort();
}

// ============================
// M8 — Horarios no disponibles
// ============================

export function timeNotAvailable(reason: string, nextSlotTime: string): string {
  return catalog().timeNotAvailable(reason, nextSlotTime);
}

export function noMoreSlotsToday(reason: string): string {
  return catalog().noMoreSlotsToday(reason);
}

/**
 * Proactively suggests the soonest available slot after the customer entered an
 * unavailable day or time. Optionally prefixes the reason it wasn't available.
 * The customer can accept with "sí" or just name another day/time to override.
 */
export function suggestNextSlot(slotLabel: string, reason?: string | null): string {
  return catalog().suggestNextSlot(slotLabel, reason);
}

// ============================
// M8b — Bloqueos de fechas configurados por el negocio
// ============================

export function dateBlocked(dayLabel: string, reasonMessage?: string | null): string {
  return catalog().dateBlocked(dayLabel, reasonMessage);
}

export function futureReservationsBlockedToday(): string {
  return catalog().futureReservationsBlockedToday();
}

// ============================
// M9 — Validación de datos
// ============================

export function invalidDate(): string {
  return catalog().invalidDate();
}

export function invalidTime(): string {
  return catalog().invalidTime();
}

export function invalidPartySize(): string {
  return catalog().invalidPartySize();
}

export function invalidName(): string {
  return catalog().invalidName();
}

export function nameChanged(name: string): string {
  return catalog().nameChanged(name);
}

/** Party-size prompt without a name prefix (fallback paths). */
export function askPartySizeShort(): string {
  return catalog().askPartySizeShort();
}

// ============================
// Notificaciones proactivas (realtime-sync)
// ============================

/** La reserva pasó a CONFIRMED desde el dashboard. */
export function reservationConfirmedNotice(
  name: string,
  partySize: number,
  displayCode: string,
  leadMinutes: number,
  eventTitle?: string | null
): string {
  return catalog().reservationConfirmedNotice(name, partySize, displayCode, leadMinutes, eventTitle);
}

/** La reserva quedó registrada, pendiente de confirmación del local. */
export function reservationRegisteredNotice(
  name: string,
  partySize: number,
  displayCode: string,
  eventTitle?: string | null
): string {
  return catalog().reservationRegisteredNotice(name, partySize, displayCode, eventTitle);
}

/** El restaurante eliminó el evento y con él esta reserva. */
export function eventCancelledByBusiness(
  name: string,
  eventTitle: string,
  displayCode: string,
  whenLabel: string | null
): string {
  return catalog().eventCancelledByBusiness(name, eventTitle, displayCode, whenLabel);
}

/** El restaurante canceló la reserva (status CANCELLED desde el panel). */
export function reservationCancelledByBusiness(
  name: string,
  displayCode: string,
  whenLabel: string | null
): string {
  return catalog().reservationCancelledByBusiness(name, displayCode, whenLabel);
}

/** La mesa quedó libre (status NOTIFIED). */
export function tableReadyNotice(): string {
  return catalog().tableReadyNotice();
}

/** Respuesta a un mensaje de cortesía (agradecimiento u "ok") tras una reserva ya activa. */
export function postReservationCourtesyReply(
  reservationRef: string,
  isPending: boolean,
  isGratitude: boolean
): string {
  return catalog().postReservationCourtesyReply(reservationRef, isPending, isGratitude);
}

// ============================
// M11 — Bienvenida al restaurante
// ============================

export function welcomeAtRestaurant(): string {
  return catalog().welcomeAtRestaurant();
}

// ============================
// M12 — Mensaje posterior a la visita
// ============================

export function postVisitMessage(): string {
  return catalog().postVisitMessage();
}

// ============================
// Mensajes de flujo/guards (fuera del manual)
// ============================

export function askName(): string {
  return catalog().askName();
}

export function askNameAgain(): string {
  return catalog().askNameAgain();
}

/** Asks only for the apellido once the first name is already known. */
export function askLastName(firstName: string): string {
  return catalog().askLastName(firstName);
}

/** Re-ask when the apellido reply wasn't understood. */
export function askLastNameAgain(): string {
  return catalog().askLastNameAgain();
}

export function processCancelled(): string {
  return catalog().processCancelled();
}

export function tooManyInvalidAttempts(): string {
  return catalog().tooManyInvalidAttempts();
}

export function confirmSummaryInvalidChoice(): string {
  return catalog().confirmSummaryInvalidChoice();
}

// ============================
// Guards de alcance (T1b — consolidados desde reservation-scope.ts)
// ============================

export function reservationIntro(businessName: string): string {
  return catalog().reservationIntro(businessName);
}

export function reservationOffTopic(businessName: string): string {
  return catalog().reservationOffTopic(businessName);
}

export function reservationOutOfWindow(businessName: string): string {
  return catalog().reservationOutOfWindow(businessName);
}

/** Servicio de WhatsApp desactivado para el negocio. */
export function inactiveFallback(): string {
  return catalog().inactiveFallback();
}

export function genericError(): string {
  return catalog().genericError();
}

// ============================
// Guards y prompts de flujo (T1b — consolidados desde whatsapp-handler)
// ============================

export function invalidNameRetry(): string {
  return catalog().invalidNameRetry();
}

export function askCorrectName(): string {
  return catalog().askCorrectName();
}

export function askCorrectNameField(field: 'full' | 'lastName'): string {
  return catalog().askCorrectNameField(field);
}

export function invalidLastNameRetry(): string {
  return catalog().invalidLastNameRetry();
}

export function noStoredCustomerData(): string {
  return catalog().noStoredCustomerData();
}

export function customerNameUpdated(fullName: string): string {
  return catalog().customerNameUpdated(fullName);
}

export function closedNoAvailability(): string {
  return catalog().closedNoAvailability();
}

export function closedSuggestNextSlot(slotLabel: string): string {
  return catalog().closedSuggestNextSlot(slotLabel);
}

export function outOfWindowPrefix(): string {
  return catalog().outOfWindowPrefix();
}

export function outOfWindowAskDay(): string {
  return catalog().outOfWindowAskDay();
}

export function scheduleChoiceInvalid(optionCount: number = 2): string {
  return catalog().scheduleChoiceInvalid(optionCount);
}

export function didntUnderstandTimeSuggest(slotTime: string): string {
  return catalog().didntUnderstandTimeSuggest(slotTime);
}

export function hoursRejectedAskOther(reason: string | undefined): string {
  return catalog().hoursRejectedAskOther(reason);
}

export function hoursRejectedSuggestSlot(reason: string | undefined, slotTime: string): string {
  return catalog().hoursRejectedSuggestSlot(reason, slotTime);
}

export function hoursRejectedNoMoreSlots(reason: string | undefined): string {
  return catalog().hoursRejectedNoMoreSlots(reason);
}

export function confirmSlotPrompt(slotLabel: string, hoursNote: string): string {
  return catalog().confirmSlotPrompt(slotLabel, hoursNote);
}

export function dayClosedAskOtherDay(reason: string | undefined): string {
  return catalog().dayClosedAskOtherDay(reason);
}

export function carriedTimeHoursNote(hoursRange: string): string {
  return catalog().carriedTimeHoursNote(hoursRange);
}

export function didNotUnderstandDayAndTime(): string {
  return catalog().didNotUnderstandDayAndTime();
}

export function askTimeAgain(): string {
  return catalog().askTimeAgain();
}

export function confirmSlotYesNoReminder(slotLabel: string | null): string {
  return catalog().confirmSlotYesNoReminder(slotLabel);
}

export function reservationRescheduled(whenLabel: string): string {
  return catalog().reservationRescheduled(whenLabel);
}

export function reservationUpdateFailed(): string {
  return catalog().reservationUpdateFailed();
}

export function askNewPartySize(): string {
  return catalog().askNewPartySize();
}

export function weekdayAmbiguityPrompt(weekdayLabel: string, nextLabel: string): string {
  return catalog().weekdayAmbiguityPrompt(weekdayLabel, nextLabel);
}

export function weekdayAmbiguityInvalid(weekday: string): string {
  return catalog().weekdayAmbiguityInvalid(weekday);
}

export function weekdayDayMismatchPrompt(weekdayLabel: string, requestedDayNumber: number, nearestLabel: string): string {
  return catalog().weekdayDayMismatchPrompt(weekdayLabel, requestedDayNumber, nearestLabel);
}

export function weekdayDayMismatchInvalid(nearestLabel: string): string {
  return catalog().weekdayDayMismatchInvalid(nearestLabel);
}

export function timeAlreadyPassedSuggestTomorrow(timeLabel: string, tomorrowLabel: string): string {
  return catalog().timeAlreadyPassedSuggestTomorrow(timeLabel, tomorrowLabel);
}

export function timeAlreadyPassed(): string {
  return catalog().timeAlreadyPassed();
}

export function noActiveReservationsInquiry(): string {
  return catalog().noActiveReservationsInquiry();
}

export function firstContactNoReservations(businessName: string): string {
  return catalog().firstContactNoReservations(businessName);
}
