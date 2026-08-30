import {
  startOfBaDay,
  formatBaDateKey,
  parseBaDateKey,
  describeBaDateKey,
  parseRelativeDay,
  isWithinBookingWindow,
  findWeekdayDayNumberMismatch,
  parseTimeOfDay,
  combineToUtcISO,
  isInPast,
  nowInBuenosAires,
  BA_OFFSET_MS,
  formatScheduledLabel,
  describeScheduledDateTime,
  describeScheduledAtUtc,
  formatDayHours,
  findNextOpenSlot,
  findNextSlotOnDay,
  findSoonestBookableSlot,
  formatBookableDays,
  isDayOpen,
  checkBusinessHours,
} from '../../utils/reservation-datetime.js';
import type { WeeklyHours } from '../../types/index.js';

// Thursday 2026-07-02, 12:00 BA wall-clock time (represented per the module's
// "UTC getters reflect BA local time" convention).
const NOW_BA = new Date('2026-07-02T12:00:00.000Z');

describe('reservation-datetime', () => {
  describe('startOfBaDay', () => {
    it('zeroes out the time while keeping the calendar day', () => {
      const start = startOfBaDay(NOW_BA);
      expect(start.getUTCHours()).toBe(0);
      expect(start.getUTCMinutes()).toBe(0);
      expect(start.getUTCSeconds()).toBe(0);
      expect(start.getUTCFullYear()).toBe(2026);
      expect(start.getUTCMonth()).toBe(6);
      expect(start.getUTCDate()).toBe(2);
    });
  });

  describe('formatBaDateKey / parseBaDateKey', () => {
    it('round-trips a BA calendar day', () => {
      const key = formatBaDateKey(startOfBaDay(NOW_BA));
      expect(key).toBe('2026-07-02');
      expect(formatBaDateKey(parseBaDateKey(key))).toBe(key);
    });
  });

  describe('describeBaDateKey', () => {
    it('labels the current day as "hoy"', () => {
      expect(describeBaDateKey('2026-07-02', NOW_BA)).toBe('hoy 02/07');
    });

    it('labels a future day by weekday name', () => {
      expect(describeBaDateKey('2026-07-03', NOW_BA)).toBe('viernes 03/07');
    });
  });

  describe('parseRelativeDay', () => {
    it('parses "hoy"', () => {
      const result = parseRelativeDay('hoy', NOW_BA);
      expect(result?.isToday).toBe(true);
      expect(result?.label).toBe('hoy 02/07');
    });

    it('parses "mañana"', () => {
      const result = parseRelativeDay('mañana', NOW_BA);
      expect(result?.isToday).toBe(false);
      expect(result?.label).toBe('viernes 03/07');
    });

    it('parses "pasado mañana"', () => {
      const result = parseRelativeDay('pasado mañana', NOW_BA);
      expect(result?.label).toBe('sábado 04/07');
    });

    it('resolves a weekday name to the nearest occurrence (today included)', () => {
      const sameDay = parseRelativeDay('el jueves', NOW_BA);
      expect(sameDay?.isToday).toBe(true);
      expect(sameDay?.label).toBe('hoy 02/07');

      const nextDay = parseRelativeDay('el viernes', NOW_BA);
      expect(nextDay?.isToday).toBe(false);
      expect(nextDay?.label).toBe('viernes 03/07');
    });

    it('returns null when no day reference is found', () => {
      expect(parseRelativeDay('quiero una mesa para 4', NOW_BA)).toBeNull();
    });

    describe('explicit "dd/mm" dates', () => {
      it('parses a valid date within the booking window', () => {
        const result = parseRelativeDay('20/07', NOW_BA);
        expect(result?.matchedWeekdayName).toBe(false);
        expect(result && formatBaDateKey(result.baDate)).toBe('2026-07-20');
      });

      it('returns a date even when it falls outside the booking window, so the caller can reject it with the specific message', () => {
        const result = parseRelativeDay('15/08', NOW_BA);
        expect(result).not.toBeNull();
        expect(result && formatBaDateKey(result.baDate)).toBe('2026-08-15');
        expect(result && isWithinBookingWindow(result.baDate, NOW_BA)).toBe(false);
      });

      it('returns null for a calendar-impossible date (April has 30 days)', () => {
        expect(parseRelativeDay('31/04', NOW_BA)).toBeNull();
      });

      it('rolls over to next year when the date already passed this year', () => {
        const yearEnd = new Date('2026-12-28T12:00:00.000Z'); // Monday 2026-12-28 BA
        const result = parseRelativeDay('05/01', yearEnd);
        expect(result && formatBaDateKey(result.baDate)).toBe('2027-01-05');
      });
    });

    describe('"que viene" / "próximo" weekday qualifier', () => {
      it('resolves to the occurrence after the nearest one, not the nearest', () => {
        // NOW_BA is itself a Thursday — "el jueves" alone resolves to today
        // (see the nearest-occurrence test above); "que viene" must skip it.
        const result = parseRelativeDay('el jueves que viene', NOW_BA);
        expect(result?.isToday).toBe(false);
        expect(result?.matchedWeekdayName).toBe(true);
        expect(result && formatBaDateKey(result.baDate)).toBe('2026-07-09');
      });

      it('accepts "próximo jueves" and "jueves próximo" as the same qualifier', () => {
        expect(parseRelativeDay('próximo jueves', NOW_BA) && formatBaDateKey(parseRelativeDay('próximo jueves', NOW_BA)!.baDate)).toBe('2026-07-09');
        expect(parseRelativeDay('jueves próximo', NOW_BA) && formatBaDateKey(parseRelativeDay('jueves próximo', NOW_BA)!.baDate)).toBe('2026-07-09');
      });
    });

    describe('weekday + explicit day-of-month', () => {
      it('resolves directly when the day-of-month is a real occurrence of that weekday in the window', () => {
        // Thursdays in the 30-day window from 2026-07-02: 2, 9, 16, 23, 30.
        const result = parseRelativeDay('jueves 16', NOW_BA);
        expect(result?.matchedWeekdayName).toBe(true);
        expect(result?.isToday).toBe(false);
        expect(result && formatBaDateKey(result.baDate)).toBe('2026-07-16');
      });

      it('falls back to the nearest occurrence when no in-window date matches both the weekday and the day-of-month', () => {
        // The 15th is a Wednesday, and no Thursday in the window falls on the 15th.
        const result = parseRelativeDay('jueves 15', NOW_BA);
        expect(result?.matchedWeekdayName).toBe(true);
        expect(result && formatBaDateKey(result.baDate)).toBe('2026-07-02'); // nearest Thursday = today
      });
    });
  });

  describe('isWithinBookingWindow', () => {
    it('accepts today through today+29', () => {
      expect(isWithinBookingWindow(startOfBaDay(NOW_BA), NOW_BA)).toBe(true);
      expect(isWithinBookingWindow(parseBaDateKey('2026-07-31'), NOW_BA)).toBe(true);
    });

    it('rejects days outside the 30-day window', () => {
      expect(isWithinBookingWindow(parseBaDateKey('2026-08-01'), NOW_BA)).toBe(false);
      expect(isWithinBookingWindow(parseBaDateKey('2026-07-01'), NOW_BA)).toBe(false);
    });
  });

  describe('findWeekdayDayNumberMismatch', () => {
    it('returns null when parseRelativeDay already resolved the requested day-of-month directly', () => {
      const parsed = parseRelativeDay('jueves 16', NOW_BA);
      expect(parsed && findWeekdayDayNumberMismatch('jueves 16', parsed)).toBeNull();
    });

    it('flags a mismatch when the requested day-of-month matches no in-window occurrence of that weekday', () => {
      const parsed = parseRelativeDay('jueves 15', NOW_BA); // falls back to nearest Thursday (today, the 2nd)
      const mismatch = parsed && findWeekdayDayNumberMismatch('jueves 15', parsed);
      expect(mismatch).toEqual({ requestedDayNumber: 15, weekdayLabel: 'jueves' });
    });

    it('returns null when there is no adjacent day number', () => {
      const parsed = parseRelativeDay('el jueves', NOW_BA);
      expect(parsed && findWeekdayDayNumberMismatch('el jueves', parsed)).toBeNull();
    });
  });

  describe('parseTimeOfDay', () => {
    it('parses 24h HH:MM', () => {
      expect(parseTimeOfDay('20:30')).toEqual({ hour: 20, minute: 30 });
    });

    it('parses am/pm', () => {
      expect(parseTimeOfDay('8pm')).toEqual({ hour: 20, minute: 0 });
      expect(parseTimeOfDay('8am')).toEqual({ hour: 8, minute: 0 });
    });

    it('parses "y media" / "y cuarto" / "menos cuarto"', () => {
      expect(parseTimeOfDay('9 y media')).toEqual({ hour: 9, minute: 30 });
      expect(parseTimeOfDay('3 y cuarto')).toEqual({ hour: 3, minute: 15 });
      expect(parseTimeOfDay('9 menos cuarto')).toEqual({ hour: 8, minute: 45 });
    });

    it('parses "HH hs"', () => {
      expect(parseTimeOfDay('21 hs')).toEqual({ hour: 21, minute: 0 });
    });

    // Regression: "HH:MMhs"/"HH:MMhoras" pegados (sin espacio antes del
    // sufijo) hacían fallar el \b final de la regex HH:MM (dígito→letra no
    // es un word-boundary), y el parseo caía al patrón abreviado "H hs" de
    // más abajo, que confundía los MINUTOS con la HORA (p. ej. "13:00hs" ->
    // {hour: 0, minute: 0} en vez de {hour: 13, minute: 0}).
    describe('"HH:MM" pegado a "hs"/"horas" sin espacio (regresión)', () => {
      it('parses "13:00hs"', () => {
        expect(parseTimeOfDay('13:00hs')).toEqual({ hour: 13, minute: 0 });
      });

      it('parses "13:00horas"', () => {
        expect(parseTimeOfDay('13:00horas')).toEqual({ hour: 13, minute: 0 });
      });

      it('parses "9:00hs" (hora de un solo dígito)', () => {
        expect(parseTimeOfDay('9:00hs')).toEqual({ hour: 9, minute: 0 });
      });

      it('parses "20:15hs" (minuto distinto de cero)', () => {
        expect(parseTimeOfDay('20:15hs')).toEqual({ hour: 20, minute: 15 });
      });

      it('parses "13:45hs" (antes fallaba "seguro" con null — minuto leído como hora fuera de rango)', () => {
        expect(parseTimeOfDay('13:45hs')).toEqual({ hour: 13, minute: 45 });
      });

      it('parses "20:30hs" (antes fallaba "seguro" con null — minuto leído como hora fuera de rango)', () => {
        expect(parseTimeOfDay('20:30hs')).toEqual({ hour: 20, minute: 30 });
      });

      it('sigue parseando "13:00 hs" con espacio antes del sufijo (control, ya funcionaba)', () => {
        expect(parseTimeOfDay('13:00 hs')).toEqual({ hour: 13, minute: 0 });
      });
    });

    it('parses "a las HH"', () => {
      expect(parseTimeOfDay('a las 21')).toEqual({ hour: 21, minute: 0 });
    });

    it('bumps an ambiguous hour into the evening when qualified', () => {
      expect(parseTimeOfDay('a las 9 de la noche')).toEqual({ hour: 21, minute: 0 });
    });

    it('parses a bare number answering "¿a qué hora?"', () => {
      expect(parseTimeOfDay('9')).toEqual({ hour: 9, minute: 0 });
    });

    it('returns null for an out-of-range time', () => {
      expect(parseTimeOfDay('25:00')).toBeNull();
    });

    it('returns null for unparseable text', () => {
      expect(parseTimeOfDay('no se todavia')).toBeNull();
    });
  });

  describe('combineToUtcISO', () => {
    it('combines a BA day and time into the equivalent UTC instant', () => {
      const iso = combineToUtcISO(parseBaDateKey('2026-07-02'), 20, 30);
      expect(iso).toBe('2026-07-02T23:30:00.000Z');
    });
  });

  describe('isInPast', () => {
    it('detects past and future instants', () => {
      expect(isInPast('2000-01-01T00:00:00.000Z')).toBe(true);
      expect(isInPast('2099-01-01T00:00:00.000Z')).toBe(false);
    });

    // Regresión del bug reportado: "no me deja hacer reservas para las 13hs
    // siendo las 12:13". parseTimeOfDay malparseaba "13:00hs" como
    // {hour: 0, minute: 0}; combineToUtcISO lo convertía en "hoy a las
    // 00:00"; isInPast entonces (correctamente, pero de forma engañosa)
    // marcaba eso como pasado.
    describe('escenario real: "13:00hs" parseado a las 12:13 BA', () => {
      let dateNowSpy: jest.SpyInstance<number, []>;

      afterEach(() => {
        dateNowSpy.mockRestore();
      });

      it('NO está en el pasado cuando "ahora" son las 12:13 BA del mismo día', () => {
        // Jueves 2026-07-02, 12:13 hora de pared BA.
        const nowBaWallClock = new Date('2026-07-02T12:13:00.000Z');
        dateNowSpy = jest
          .spyOn(Date, 'now')
          .mockReturnValue(nowBaWallClock.getTime() + BA_OFFSET_MS);

        const parsed = parseTimeOfDay('13:00hs');
        expect(parsed).toEqual({ hour: 13, minute: 0 });

        const todayBaDate = startOfBaDay(nowInBuenosAires());
        const scheduledAt = combineToUtcISO(todayBaDate, 13, 0);

        expect(isInPast(scheduledAt)).toBe(false);
      });
    });
  });

  describe('formatScheduledLabel / describeScheduledDateTime / describeScheduledAtUtc', () => {
    it('formats a full day+time label', () => {
      expect(formatScheduledLabel(parseBaDateKey('2026-07-03'), 21, 5, false)).toBe(
        'viernes 03/07 a las 21:05'
      );
    });

    it('describes a stored date key + time relative to now', () => {
      expect(describeScheduledDateTime('2026-07-02', 9, 0, NOW_BA)).toBe('hoy 02/07 a las 09:00');
    });

    it('describes a stored UTC instant relative to now', () => {
      const utcISO = combineToUtcISO(parseBaDateKey('2026-07-02'), 20, 30);
      expect(describeScheduledAtUtc(utcISO, NOW_BA)).toBe('hoy 02/07 a las 20:30');
    });
  });

  describe('business hours', () => {
    const weeklyHours: WeeklyHours = {
      thu: {
        closed: false,
        shifts: [
          { open: '08:00', close: '14:00' },
          { open: '17:00', close: '02:00' }, // cross-midnight
        ],
      },
      fri: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] },
      sun: { closed: true, shifts: [] },
    };

    describe('formatDayHours', () => {
      it('joins multiple shifts', () => {
        expect(formatDayHours('thu', weeklyHours)).toBe('08:00–14:00 y 17:00–02:00');
      });

      it('returns "cerrado" for closed or missing days', () => {
        expect(formatDayHours('sun', weeklyHours)).toBe('cerrado');
        expect(formatDayHours('mon', weeklyHours)).toBe('cerrado');
      });
    });

    describe('isDayOpen', () => {
      it('reports open days as open', () => {
        expect(isDayOpen(parseBaDateKey('2026-07-02'), weeklyHours)).toEqual({ open: true });
      });

      it('reports closed days with a reason', () => {
        const result = isDayOpen(parseBaDateKey('2026-07-05'), weeklyHours); // Sunday
        expect(result.open).toBe(false);
        expect(result.reason).toContain('domingo');
      });
    });

    describe('checkBusinessHours', () => {
      it('allows a time inside a shift', () => {
        expect(checkBusinessHours(parseBaDateKey('2026-07-02'), 9, 0, weeklyHours)).toEqual({
          allowed: true,
        });
      });

      it('allows a time inside a cross-midnight shift', () => {
        expect(checkBusinessHours(parseBaDateKey('2026-07-02'), 20, 0, weeklyHours)).toEqual({
          allowed: true,
        });
      });

      it('rejects a time in the gap between shifts', () => {
        const result = checkBusinessHours(parseBaDateKey('2026-07-02'), 15, 0, weeklyHours);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('08:00–14:00 y 17:00–02:00');
      });

      it('allows an early-morning time carried over from the previous day\'s cross-midnight shift', () => {
        // Friday 01:00 falls within Thursday's 17:00–02:00 shift.
        expect(checkBusinessHours(parseBaDateKey('2026-07-03'), 1, 0, weeklyHours)).toEqual({
          allowed: true,
        });
      });

      it('rejects any time on a fully closed day', () => {
        const result = checkBusinessHours(parseBaDateKey('2026-07-05'), 12, 0, weeklyHours); // Sunday
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('domingo');
      });
    });

    describe('findNextOpenSlot', () => {
      it('finds the next shift opening later the same day', () => {
        const slot = findNextOpenSlot(NOW_BA, weeklyHours, 15); // NOW_BA = Thu 12:00
        expect(slot).toEqual(
          expect.objectContaining({ hour: 17, minute: 15, isToday: true, label: 'hoy 02/07 a las 17:15' })
        );
      });

      it('rolls over to the next day once today has no more shifts', () => {
        const lateThu = new Date('2026-07-02T20:00:00.000Z'); // Thu 20:00 BA
        const slot = findNextOpenSlot(lateThu, weeklyHours, 15);
        expect(slot).toEqual(
          expect.objectContaining({ hour: 8, minute: 15, isToday: false, label: 'viernes 03/07 a las 08:15' })
        );
      });

      it('returns null when no day is open within the lookahead window', () => {
        const allClosed: WeeklyHours = { sun: { closed: true, shifts: [] } };
        expect(findNextOpenSlot(NOW_BA, allClosed, 15)).toBeNull();
      });
    });

    describe('findNextSlotOnDay', () => {
      it('finds the next shift opening later that same day', () => {
        expect(findNextSlotOnDay(parseBaDateKey('2026-07-02'), 500, weeklyHours, 15)).toEqual({
          hour: 17,
          minute: 15,
        });
      });

      it('returns null when no more shifts open that day', () => {
        expect(findNextSlotOnDay(parseBaDateKey('2026-07-02'), 1200, weeklyHours, 15)).toBeNull();
      });
    });

    describe('findSoonestBookableSlot', () => {
      it('skips today and proposes the next open day\'s first slot when skipToday is set', () => {
        // NOW_BA = Thu 02/07 12:00. Thursday is open, but skipToday must jump to Friday.
        const slot = findSoonestBookableSlot(NOW_BA, weeklyHours, 15, 0, { skipToday: true });
        expect(slot).toEqual(
          expect.objectContaining({ hour: 8, minute: 15, isToday: false, label: 'viernes 03/07 a las 08:15' })
        );
      });

      it('proposes a slot on today when skipToday is not set', () => {
        const slot = findSoonestBookableSlot(NOW_BA, weeklyHours, 15, 0);
        expect(slot).toEqual(
          expect.objectContaining({ hour: 17, minute: 15, isToday: true, label: 'hoy 02/07 a las 17:15' })
        );
      });

      it('starts scanning from preferDate before rolling forward', () => {
        // Prefer Friday: even though Thursday (today) is open, the first slot returned is Friday's.
        const slot = findSoonestBookableSlot(NOW_BA, weeklyHours, 15, 0, {
          preferDate: parseBaDateKey('2026-07-03'),
        });
        expect(slot).toEqual(
          expect.objectContaining({ isToday: false, label: 'viernes 03/07 a las 08:15' })
        );
      });

      it('skips blocked dates like closed days', () => {
        // Fri 03/07 and Sat 04/07 both open; blocking Friday rolls to Saturday.
        const hoursFriSat: WeeklyHours = {
          fri: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] },
          sat: { closed: false, shifts: [{ open: '09:00', close: '23:00' }] },
        };
        const slot = findSoonestBookableSlot(NOW_BA, hoursFriSat, 15, 0, {
          skipToday: true,
          isDateBlocked: (key) => key === '2026-07-03',
        });
        expect(slot).toEqual(
          expect.objectContaining({ isToday: false, label: 'sábado 04/07 a las 09:15' })
        );
      });

      it('returns null when no day is open within the window', () => {
        const allClosed: WeeklyHours = { sun: { closed: true, shifts: [] } };
        expect(findSoonestBookableSlot(NOW_BA, allClosed, 15, 0, { skipToday: true })).toBeNull();
      });
    });

    describe('formatBookableDays', () => {
      it('lists the open weekdays present in the next-7-days window', () => {
        // NOW_BA = Thu 02/07; window covers Thu (thu) and Fri (fri) as open days.
        expect(formatBookableDays(weeklyHours, NOW_BA)).toBe('jueves, viernes');
      });

      it('excludes a weekday whose window occurrence is a blocked date', () => {
        expect(formatBookableDays(weeklyHours, NOW_BA, (key) => key === '2026-07-03')).toBe('jueves');
      });
    });
  });
});
