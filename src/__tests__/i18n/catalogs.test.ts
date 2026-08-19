import { ALL_CATALOGS, getTemplates, type MessageCatalog } from '../../i18n/catalogs/index.js';
import { SUPPORTED_LANGUAGES, SupportedLanguage } from '../../i18n/languages.js';
import { runWithLanguage, currentLanguage } from '../../i18n/context.js';
import * as templates from '../../utils/message-templates.js';

/**
 * Argumentos de prueba por template. Los valores son centinelas distintivos
 * (`__NAME__`, 999, …) para poder verificar que ninguna traducción se comió un
 * placeholder — el bug más silencioso al traducir template strings.
 */
const RESERVATION_ROW = {
  index: 1,
  partySize: 999,
  whenLabel: '__WHEN__',
  displayCode: '__CODE__',
  statusLabel: '__STATUS__',
};

const ARGS: Record<keyof MessageCatalog, unknown[]> = {
  languageWelcomeMenu: ['__BIZ__'],
  languageChanged: [],
  languageChangeHint: [],
  instantTurnLabel: [],
  welcomeMessage: ['__BIZ__'],
  askPartySize: ['__NAME__'],
  welcomeBackAskPartySize: ['__NAME__'],
  askScheduleChoice: [],
  askDayClosedToday: ['__DAYS__'],
  askDayClosedTodayWithSchedule: [['__LINE1__', '__LINE2__']],
  askDay: ['__DAYS__'],
  otherDaysSchedule: [['__LINE1__']],
  askTime: ['__DAY__', '__HOURS__'],
  askTodayTimeOpen: ['__CLOSE__'],
  reservationSummary: ['__NAME__', 999, '__WHEN__', '__FULLNAME__'],
  summaryEditMenu: [],
  reservationConfirmed: ['__NAME__', 999, '__WHEN__', '__CODE__', '__FULLNAME__'],
  reservationReceived: ['__NAME__', 999, '__WHEN__', '__CODE__', '__FULLNAME__'],
  editMenu: [999, '__WHEN__', '__CODE__', '__STATUS__', '__NAME__'],
  editMenuInvalidChoice: [],
  partySizeUpdated: [999],
  scheduleUpdated: ['__WHEN__'],
  cancelMenu: [999, '__WHEN__', '__CODE__'],
  cancelDirectConfirmPrompt: [999, '__WHEN__', '__CODE__'],
  activeReservationsMenu: [[RESERVATION_ROW], 'view'],
  activeReservationSelectionInvalid: [],
  cancelMenuInvalidChoice: [],
  rescheduleIntro: [],
  cancelConfirmPrompt: [],
  cancelConfirmInvalidChoice: [],
  reservationCancelled: [],
  reservationKept: [],
  cancelFailed: [],
  // reasonMessage null a propósito: es la rama que usa dayLabel.
  reservationOverlapConflict: ['__WHEN__', '__WHEN2__', '__CODE__', '__STATUS__'],
  noActiveReservation: [],
  timeNotAvailable: ['__REASON__', '__TIME__'],
  noMoreSlotsToday: ['__REASON__'],
  suggestNextSlot: ['__SLOT__', '__REASON__'],
  dateBlocked: ['__DAY__', null],
  futureReservationsBlockedToday: [],
  invalidDate: [],
  invalidTime: [],
  invalidPartySize: [],
  invalidName: [],
  nameChanged: ['__NAME__'],
  askPartySizeShort: [],
  invalidNameRetry: [],
  askCorrectName: [],
  invalidLastNameRetry: [],
  noStoredCustomerData: [],
  customerNameUpdated: ['__FULLNAME__'],
  closedNoAvailability: [],
  closedSuggestNextSlot: ['__SLOT__'],
  outOfWindowPrefix: [],
  outOfWindowAskDay: [],
  scheduleChoiceInvalid: [],
  didntUnderstandTimeSuggest: ['__TIME__'],
  hoursRejectedAskOther: ['__REASON__'],
  hoursRejectedSuggestSlot: ['__REASON__', '__TIME__'],
  hoursRejectedNoMoreSlots: ['__REASON__'],
  confirmSlotPrompt: ['__SLOT__', '__NOTE__'],
  dayClosedAskOtherDay: ['__REASON__'],
  carriedTimeHoursNote: ['__HOURS__'],
  didNotUnderstandDayAndTime: [],
  askTimeAgain: [],
  confirmSlotYesNoReminder: ['__SLOT__'],
  reservationRescheduled: ['__WHEN__'],
  reservationUpdateFailed: [],
  askNewPartySize: [],
  weekdayAmbiguityPrompt: ['__WEEKDAY__', '__NEXT__'],
  weekdayAmbiguityInvalid: ['__WEEKDAY__'],
  weekdayDayMismatchPrompt: ['__WEEKDAY__', 17, '__NEAREST__'],
  weekdayDayMismatchInvalid: ['__NEAREST__'],
  timeAlreadyPassedSuggestTomorrow: ['__TIME__', '__TOMORROW__'],
  timeAlreadyPassed: [],
  noActiveReservationsInquiry: [],
  reservationConfirmedNotice: ['__NAME__', 999, '__CODE__'],
  reservationRegisteredNotice: ['__NAME__', 999, '__CODE__'],
  tableReadyNotice: [],
  welcomeAtRestaurant: [],
  postVisitMessage: [],
  askName: [],
  askNameAgain: [],
  askLastName: ['__NAME__'],
  askLastNameAgain: [],
  processCancelled: [],
  tooManyInvalidAttempts: [],
  confirmSummaryInvalidChoice: [],
  reservationIntro: ['__BIZ__'],
  reservationOffTopic: ['__BIZ__'],
  reservationOutOfWindow: ['__BIZ__'],
  inactiveFallback: [],
  genericError: [],
  firstContactNoReservations: ['__BIZ__'],
};

const CATALOG_KEYS = Object.keys(ALL_CATALOGS.es) as (keyof MessageCatalog)[];
const NON_DEFAULT_LANGUAGES = SUPPORTED_LANGUAGES.filter(
  (language): language is Exclude<SupportedLanguage, 'es'> => language !== 'es'
);

function render(language: SupportedLanguage, key: keyof MessageCatalog): string {
  const fn = getTemplates(language)[key] as (...args: unknown[]) => string;
  return fn(...ARGS[key]);
}

describe('catálogos de mensajes', () => {
  it('la tabla de argumentos cubre todas las claves del catálogo', () => {
    // Guarda contra agregar un template y olvidarse de testearlo.
    expect(Object.keys(ARGS).sort()).toEqual([...CATALOG_KEYS].sort());
  });

  describe.each(SUPPORTED_LANGUAGES)('idioma %s', (language) => {
    it.each(CATALOG_KEYS)('%s devuelve texto no vacío', (key) => {
      const output = render(language, key);
      expect(typeof output).toBe('string');
      expect(output.trim().length).toBeGreaterThan(0);
    });
  });

  describe.each(NON_DEFAULT_LANGUAGES)('idioma %s vs español', (language) => {
    it.each(CATALOG_KEYS)('%s está realmente traducido', (key) => {
      // Si es idéntico al español, la traducción quedó sin hacer.
      expect(render(language, key)).not.toBe(render('es', key));
    });

    it.each(CATALOG_KEYS)('%s conserva todos los placeholders', (key) => {
      const spanish = render('es', key);
      const translated = render(language, key);

      const sentinels = [...ARGS[key]]
        .flat()
        .flatMap((arg) =>
          arg && typeof arg === 'object' ? Object.values(arg as Record<string, unknown>) : [arg]
        )
        .filter((arg): arg is string | number => typeof arg === 'string' || typeof arg === 'number')
        .map(String);

      for (const sentinel of sentinels) {
        if (spanish.includes(sentinel)) {
          expect(translated).toContain(sentinel);
        }
      }
    });
  });

  it('las ramas de lista vacía también devuelven texto en los tres idiomas', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = getTemplates(language);
      expect(catalog.askDayClosedTodayWithSchedule([]).trim().length).toBeGreaterThan(0);
      expect(catalog.otherDaysSchedule([]).trim().length).toBeGreaterThan(0);
      expect(catalog.askDay(null).trim().length).toBeGreaterThan(0);
      expect(catalog.askDayClosedToday(null).trim().length).toBeGreaterThan(0);
      expect(catalog.dateBlocked('__DAY__', '__REASON__')).toContain('__REASON__');
    }
  });

  it('getTemplates cae a español ante un idioma desconocido', () => {
    expect(getTemplates('xx' as SupportedLanguage)).toBe(ALL_CATALOGS.es);
  });
});

describe('contexto de idioma', () => {
  it('fuera de runWithLanguage el idioma activo es español', () => {
    expect(currentLanguage()).toBe('es');
    expect(templates.welcomeMessage('X')).toBe(ALL_CATALOGS.es.welcomeMessage('X'));
  });

  it('los dispatchers de message-templates siguen el idioma activo', () => {
    runWithLanguage('en', () => {
      expect(currentLanguage()).toBe('en');
      expect(templates.welcomeMessage('X')).toBe(ALL_CATALOGS.en.welcomeMessage('X'));
    });

    runWithLanguage('pt', () => {
      expect(templates.reservationCancelled()).toBe(ALL_CATALOGS.pt.reservationCancelled());
    });
  });

  it('el contexto se restaura al salir', () => {
    runWithLanguage('en', () => undefined);
    expect(currentLanguage()).toBe('es');
  });

  it('el contexto sobrevive un await (aislamiento por cadena async)', async () => {
    // Es la propiedad que hace viable no pasar `lang` por parámetro: el handler
    // hace decenas de awaits entre que resuelve el idioma y emite el mensaje.
    await runWithLanguage('pt', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentLanguage()).toBe('pt');
      expect(templates.askName()).toBe(ALL_CATALOGS.pt.askName());
    });
  });

  it('conversaciones concurrentes no se pisan el idioma', async () => {
    // WhatsAppHandler es un singleton que atiende varias conversaciones a la
    // vez: este es el escenario que rompería si el idioma viviera en `this`.
    const results = await Promise.all([
      runWithLanguage('en', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return templates.askName();
      }),
      runWithLanguage('pt', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return templates.askName();
      }),
      runWithLanguage('es', async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        return templates.askName();
      }),
    ]);

    expect(results).toEqual([
      ALL_CATALOGS.en.askName(),
      ALL_CATALOGS.pt.askName(),
      ALL_CATALOGS.es.askName(),
    ]);
  });
});
