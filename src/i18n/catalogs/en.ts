/**
 * English catalog.
 *
 * Mirrors `esCatalog` key by key — TypeScript enforces completeness via the
 * `MessageCatalog` annotation below. Tone is warm but neutral (international
 * tourists), avoiding US/UK-specific idioms.
 *
 * Magic keywords are English here (*CANCEL*, *BOOK*), but the matcher layer
 * accepts every language's keywords regardless of the active language, so a
 * customer who types CANCELAR while on English still gets understood.
 */

import type { MessageCatalog } from './es.js';
import { buildLanguageMenuLines, NUMBER_EMOJI } from './es.js';

/** "an hour" / "45 minutes" — the reminder lead time is configurable. */
function countdownLabel(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours === 1 ? 'an' : hours} hour${hours === 1 ? '' : 's'}`;
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

/** "today 31/08 at 21:30" → "Today 31/08 at 21:30": the label opens the line. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A booking's operational data on a single line — see the note in es.ts. */
function reservationLine(whenLabel: string, partySize: number, displayCode: string): string {
  const people = `${partySize} ${partySize === 1 ? 'person' : 'people'}`;
  return `📅 ${capitalize(whenLabel)} · 👥 ${people} · Code: *${displayCode}*`;
}

/** The event gets its own line: the title is long and would break the data line. */
function eventLine(eventTitle?: string | null): string {
  return eventTitle ? `\n🎉 ${eventTitle}` : '';
}

export const enCatalog: MessageCatalog = {
  // ============================
  // M0 — Language selection
  // ============================

  languageWelcomeMenu(businessName: string): string {
    return (
      `🌎 Welcome to *${businessName}*!\n\n` +
      `Which language would you like us to use for your booking?\n\n` +
      `${buildLanguageMenuLines()}\n\n` +
      `Reply with the *number* of your preferred language, or just keep writing and I'll follow your lead.`
    );
  },

  languageChanged(): string {
    return `✅ Done! We'll continue in English.`;
  },

  languageChangeHint(): string {
    return `_🌐 To switch languages, type the language name or send a flag._`;
  },

  instantTurnLabel(): string {
    return `Today (current service)`;
  },

  // ============================
  // M1 — New booking
  // ============================

  welcomeMenu(businessName: string, customerName?: string | null): string {
    const greeting = customerName ? `Hi, ${customerName}!` : `Hi there!`;
    return (
      `${greeting} 👋 How are you? We're here to help you with your bookings 😊 at ${businessName}.\n\n` +
      `What would you like to do?\n` +
      `${NUMBER_EMOJI[0]} Book a table\n` +
      `${NUMBER_EMOJI[1]} Change or cancel a booking\n\n` +
      `Reply *1* or *2*, or just tell me what you need.`
    );
  },

  welcomeMessage(businessName: string): string {
    return (
      `👋 Hello!\n` +
      `I'm the booking assistant for *${businessName}*.\n` +
      `I'll help you reserve your table in just a few seconds.\n\n` +
      `What's your name? Please tell me your *first and last name*.`
    );
  },

  askPartySize(name: string): string {
    return (
      `✅ Perfect, *${name}*.\n\n` +
      `How many people is the booking for?\n\n` +
      `For example: 2, 4 or 6 people.`
    );
  },

  welcomeBackAskPartySize(customerName: string): string {
    return (
      `👋 Hello ${customerName}!\n\n` +
      `How many people is the booking for?\n\n` +
      `For example: 2, 4 or 6 people.`
    );
  },

  askScheduleChoice(eventTitles: string[] = [], includeToday: boolean = true): string {
    const options: string[] = [];
    if (includeToday) options.push('Today (current service)');
    options.push('Another date');
    options.push(...eventTitles);

    const lines = options.map((option, index) => `${NUMBER_EMOJI[index]} ${option}`).join('\n');
    const eventsNote = eventTitles.length > 0 ? ` You can also pick one of our events.` : '';

    return (
      `📅 Is the booking for...?\n\n` +
      `${lines}\n\n` +
      `Reply with the *number* of your choice, or just tell me the day (e.g. "Friday").${eventsNote}`
    );
  },

  askDayClosedToday(openDays?: string | null): string {
    if (openDays) {
      return (
        `❌ We're closed today.\n\n` +
        `📅 Which day would you prefer?\n` +
        `We're open on: *${openDays}*.\n\n` +
        `You can say "tomorrow", "Friday", etc.`
      );
    }
    return (
      `❌ We're closed today.\n\n` +
      `📅 Which day would you prefer? You can say "tomorrow", "Friday", etc.`
    );
  },

  askDayClosedTodayWithSchedule(dayLines: string[]): string {
    if (dayLines.length === 0) {
      return (
        `⛔ We're closed today and I couldn't find availability in the next 7 days.\n\n` +
        `Please write to us again later so we can arrange your booking.`
      );
    }
    const list = dayLines.join('\n');
    return (
      `⛔ We're closed today.\n\n` +
      `📅 Which of these days would you like to book?\n\n` +
      `${list}\n\n` +
      `Reply with the day you prefer (e.g. "Thursday" or "Thursday 09:15").`
    );
  },

  askDay(openDays?: string | null): string {
    if (openDays) {
      return (
        `📅 Which day would you prefer?\n` +
        `We're open on: *${openDays}*.\n\n` +
        `You can say "tomorrow", "Friday", etc.`
      );
    }
    return `📅 Which day would you prefer? You can say "tomorrow", "Friday", etc.`;
  },

  otherDaysSchedule(dayLines: string[]): string {
    if (dayLines.length === 0) {
      return "📅 I don't have any more days with availability to show you right now.";
    }
    const list = dayLines.map((line) => `• ${line}`).join('\n');
    return `📅 Here are the opening hours for the coming days:\n\n${list}`;
  },

  askTime(dayLabel: string, hoursRange?: string | null): string {
    const hoursNote = hoursRange ? ` (open: *${hoursRange}*)` : '';
    return `🕐 What time would you like to book on ${dayLabel}${hoursNote}?`;
  },

  askTodayTimeOpen(closeLabel: string | null): string {
    const closingNote = closeLabel ? ` (we're open until *${closeLabel}*)` : '';
    return (
      `🕐 What time would you like your booking today?${closingNote}\n\n` +
      `Type the time (e.g. "9:00 PM" or "half past nine"), or reply *now* if you want the current service.`
    );
  },

  /**
   * Confirms the event choice and leads into the summary. Sent AFTER the
   * photos so the text is the last message of the block.
   */
  eventSelected(title: string, description: string | null, whenLabel: string): string {
    const descriptionBlock = description ? `${description}\n\n` : '';
    return (
      `🎉 *${title}*\n\n` +
      `${descriptionBlock}` +
      `📅 ${whenLabel}\n\n` +
      `Great, let's continue with your booking for the event.`
    );
  },

  /** The event stopped being available between showing the menu and the reply. */
  eventNoLongerAvailable(title: string): string {
    return `😔 *${title}* is no longer available. Please pick another option.`;
  },

  /** Summary edit menu for an event booking: the event fixes the date and time. */
  summaryEditMenuEvent(): string {
    return (
      `What would you like to change?\n\n` +
      `1️⃣ Number of people\n` +
      `2️⃣ Pick another date or event\n\n` +
      `Reply with the *number* of your choice.`
    );
  },

  reservationSummary(
    name: string,
    partySize: number,
    whenLabel: string,
    fullName: string = name,
    eventTitle?: string | null
  ): string {
    const eventLine = eventTitle ? `🎉 Event: ${eventTitle}\n` : '';
    return (
      `📋 Before confirming, please check that everything is correct:\n\n` +
      `👤 Name: ${fullName}\n` +
      `👥 People: ${partySize}\n` +
      `${eventLine}` +
      `📅 Date and time: ${whenLabel}\n\n` +
      `Is everything correct?\n\n` +
      `1️⃣ Confirm booking\n` +
      `2️⃣ Change the booking`
    );
  },

  summaryEditMenu(): string {
    return (
      `What would you like to change?\n\n` +
      `1️⃣ Number of people\n` +
      `2️⃣ Date\n` +
      `3️⃣ Time\n\n` +
      `Reply with the *number* of your choice.`
    );
  },

  reservationConfirmed(
    name: string,
    partySize: number,
    whenLabel: string,
    displayCode: string,
    eventTitle?: string | null
  ): string {
    return (
      `✅ Booking confirmed, ${name}!\n` +
      `${reservationLine(whenLabel, partySize, displayCode)}${eventLine(eventTitle)}\n\n` +
      `See you soon 👋`
    );
  },

  reservationReceived(
    partySize: number,
    whenLabel: string,
    displayCode: string,
    eventTitle?: string | null
  ): string {
    return (
      `Done ✅\n` +
      `${reservationLine(whenLabel, partySize, displayCode)}${eventLine(eventTitle)}\n` +
      `I'll let you know as soon as the restaurant confirms.`
    );
  },

  // ============================
  // M2 — Modify a booking
  // ============================

  editMenu(
    partySize: number,
    whenLabel: string,
    displayCode: string,
    statusLabel: string,
    customerName?: string | null,
    eventTitle?: string | null
  ): string {
    const greeting = customerName ? `👋 Hello ${customerName}! What can I do for you today?\n\n` : '';
    const eventSuffix = eventTitle ? ` — 🎉 ${eventTitle}` : '';
    return (
      `${greeting}📋 You have 1 active booking:\n` +
      `• ${partySize} people, ${whenLabel} (${displayCode}) ${statusLabel}${eventSuffix}\n\n` +
      `What would you like to do?\n\n` +
      `1️⃣ Number of people\n` +
      `2️⃣ Date\n` +
      `3️⃣ Time\n` +
      `4️⃣ Create another booking\n\n` +
      `Reply with the *number* of your choice.\n\n` +
      `_To cancel your booking, type *CANCEL*._`
    );
  },

  editMenuInvalidChoice(): string {
    return `❌ Please reply with *1*, *2*, *3* or *4* depending on your choice.`;
  },

  partySizeUpdated(partySize: number): string {
    return `✅ Done! Your booking was updated to *${partySize}* people.`;
  },

  partySizeUpdateFailed(): string {
    return `❌ We couldn't update the number of people. Please try again.`;
  },

  scheduleUpdated(whenLabel: string): string {
    return `✅ Done! Your booking was moved to ${whenLabel}.`;
  },

  scheduleRevertedToInstant(): string {
    return `✅ Done! Your booking is back to the current service.`;
  },

  // ============================
  // M3 — Cancel a booking
  // ============================

  cancelMenu(partySize: number, whenLabel: string, displayCode: string): string {
    return (
      `📋 I found an active booking.\n\n` +
      `👥 People: *${partySize}*\n` +
      `📅 Date and time: ${whenLabel}\n` +
      `📁 Code: *${displayCode}*\n\n` +
      `What would you like to do?\n\n` +
      `1️⃣ Reschedule the booking\n` +
      `2️⃣ Cancel it permanently`
    );
  },

  cancelDirectConfirmPrompt(partySize: number, whenLabel: string, displayCode: string): string {
    return (
      `📋 I found your booking for *${partySize}* people on ${whenLabel} (code *${displayCode}*).\n\n` +
      `Shall we cancel this booking?\n\n` +
      `1️⃣ Yes, cancel it\n` +
      `2️⃣ Go back`
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
        return `*${reservation.index}* - ${reservation.partySize} people, ${reservation.whenLabel}${codeText} — ${reservation.statusLabel}${eventSuffix}`;
      })
      .join('\n');

    const prompt =
      action === 'cancel'
        ? `Reply with the *number* of the booking you want to cancel.`
        : action === 'edit'
          ? `Reply with the *number* of the booking you want to change.`
          : `Reply with the *number* of the booking to see options to change or cancel it.`;

    return (
      `📋 You have several active bookings:\n\n` +
      `${reservationsList}\n\n` +
      `${prompt}\n` +
      `Or type *BOOK* to create another booking.`
    );
  },

  activeReservationSelectionInvalid(): string {
    return `❌ I didn't recognise that option. Reply with the number of the booking you want to manage, or type *BOOK* to create a new one.`;
  },

  cancelMenuInvalidChoice(): string {
    return `❌ Reply *1* to reschedule or *2* to cancel permanently.`;
  },

  rescheduleIntro(): string {
    return `Perfect 👍\nLet's start by choosing a new date.`;
  },

  cancelConfirmPrompt(): string {
    return (
      `Are you sure you want to cancel your booking?\n\n` +
      `1️⃣ Yes, cancel it\n` +
      `2️⃣ No, keep the booking`
    );
  },

  cancelConfirmInvalidChoice(): string {
    return `❌ Reply *1* to cancel the booking or *2* to keep it.`;
  },

  reservationCancelled(): string {
    return (
      `✅ Your booking has been cancelled.\n\n` +
      `We hope to welcome you again soon.\n\n` +
      `Whenever you'd like to make a new booking, just type: *BOOK*`
    );
  },

  reservationKept(): string {
    return `👍 Great! Your booking is still active, exactly as it was. Anything else I can help you with?`;
  },

  cancelFailed(): string {
    return `❌ The booking could not be cancelled. Please contact the restaurant directly.`;
  },

  reservationOverlapConflict(
    requestedWhenLabel: string,
    conflictingWhenLabel: string,
    conflictingDisplayCode: string | null,
    conflictingStatusLabel: string
  ): string {
    const displayCodeText = conflictingDisplayCode ? ` (code *${conflictingDisplayCode}*)` : '';
    return (
      `⚠️ I can't create the booking for ${requestedWhenLabel} because it overlaps with another active booking on ${conflictingWhenLabel}` +
      `${displayCodeText} with status *${conflictingStatusLabel}*.` +
      `\n\nThere must be at least 120 minutes between bookings to avoid overlaps.` +
      `\n\nIf you'd like, reply *CANCEL* to cancel it and then create a new one.`
    );
  },

  noActiveReservation(): string {
    return `I couldn't find any active booking. Anything else I can help you with?`;
  },

  newReservationOverlapReminder(
    conflictingWhenLabel: string,
    conflictingDisplayCode: string | null,
    conflictingStatusLabel: string
  ): string {
    const displayCodeText = conflictingDisplayCode ? ` (code *${conflictingDisplayCode}*)` : '';
    return (
      `⚠️ Your new booking overlaps with an active booking on ${conflictingWhenLabel}` +
      `${displayCodeText} with status *${conflictingStatusLabel}*.` +
      `\n\nI can't create it because there must be at least 120 minutes between bookings.` +
      `\n\nIf you'd like, reply *CANCEL* to cancel it and then create a new one.`
    );
  },

  // ============================
  // Multi-action messages (cancel/query several bookings in one turn)
  // ============================

  cancelTargetNotFound(hasActiveReservations: boolean): string {
    return hasActiveReservations
      ? `⚠️ I couldn't tell which booking to cancel; type *CANCEL* and I'll show you your bookings.`
      : `⚠️ I couldn't find an active booking to cancel.`;
  },

  reservationCancelledInline(whenLabel: string, displayCode: string | null): string {
    const codeText = displayCode ? ` (code *${displayCode}*)` : '';
    return `✅ I cancelled your booking for ${whenLabel}${codeText}.`;
  },

  cancelActionFailed(): string {
    return `❌ I couldn't cancel one of the bookings. Please try again.`;
  },

  noActiveReservationsShort(): string {
    return `You don't have any active bookings at the moment.`;
  },

  // ============================
  // M8 — Unavailable time slots
  // ============================

  timeNotAvailable(reason: string, nextSlotTime: string): string {
    return (
      `That time isn't available. ${reason}\n\n` +
      `🕐 The next available time that day is *${nextSlotTime}*.\n\n` +
      `Shall we book it for then? Reply *yes* or *no*.`
    );
  },

  noMoreSlotsToday(reason: string): string {
    return `That time isn't available. ${reason} There are no more slots left that day. Would you like to choose another time or day?`;
  },

  suggestNextSlot(slotLabel: string, reason?: string | null): string {
    const prefix = reason ? `❌ ${reason}\n\n` : '';
    return (
      `${prefix}The soonest available slot is *${slotLabel}*.\n\n` +
      `Shall we book it for then? Reply *yes* to confirm, or tell me another day or time if you prefer.`
    );
  },

  // ============================
  // M8b — Business-configured date blocks
  // ============================

  dateBlocked(dayLabel: string, reasonMessage?: string | null): string {
    if (reasonMessage) {
      return `❌ ${reasonMessage}\n\nWould you like to choose another date?`;
    }
    return (
      `❌ Sorry, we're not taking bookings on *${dayLabel}*.\n\n` +
      `Would you like to choose another date?`
    );
  },

  futureReservationsBlockedToday(): string {
    return (
      `❌ For today we're not taking bookings for later services — only for the service running right now.\n\n` +
      `Would you like to join the queue for the current service, or book for another day?`
    );
  },

  // ============================
  // M9 — Input validation
  // ============================

  invalidDate(): string {
    return `I couldn't understand that date. Could you write it again? You can say "today", "tomorrow" or a day of the week (e.g. "Friday").`;
  },

  invalidTime(): string {
    return `Could you write the time again? For example: "21:00", "9pm" or "half past nine".`;
  },

  invalidPartySize(): string {
    return (
      `The number of people must be a number.\n\n` +
      `For example: 2, 4 or 6 people.\n\n` +
      `_(To cancel, type *cancel* or *exit*)_`
    );
  },

  invalidName(): string {
    return `I didn't recognise that as a name. What's your name for the booking?`;
  },

  nameChanged(name: string): string {
    return (
      `✅ Done! I've changed your name to *${name}*.\n\n` +
      `How many people is the booking for?\n\n` +
      `For example: 2, 4 or 6 people.`
    );
  },

  askPartySizeShort(): string {
    return `How many people is the booking for?\n\nFor example: 2, 4 or 6 people.`;
  },


  // ============================
  // Flow guards and prompts
  // ============================

  invalidNameRetry(): string {
    return `I didn't recognise that as a name. What's your name so we can continue with the booking?`;
  },

  askCorrectName(): string {
    return `What is your correct name so we can continue with the booking?`;
  },

  askCorrectNameField(field: 'full' | 'lastName'): string {
    return field === 'lastName'
      ? `What's your correct last name?`
      : `What's your correct first and last name?`;
  },

  invalidLastNameRetry(): string {
    return `I didn't catch that name. Could you repeat it, please?`;
  },

  noStoredCustomerData(): string {
    return `I don't have your details saved yet. Your name will be stored once you make a booking. 😊`;
  },

  customerNameUpdated(fullName: string): string {
    return `✅ Done, I've updated your name. You're now listed as *${fullName}*.`;
  },

  closedNoAvailability(): string {
    return `❌ We're closed right now and I couldn't find availability in the next 60 days.`;
  },

  closedSuggestNextSlot(slotLabel: string): string {
    return `❌ We're closed right now.\n\nThe next available slot is *${slotLabel}*.\n\nShall we book it for then? Reply *yes* or *no*.`;
  },

  outOfWindowPrefix(): string {
    return `For now I can only take bookings within the next 60 days. `;
  },

  outOfWindowAskDay(): string {
    return `For now I can only take bookings within the next 60 days. Which day would you like?`;
  },

  scheduleChoiceInvalid(optionCount: number = 2): string {
    if (optionCount <= 2) {
      return `❌ Reply *1* for now, or *2* to choose a day and time.`;
    }
    return `❌ Reply with a *number* from *1* to *${optionCount}*, or just tell me which day you'd like.`;
  },

  didntUnderstandTimeSuggest(slotTime: string): string {
    return `I didn't understand the time. The first available slot that day is *${slotTime}*.\n\nShall we book it for then? Reply *yes* or *no*.`;
  },

  hoursRejectedAskOther(reason: string | undefined): string {
    return `❌ ${prefix(reason)}Which other day and time would you like?`;
  },

  hoursRejectedSuggestSlot(reason: string | undefined, slotTime: string): string {
    return `❌ ${prefixBlock(reason)}The next available time that day is *${slotTime}*. Shall we book it for then? Reply *yes* or *no*.`;
  },

  hoursRejectedNoMoreSlots(reason: string | undefined): string {
    return `❌ ${prefix(reason)}There are no more slots left that day. Would you like to choose another time or day?`;
  },

  confirmSlotPrompt(slotLabel: string, hoursNote: string): string {
    return `Shall we confirm the booking for *${slotLabel}*?${hoursNote}\n\nReply *yes* or *no*.`;
  },

  dayClosedAskOtherDay(reason: string | undefined): string {
    return `❌ ${prefix(reason)}Which other day would you like to book?`;
  },

  carriedTimeHoursNote(hoursRange: string): string {
    return `\n\nThat day we're open from *${hoursRange}*. Tell me another time if you prefer.`;
  },

  didNotUnderstandDayAndTime(): string {
    return `❌ I didn't quite catch the day and time. Which day and time would you like?`;
  },

  askTimeAgain(): string {
    return `What time would you prefer then?`;
  },

  confirmSlotYesNoReminder(slotLabel: string | null): string {
    return slotLabel
      ? `Reply *yes* or *no*: shall we confirm the booking for *${slotLabel}*? (If you'd rather have another day or time, just tell me.)`
      : `Reply *yes* to confirm that time, or *no* to pick another one.`;
  },

  reservationRescheduled(whenLabel: string): string {
    return `✅ Done! Your booking has been updated to ${whenLabel}.`;
  },

  reservationUpdateFailed(): string {
    return `❌ We couldn't update your booking. Please try again.`;
  },

  askNewPartySize(): string {
    return `How many people would you like to change the booking to?\n\nFor example: 2, 4 or 6 people.`;
  },

  weekdayAmbiguityPrompt(weekdayLabel: string, nextLabel: string): string {
    return `Do you mean *today, ${weekdayLabel}*, or *${nextLabel}* next week?\n\nReply *1* for today or *2* for next week.`;
  },

  weekdayAmbiguityInvalid(weekday: string): string {
    return `I didn't understand. Reply *1* for today or *2* for next ${weekday}.`;
  },

  weekdayDayMismatchPrompt(weekdayLabel: string, requestedDayNumber: number, nearestLabel: string): string {
    return `For now I can only take bookings within the *next 60 days*, so I can't book for *${weekdayLabel} the ${requestedDayNumber}*.\n\nWould you like *${nearestLabel}* (the next ${weekdayLabel}) instead?\n\nReply *yes* or *no*.`;
  },

  weekdayDayMismatchInvalid(nearestLabel: string): string {
    return `I didn't understand. Reply *yes* for ${nearestLabel}, or *no* to pick another day.`;
  },

  timeAlreadyPassedSuggestTomorrow(timeLabel: string, tomorrowLabel: string): string {
    return `That time has already passed today. Can we book for tomorrow at *${timeLabel}* (${tomorrowLabel})?\n\nReply *yes* or *no*.`;
  },

  timeAlreadyPassed(): string {
    return `❌ That time has already passed. Tell me another time, or another day if you prefer.`;
  },

  noActiveReservationsInquiry(): string {
    return `You don't have any active bookings at the moment. If you'd like, you can create a new one by typing *BOOK*.`;
  },

  firstContactNoReservations(businessName: string): string {
    return (
      `👋 Hi! I'm the booking assistant for *${businessName}*.\n\n` +
      `You don't have any bookings with us yet — this is the first time we talk.\n\n` +
      `I can help you *book a table*, and later *change* or *cancel* it.\n\n` +
      `Want to book? Just type *BOOK* and we'll get started.`
    );
  },

  reservationConfirmedNotice(
    name: string,
    partySize: number,
    displayCode: string,
    whenLabel: string,
    eventTitle?: string | null
  ): string {
    return (
      `✅ Booking confirmed, ${name}!\n` +
      `${reservationLine(whenLabel, partySize, displayCode)}${eventLine(eventTitle)}\n\n` +
      `See you soon 👋`
    );
  },

  reservationRegisteredNotice(
    partySize: number,
    displayCode: string,
    whenLabel: string,
    eventTitle?: string | null
  ): string {
    return (
      `Done ✅\n` +
      `${reservationLine(whenLabel, partySize, displayCode)}${eventLine(eventTitle)}\n` +
      `I'll let you know as soon as the restaurant confirms.`
    );
  },

  reservationUpcomingReminder(
    name: string,
    partySize: number,
    whenLabel: string,
    displayCode: string,
    minutesUntil: number
  ): string {
    return (
      `⏰ A reminder about your booking\n\n` +
      `👤 Name: ${name}\n` +
      `👥 People: ${partySize}\n` +
      `🗓️ ${whenLabel}\n` +
      `📁 Booking code: *${displayCode}*\n\n` +
      `${countdownLabel(minutesUntil)} to go. See you soon!\n\n` +
      `_If you can't make it, reply *CANCEL* and we'll free up the table._`
    );
  },

  reservationArrivalReminder(
    whenLabel: string,
    displayCode: string,
    minutesUntil: number
  ): string {
    return (
      `🔔 ${countdownLabel(minutesUntil)} until your booking\n\n` +
      `🗓️ ${whenLabel}\n` +
      `📁 Booking code: *${displayCode}*\n\n` +
      `You should be nearby by now. See you soon!`
    );
  },

  /** The business deleted an event, cancelling its bookings. See es.ts. */
  eventCancelledByBusiness(
    name: string,
    eventTitle: string,
    displayCode: string,
    whenLabel: string | null
  ): string {
    return (
      `❌ The event *${eventTitle}* was cancelled by the restaurant.\n\n` +
      `Your booking for that event is no longer valid.\n\n` +
      `👤 Name: ${name}\n` +
      (whenLabel ? `🗓️ It was for: ${whenLabel}\n` : '') +
      `📁 Booking code: *${displayCode}*\n\n` +
      `We're sorry for the inconvenience.\n` +
      `_If you'd like to book for another time, just write to us and we'll sort it out._`
    );
  },

  reservationCancelledByBusiness(
    name: string,
    displayCode: string,
    whenLabel: string | null
  ): string {
    return (
      `❌ Your booking was cancelled by the restaurant.\n\n` +
      `👤 Name: ${name}\n` +
      (whenLabel ? `🗓️ It was for: ${whenLabel}\n` : '') +
      `📁 Booking code: *${displayCode}*\n\n` +
      `We're sorry for the inconvenience.\n` +
      `_If you'd like to book for another time, just write to us and we'll sort it out._`
    );
  },

  tableReadyNotice(): string {
    return (
      `🍽️ Your table is ready!\n` +
      `You can take it within the next 20 minutes.\n\n` +
      `After that, the booking may be released.`
    );
  },

  postReservationCourtesyReply(reservationRef: string, isPending: boolean, isGratitude: boolean): string {
    if (isPending) {
      return isGratitude
        ? `You're welcome! 🙌\n\nYour booking${reservationRef} is still pending confirmation. We'll let you know as soon as it's confirmed.`
        : `Perfect! 🙌\n\nYour booking${reservationRef} is still pending confirmation. We'll let you know as soon as it's confirmed.`;
    }
    return isGratitude
      ? `You're welcome! 🙌\n\nYour booking${reservationRef} is already confirmed. If you need anything else, I'm here to help.`
      : `Great! 🙌\n\nYour booking${reservationRef} is already confirmed. If you need anything else, I'm here to help.`;
  },

  // ============================
  // M11 — Welcome at the restaurant
  // ============================

  // ============================
  // Flow / guard messages
  // ============================

  askName(): string {
    return `What's your first and last name for the booking?`;
  },

  askNameAgain(): string {
    return `What's your first and last name so we can continue with the booking?`;
  },

  askLastName(firstName: string): string {
    return `Thank you, *${firstName}*. What's your last name?`;
  },

  askLastNameAgain(): string {
    return `I didn't catch the last name. Could you repeat it, please?`;
  },

  processCancelled(): string {
    return `✅ Process cancelled. You can start again whenever you like.`;
  },

  tooManyInvalidAttempts(): string {
    return `❌ Too many invalid attempts. The process was cancelled. You can start again whenever you like.`;
  },

  confirmSummaryInvalidChoice(): string {
    return `❌ Reply *1* to confirm the booking or *2* to change it.`;
  },

  // ============================
  // Scope guards
  // ============================

  reservationIntro(businessName: string): string {
    return `Hello! 👋 I'm the assistant for ${businessName} and I'm here to take bookings. What's your name?`;
  },

  reservationOffTopic(businessName: string): string {
    return `Hello 😊 I can only help with booking-related questions for “${businessName}” for the current service. Would you like to make a booking?`;
  },

  reservationOutOfWindow(businessName: string): string {
    return `Hello 😊 At “${businessName}” I can currently only take bookings within the next 60 days. Would you like to choose a closer day?`;
  },

  inactiveFallback(): string {
    return `Sorry, our WhatsApp service is unavailable right now. Please try again later.`;
  },

  genericError(): string {
    return `Sorry, something went wrong handling your message. Could you send it again?`;
  },
};
