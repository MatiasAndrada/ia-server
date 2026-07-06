import { normalizeReservationScopeText } from './reservation-scope';
import type { WeeklyHours, WeeklyHoursDayKey, WeeklyHoursShift } from '../types';

/** Buenos Aires has no DST — fixed UTC-3 offset. */
export const BA_OFFSET_MS = 3 * 60 * 60 * 1000;

const WEEKDAY_KEYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const WEEKDAY_LABELS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const REQUESTED_DAY_WINDOW = 7; // today + next 6 days

export interface ParsedDay {
  /** A Date whose UTC getters reflect the Buenos Aires wall-clock day, time zeroed out. */
  baDate: Date;
  label: string;
  isToday: boolean;
  /**
   * True when the day was resolved by naming an explicit weekday (e.g. "el
   * jueves"), as opposed to "hoy"/"mañana"/"pasado mañana". Combined with
   * `isToday`, signals a genuine ambiguity: naming today's own weekday could
   * mean today OR next week, and the caller should confirm which.
   */
  matchedWeekdayName: boolean;
}

export interface ParsedTime {
  hour: number;
  minute: number;
}

/**
 * Current moment represented so that its UTC getters (getUTCFullYear, getUTCDate,
 * getUTCDay, getUTCHours...) reflect the Buenos Aires LOCAL wall-clock fields.
 * Mirrors the offset trick already used in SupabaseService for "start of day in BA".
 */
export function nowInBuenosAires(): Date {
  return new Date(Date.now() - BA_OFFSET_MS);
}

export function startOfBaDay(baDate: Date): Date {
  const start = new Date(baDate);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** Serializes a BA calendar day (as produced by parseRelativeDay) to "YYYY-MM-DD". */
export function formatBaDateKey(baDate: Date): string {
  const yyyy = baDate.getUTCFullYear();
  const mm = String(baDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(baDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Inverse of {@link formatBaDateKey} — reconstructs the BA calendar day Date. */
export function parseBaDateKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** Human label ("viernes 17/07" or "hoy 17/07") for a stored "YYYY-MM-DD" day key. */
export function describeBaDateKey(key: string, nowBA: Date): string {
  const baDate = parseBaDateKey(key);
  const isToday = formatBaDateKey(startOfBaDay(nowBA)) === key;
  return formatDayLabel(baDate, isToday);
}

export function addBaDays(baDate: Date, days: number): Date {
  const result = new Date(baDate);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function formatDayLabel(baDate: Date, isToday: boolean): string {
  const dayName = isToday ? 'hoy' : WEEKDAY_LABELS[baDate.getUTCDay()];
  const dd = String(baDate.getUTCDate()).padStart(2, '0');
  const mm = String(baDate.getUTCMonth() + 1).padStart(2, '0');
  return `${dayName} ${dd}/${mm}`;
}

/**
 * Parses a relative/weekday day reference ("hoy", "mañana", "pasado mañana",
 * "el viernes", etc.) relative to `nowBA` (see {@link nowInBuenosAires}).
 * Always resolves to a day within the next 7-day rolling window, since weekday
 * lookups pick the NEAREST occurrence (today included).
 */
export function parseRelativeDay(text: string, nowBA: Date): ParsedDay | null {
  const normalized = normalizeReservationScopeText(text);
  const todayStart = startOfBaDay(nowBA);

  if (/\bpasado\s+manana\b/.test(normalized)) {
    const baDate = addBaDays(todayStart, 2);
    return { baDate, label: formatDayLabel(baDate, false), isToday: false, matchedWeekdayName: false };
  }

  if (/\bmanana\b/.test(normalized)) {
    const baDate = addBaDays(todayStart, 1);
    return { baDate, label: formatDayLabel(baDate, false), isToday: false, matchedWeekdayName: false };
  }

  if (/\bhoy\b/.test(normalized)) {
    return { baDate: todayStart, label: formatDayLabel(todayStart, true), isToday: true, matchedWeekdayName: false };
  }

  for (let i = 0; i < WEEKDAY_KEYS.length; i += 1) {
    if (new RegExp(`\\b${WEEKDAY_KEYS[i]}\\b`).test(normalized)) {
      const todayDow = todayStart.getUTCDay();
      const diff = (i - todayDow + 7) % 7;
      const baDate = addBaDays(todayStart, diff);
      return { baDate, label: formatDayLabel(baDate, diff === 0), isToday: diff === 0, matchedWeekdayName: true };
    }
  }

  return null;
}

export interface WeekdayDayNumberMismatch {
  /** The day-of-month number the customer explicitly typed (e.g. 17 in "jueves 17"). */
  requestedDayNumber: number;
  /** Lowercase weekday label, e.g. "jueves". */
  weekdayLabel: string;
}

/**
 * Detects when the customer named a weekday together with an explicit
 * day-of-month number that does NOT match the nearest in-window occurrence of
 * that weekday (e.g. "jueves 17" when the closest bookable Thursday is the
 * 9th) — the customer almost certainly means a date further out than the
 * 7-day booking window, and `parseRelativeDay` would otherwise silently
 * resolve to the nearest Thursday instead, ignoring the "17".
 *
 * Only matches a number immediately adjacent to the weekday token (in either
 * order) so that time-of-day mentions in the same message ("jueves a las 17",
 * "jueves 17hs") are not mistaken for a day-of-month reference.
 */
export function findWeekdayDayNumberMismatch(
  text: string,
  parsedDay: ParsedDay
): WeekdayDayNumberMismatch | null {
  if (!parsedDay.matchedWeekdayName) return null;

  const normalized = normalizeReservationScopeText(text);
  const weekdayAlternation = WEEKDAY_KEYS.join('|');
  const timeSuffixGuard = '(?!\\s*(?::|hs\\b|horas\\b|am\\b|pm\\b))';

  const dayAfterWeekday = new RegExp(
    `\\b(?:${weekdayAlternation})\\s+(\\d{1,2})\\b${timeSuffixGuard}`
  );
  const dayBeforeWeekday = new RegExp(
    `\\b(\\d{1,2})\\s+(?:${weekdayAlternation})\\b`
  );

  const match = normalized.match(dayAfterWeekday) ?? normalized.match(dayBeforeWeekday);
  if (!match) return null;

  const requestedDayNumber = parseInt(match[1], 10);
  if (requestedDayNumber < 1 || requestedDayNumber > 31) return null;
  if (requestedDayNumber === parsedDay.baDate.getUTCDate()) return null;

  return {
    requestedDayNumber,
    weekdayLabel: WEEKDAY_LABELS[parsedDay.baDate.getUTCDay()],
  };
}

/** True when `baDate` falls within [today, today + 6 days] in Buenos Aires time. */
export function isWithinNextWeek(baDate: Date, nowBA: Date): boolean {
  const start = startOfBaDay(nowBA);
  const end = addBaDays(start, REQUESTED_DAY_WINDOW - 1);
  return baDate.getTime() >= start.getTime() && baDate.getTime() <= end.getTime();
}

function clampTime(hour: number, minute: number): ParsedTime | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Bumps an ambiguous 1-11 hour into the evening when the message qualifies it as such. */
function applyTimeOfDayQualifier(normalized: string, hour: number): number {
  if (hour >= 1 && hour <= 11 && /\bde\s+la\s+(noche|tarde)\b/.test(normalized)) {
    return hour + 12;
  }
  return hour;
}

/**
 * Parses a time-of-day reference: "20:30", "20:30hs"/"20:30 hs", "8pm",
 * "a las 21", "9 y media", "21 hs", or a bare number ("21", "9") answering
 * "¿a qué hora?".
 */
export function parseTimeOfDay(text: string): ParsedTime | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const normalized = normalizeReservationScopeText(trimmed);

  let match = lower.match(/\b([01]?\d|2[0-3])[:.](\d{2})\s?(?:hs\.?|horas)?\b/);
  if (match) {
    return clampTime(parseInt(match[1], 10), parseInt(match[2], 10));
  }

  match = lower.match(/\b(1[0-2]|0?\d)(?:[:.](\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)\b/);
  if (match) {
    let hour = parseInt(match[1], 10) % 12;
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    if (/^p/.test(match[3])) hour += 12;
    return clampTime(hour, minute);
  }

  match = normalized.match(/\b(\d{1,2})\s*y\s*media\b/);
  if (match) return clampTime(parseInt(match[1], 10), 30);

  match = normalized.match(/\b(\d{1,2})\s*y\s*cuarto\b/);
  if (match) return clampTime(parseInt(match[1], 10), 15);

  match = normalized.match(/\b(\d{1,2})\s*menos\s*(?:cuarto|quince)\b/);
  if (match) return clampTime(parseInt(match[1], 10) - 1, 45);

  match = normalized.match(/(?<![:.])\b([01]?\d|2[0-3])\s?(?:hs|horas)\b/);
  if (match) return clampTime(parseInt(match[1], 10), 0);

  match = normalized.match(
    /\b(?:a\s+las|para\s+las|tipo\s+las|como\s+a\s+las|como\s+las|sobre\s+las|a\s+eso\s+de\s+las|eso\s+de\s+las)\s+(\d{1,2})(?::(\d{2}))?\b/
  );
  if (match) {
    const hour = applyTimeOfDayQualifier(normalized, parseInt(match[1], 10));
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    return clampTime(hour, minute);
  }

  // "23 30" — space-separated hour and minute (no colon). Must be the entire
  // message (anchored) to avoid misfiring inside longer sentences. Matched
  // before the bare-number fallback so "23 30" beats a bare-"23" read.
  match = normalized.match(/^(\d{1,2})\s(\d{2})$/);
  if (match) {
    const hour = applyTimeOfDayQualifier(normalized, parseInt(match[1], 10));
    return clampTime(hour, parseInt(match[2], 10));
  }

  match = normalized.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (match) {
    const hour = applyTimeOfDayQualifier(normalized, parseInt(match[1], 10));
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    return clampTime(hour, minute);
  }

  return null;
}

/** Combines a BA calendar day + hour/minute into the equivalent UTC ISO instant. */
export function combineToUtcISO(baDate: Date, hour: number, minute: number): string {
  const combined = new Date(baDate);
  combined.setUTCHours(hour, minute, 0, 0);
  return new Date(combined.getTime() + BA_OFFSET_MS).toISOString();
}

export function isInPast(utcISO: string): boolean {
  return new Date(utcISO).getTime() < Date.now();
}

/** Human-readable "viernes 17/07 a las 21:00" label for confirmation messages. */
export function formatScheduledLabel(baDate: Date, hour: number, minute: number, isToday: boolean): string {
  const dayLabel = formatDayLabel(baDate, isToday);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${dayLabel} a las ${hh}:${mm}`;
}

/** Same as {@link formatScheduledLabel} but starting from a stored "YYYY-MM-DD" day key. */
export function describeScheduledDateTime(dateKey: string, hour: number, minute: number, nowBA: Date): string {
  const baDate = parseBaDateKey(dateKey);
  const isToday = formatBaDateKey(startOfBaDay(nowBA)) === dateKey;
  return formatScheduledLabel(baDate, hour, minute, isToday);
}

/** Decomposes a stored `scheduled_at` UTC ISO instant into Buenos Aires local parts. */
export function utcIsoToBaParts(utcISO: string): { dateKey: string; hour: number; minute: number } {
  const instant = new Date(utcISO);
  const baInstant = new Date(instant.getTime() - BA_OFFSET_MS);
  return {
    dateKey: formatBaDateKey(startOfBaDay(baInstant)),
    hour: baInstant.getUTCHours(),
    minute: baInstant.getUTCMinutes(),
  };
}

/** Same as {@link formatScheduledLabel} but starting from a stored `scheduled_at` UTC ISO instant. */
export function describeScheduledAtUtc(utcISO: string, nowBA: Date): string {
  const instant = new Date(utcISO);
  const baInstant = new Date(instant.getTime() - BA_OFFSET_MS);
  const baDate = startOfBaDay(baInstant);
  const isToday = formatBaDateKey(baDate) === formatBaDateKey(startOfBaDay(nowBA));
  return formatScheduledLabel(baDate, baInstant.getUTCHours(), baInstant.getUTCMinutes(), isToday);
}

// ─── Business hours validation ───────────────────────────────────────────────

const DOW_TO_KEY: WeeklyHoursDayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_LABELS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isMinuteInShift(t: number, shift: WeeklyHoursShift, closingMarginMinutes = 0): boolean {
  const open = minutesOfDay(shift.open);
  // "00:00" as close = end of day (midnight = 1440 min, no cross-midnight)
  const close = (shift.close === '00:00' ? 24 * 60 : minutesOfDay(shift.close)) - closingMarginMinutes;
  if (close > open) {
    return t >= open && t < close;
  }
  // Cross-midnight shift: valid in the evening (>= open) or early morning (< close)
  return t >= open || t < close;
}

/** Human-readable shift ranges for a day, e.g. "08:00–14:00 y 17:00–02:00". */
export function formatDayHours(dayKey: WeeklyHoursDayKey, weeklyHours: WeeklyHours): string {
  const entry = weeklyHours[dayKey];
  if (!entry || entry.closed || entry.shifts.length === 0) return 'cerrado';
  return entry.shifts.map(s => `${s.open}–${s.close}`).join(' y ');
}

/**
 * Finds the next business opening slot starting from `nowBA`, adding `marginMinutes`
 * to the raw opening time (e.g. open=08:00 + margin=15 → slot=08:15).
 * Looks up to 7 days ahead. Returns null if no slot found within that window.
 */
export function findNextOpenSlot(
  nowBA: Date,
  weeklyHours: WeeklyHours,
  marginMinutes: number,
  closingMarginMinutes = 0
): { baDate: Date; hour: number; minute: number; label: string; isToday: boolean } | null {
  const nowMin = nowBA.getUTCHours() * 60 + nowBA.getUTCMinutes();
  const todayStart = startOfBaDay(nowBA);

  for (let daysAhead = 0; daysAhead < 7; daysAhead++) {
    const checkDate = addBaDays(todayStart, daysAhead);
    const dayKey = DOW_TO_KEY[checkDate.getUTCDay()];
    const entry = weeklyHours[dayKey];
    if (!entry || entry.closed || entry.shifts.length === 0) continue;

    for (const shift of entry.shifts) {
      const openMin = minutesOfDay(shift.open);
      const slotMin = openMin + marginMinutes;
      const closeMin = (shift.close === '00:00' ? 24 * 60 : minutesOfDay(shift.close)) - closingMarginMinutes;

      // The opening-margin slot must still leave room before the closing margin cutoff
      if (closeMin > openMin && slotMin >= closeMin) continue;

      // On the same day we must look strictly ahead of the current time
      if (daysAhead === 0 && slotMin <= nowMin) continue;

      // If margin pushes the slot past midnight, advance to the next calendar day
      if (slotMin >= 24 * 60) {
        const nextDate = addBaDays(checkDate, 1);
        const h = Math.floor((slotMin % (24 * 60)) / 60);
        const m = slotMin % 60;
        return { baDate: nextDate, hour: h, minute: m, label: formatScheduledLabel(nextDate, h, m, false), isToday: false };
      }

      const h = Math.floor(slotMin / 60);
      const m = slotMin % 60;
      const isToday = daysAhead === 0;
      return { baDate: checkDate, hour: h, minute: m, label: formatScheduledLabel(checkDate, h, m, isToday), isToday };
    }
  }

  return null;
}

/**
 * Given a moment already known to fall within business hours (i.e.
 * `checkBusinessHours` returned `allowed: true`), finds the effective closing
 * time (already reduced by `closingMarginMinutes`) of the shift currently in
 * progress. Used to tell the customer how much time is left when offering to
 * pick today's own reservation hour instead of an instant/current-turn one.
 * Mirrors `checkBusinessHours`'s own shift lookup so the result always
 * matches what made the moment "allowed" in the first place.
 */
export function findCurrentShiftClose(
  baDate: Date,
  hour: number,
  minute: number,
  weeklyHours: WeeklyHours,
  closingMarginMinutes = 0
): { hour: number; minute: number } | null {
  const dow = baDate.getUTCDay();
  const dayKey = DOW_TO_KEY[dow];
  const prevDayKey = DOW_TO_KEY[(dow + 6) % 7];
  const t = hour * 60 + minute;

  const dayEntry = weeklyHours[dayKey];
  const prevDayEntry = weeklyHours[prevDayKey];

  const activeShift = dayEntry && !dayEntry.closed
    ? dayEntry.shifts.find(s => isMinuteInShift(t, s, closingMarginMinutes))
    : undefined;

  if (activeShift) {
    const closeMin = Math.max(
      0,
      (activeShift.close === '00:00' ? 24 * 60 : minutesOfDay(activeShift.close)) - closingMarginMinutes
    ) % (24 * 60);
    return { hour: Math.floor(closeMin / 60), minute: closeMin % 60 };
  }

  if (hour <= 6 && prevDayEntry && !prevDayEntry.closed) {
    const crossMidnightShift = prevDayEntry.shifts.find(s => {
      const c = minutesOfDay(s.close);
      const o = minutesOfDay(s.open);
      return s.close !== '00:00' && c < o && t < c - closingMarginMinutes;
    });
    if (crossMidnightShift) {
      const closeMin = Math.max(0, minutesOfDay(crossMidnightShift.close) - closingMarginMinutes) % (24 * 60);
      return { hour: Math.floor(closeMin / 60), minute: closeMin % 60 };
    }
  }

  return null;
}

/**
 * Given a day and a time that was rejected as outside business hours, finds the
 * next shift opening on the SAME day strictly after `afterMinutes`, adding `marginMinutes`.
 * Returns null if there are no more openings that day (caller should fall back to an error
 * message asking to pick a different day/time).
 */
export function findNextSlotOnDay(
  baDate: Date,
  afterMinutes: number,
  weeklyHours: WeeklyHours,
  marginMinutes: number,
  closingMarginMinutes = 0
): { hour: number; minute: number } | null {
  const dayKey = DOW_TO_KEY[baDate.getUTCDay()];
  const entry = weeklyHours[dayKey];
  if (!entry || entry.closed || entry.shifts.length === 0) return null;

  for (const shift of entry.shifts) {
    const openMin = minutesOfDay(shift.open);
    const slotMin = openMin + marginMinutes;
    const closeMin = (shift.close === '00:00' ? 24 * 60 : minutesOfDay(shift.close)) - closingMarginMinutes;
    const effectiveClose = closeMin > openMin ? Math.min(closeMin, 24 * 60) : 24 * 60;
    if (slotMin > afterMinutes && slotMin < effectiveClose) {
      return { hour: Math.floor(slotMin / 60), minute: slotMin % 60 };
    }
  }

  return null;
}

/**
 * Returns whether the business is open on the given BA calendar day at all.
 * Use at the `date` step — rejects only days explicitly marked closed.
 */
export function isDayOpen(
  baDate: Date,
  weeklyHours: WeeklyHours
): { open: boolean; reason?: string } {
  const dow = baDate.getUTCDay();
  const dayKey = DOW_TO_KEY[dow];
  const entry = weeklyHours[dayKey];
  if (!entry || entry.closed || entry.shifts.length === 0) {
    return { open: false, reason: `El local está cerrado los ${DOW_LABELS_ES[dow]}.` };
  }
  return { open: true };
}

/**
 * Returns whether a specific hour:minute on the given BA calendar day falls within
 * any of the business's configured shifts.
 * Handles cross-midnight shifts (e.g. "17:00–02:00") and checks the previous day's
 * late shifts for early-morning times (00:00–06:00).
 */
export function checkBusinessHours(
  baDate: Date,
  hour: number,
  minute: number,
  weeklyHours: WeeklyHours,
  closingMarginMinutes = 0
): { allowed: boolean; reason?: string } {
  const dow = baDate.getUTCDay();
  const dayKey = DOW_TO_KEY[dow];
  const prevDayKey = DOW_TO_KEY[(dow + 6) % 7];
  const t = hour * 60 + minute;

  const dayEntry = weeklyHours[dayKey];
  const prevDayEntry = weeklyHours[prevDayKey];

  // Check current day's shifts
  if (dayEntry && !dayEntry.closed && dayEntry.shifts.some(s => isMinuteInShift(t, s, closingMarginMinutes))) {
    return { allowed: true };
  }

  // For early-morning bookings (00:00–06:00), also cover the previous day's cross-midnight shifts
  if (hour <= 6 && prevDayEntry && !prevDayEntry.closed) {
    const crossMidnight = prevDayEntry.shifts.filter(s => {
      const c = minutesOfDay(s.close);
      const o = minutesOfDay(s.open);
      return s.close !== '00:00' && c < o;
    });
    if (crossMidnight.some(s => t < minutesOfDay(s.close) - closingMarginMinutes)) {
      return { allowed: true };
    }
  }

  if (!dayEntry || dayEntry.closed || dayEntry.shifts.length === 0) {
    return { allowed: false, reason: `El local está cerrado los ${DOW_LABELS_ES[dow]}.` };
  }

  const hoursDesc = formatDayHours(dayKey, weeklyHours);
  return {
    allowed: false,
    reason: `El ${DOW_LABELS_ES[dow]} el local abre de ${hoursDesc}. Por favor elegí un horario dentro de ese rango.`,
  };
}
