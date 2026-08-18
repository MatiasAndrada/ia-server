import { normalizeTemporalTokens } from '../../i18n/date-normalization.js';
import { normalizeReservationScopeText, hasDateOrTimeSignal } from '../../utils/reservation-scope.js';
import { parseRelativeDay, parseTimeOfDay } from '../../utils/reservation-datetime.js';

/** Martes 21/07/2026 12:00 BA — fijo, para que los días relativos sean deterministas. */
const NOW_BA = new Date('2026-07-21T12:00:00.000Z');

const dayKey = (text: string): string | null => {
  const parsed = parseRelativeDay(text, NOW_BA);
  if (!parsed) return null;
  const d = parsed.baDate;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
};

describe('normalizeTemporalTokens', () => {
  describe('días relativos', () => {
    const cases: [string, string][] = [
      ['tomorrow', 'manana'],
      ['amanha', 'manana'],
      ['day after tomorrow', 'pasado manana'],
      ['depois de amanha', 'pasado manana'],
      ['today', 'hoy'],
      ['hoje', 'hoy'],
    ];

    it.each(cases)('%p → %p', (input, expected) => {
      expect(normalizeTemporalTokens(input)).toBe(expected);
    });
  });

  describe('días de la semana', () => {
    const cases: [string, string][] = [
      ['monday', 'lunes'],
      ['thursday', 'jueves'],
      ['friday', 'viernes'],
      ['sunday', 'domingo'],
      ['segunda', 'lunes'],
      ['segunda-feira', 'lunes'],
      ['quinta-feira', 'jueves'],
      ['sexta feira', 'viernes'],
      ['terca', 'martes'],
    ];

    it.each(cases)('%p → %p', (input, expected) => {
      expect(normalizeTemporalTokens(input)).toBe(expected);
    });

    it('la forma larga gana sobre la corta ("segunda-feira" no deja "-feira" colgando)', () => {
      expect(normalizeTemporalTokens('segunda-feira')).toBe('lunes');
      expect(normalizeTemporalTokens('quinta-feira as 21')).toBe('jueves a las 21');
    });
  });

  describe('IDEMPOTENCIA sobre español — la garantía de no-regresión', () => {
    // El parser de fechas existente tiene 837 líneas y 404 de tests. Este
    // pre-pass NO debe alterar nada de lo que ya funcionaba en español.
    const spanishInputs = [
      'manana',
      'pasado manana',
      'hoy',
      'lunes',
      'martes',
      'miercoles',
      'jueves',
      'viernes',
      'sabado',
      'domingo',
      'a las 21',
      '9 y media',
      '21 hs',
      'el viernes a las 21 30',
      'hoy de la noche',
      'somos 4 personas',
      'quiero reservar para el jueves',
    ];

    it.each(spanishInputs)('%p queda intacto', (input) => {
      expect(normalizeTemporalTokens(input)).toBe(input);
    });

    it('aplicar la normalización dos veces da el mismo resultado', () => {
      for (const input of ['tomorrow at 9', 'sexta-feira as 21', 'el viernes a las 21']) {
        const once = normalizeTemporalTokens(normalizeReservationScopeText(input));
        expect(normalizeTemporalTokens(once)).toBe(once);
      }
    });
  });

  it('no rompe "at" cuando no precede a un número', () => {
    // "at the restaurant" no debe convertirse en "a las the restaurant".
    expect(normalizeTemporalTokens('a table at the restaurant')).not.toContain('a las the');
  });
});

describe('los parsers existentes entienden EN/PT sin modificarse', () => {
  describe('parseRelativeDay', () => {
    it('"tomorrow" resuelve al mismo día que "mañana"', () => {
      expect(dayKey('tomorrow')).toBe(dayKey('mañana'));
      expect(dayKey('tomorrow')).toBe('2026-07-22');
    });

    it('"amanhã" resuelve al mismo día que "mañana"', () => {
      expect(dayKey('amanhã')).toBe(dayKey('mañana'));
    });

    it('"day after tomorrow" resuelve a pasado mañana', () => {
      expect(dayKey('day after tomorrow')).toBe('2026-07-23');
    });

    it('los días de semana en inglés resuelven igual que en español', () => {
      expect(dayKey('friday')).toBe(dayKey('el viernes'));
      expect(dayKey('thursday')).toBe(dayKey('el jueves'));
    });

    it('los días de semana en portugués resuelven igual que en español', () => {
      expect(dayKey('sexta-feira')).toBe(dayKey('el viernes'));
      expect(dayKey('quinta')).toBe(dayKey('el jueves'));
    });

    it('marca matchedWeekdayName igual que la versión española', () => {
      expect(parseRelativeDay('friday', NOW_BA)?.matchedWeekdayName).toBe(true);
      expect(parseRelativeDay('tomorrow', NOW_BA)?.matchedWeekdayName).toBe(false);
    });
  });

  describe('parseTimeOfDay', () => {
    const cases: [string, { hour: number; minute: number }][] = [
      ['at 9 pm', { hour: 21, minute: 0 }],
      ['at 21', { hour: 21, minute: 0 }],
      ['half past 9 in the evening', { hour: 21, minute: 30 }],
      ['as 21', { hour: 21, minute: 0 }],
      ['as 9 da noite', { hour: 21, minute: 0 }],
      ['9 e meia da noite', { hour: 21, minute: 30 }],
    ];

    it.each(cases)('%p → %o', (input, expected) => {
      expect(parseTimeOfDay(input)).toEqual(expected);
    });

    it('sigue parseando español exactamente igual', () => {
      expect(parseTimeOfDay('a las 21')).toEqual({ hour: 21, minute: 0 });
      expect(parseTimeOfDay('9 y media de la noche')).toEqual({ hour: 21, minute: 30 });
      expect(parseTimeOfDay('21:30')).toEqual({ hour: 21, minute: 30 });
    });
  });

  describe('hasDateOrTimeSignal', () => {
    const multilingual = [
      'tomorrow',
      'friday',
      'amanhã',
      'sexta-feira',
      'tonight',
      'hoje à noite',
    ];

    it.each(multilingual)('detecta señal temporal en %p', (text) => {
      expect(hasDateOrTimeSignal(text, normalizeReservationScopeText(text))).toBe(true);
    });
  });
});
