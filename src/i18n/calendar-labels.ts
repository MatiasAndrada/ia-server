import { currentLanguage } from './context';
import { SupportedLanguage } from './languages';

/**
 * Etiquetas de calendario en el idioma activo.
 *
 * Contraparte de date-normalization.ts: aquella traduce lo que ENTRA (para que
 * el parser español lo entienda), esta traduce lo que SALE (para que el cliente
 * lo lea en su idioma). El parser sigue trabajando internamente con índices de
 * día de la semana, que son neutros.
 */

/** Índice 0 = domingo, igual que Date.getUTCDay(). */
const WEEKDAY_NAMES: Record<SupportedLanguage, readonly string[]> = {
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  pt: [
    'domingo',
    'segunda-feira',
    'terça-feira',
    'quarta-feira',
    'quinta-feira',
    'sexta-feira',
    'sábado',
  ],
};

const TODAY_LABEL: Record<SupportedLanguage, string> = {
  es: 'hoy',
  en: 'today',
  pt: 'hoje',
};

/** Conector día/hora de un `whenLabel` ("viernes 22/08 {at} 21:00"). */
const AT_TIME_CONNECTOR: Record<SupportedLanguage, string> = {
  es: 'a las',
  en: 'at',
  pt: 'às',
};

/** "El local está cerrado los {día}" — la frase varía de estructura por idioma. */
const CLOSED_ON_WEEKDAY: Record<SupportedLanguage, (weekday: string) => string> = {
  es: (weekday) => `El local está cerrado los ${weekday}.`,
  en: (weekday) => `We're closed on ${weekday}s.`,
  pt: (weekday) => `Estamos fechados nas ${weekday}s.`,
};

/** "El {día} se puede reservar de {horario}..." */
const BOOKABLE_HOURS_ON_WEEKDAY: Record<
  SupportedLanguage,
  (weekday: string, hours: string) => string
> = {
  es: (weekday, hours) =>
    `El ${weekday} se puede reservar de ${hours}. Por favor elegí un horario dentro de ese rango.`,
  en: (weekday, hours) =>
    `On ${weekday} bookings are available from ${hours}. Please choose a time within that range.`,
  pt: (weekday, hours) =>
    `Na ${weekday} é possível reservar das ${hours}. Por favor escolha um horário dentro desse intervalo.`,
};

export function weekdayName(dayOfWeek: number, language: SupportedLanguage = currentLanguage()): string {
  return WEEKDAY_NAMES[language][dayOfWeek] ?? WEEKDAY_NAMES.es[dayOfWeek];
}

export function todayLabel(language: SupportedLanguage = currentLanguage()): string {
  return TODAY_LABEL[language] ?? TODAY_LABEL.es;
}

/** Conector usado entre el día y la hora de un `whenLabel` ("viernes 22/08 {conector} 21:00"). */
export function atTimeConnector(language: SupportedLanguage = currentLanguage()): string {
  return AT_TIME_CONNECTOR[language] ?? AT_TIME_CONNECTOR.es;
}

export function closedOnWeekday(dayOfWeek: number): string {
  const language = currentLanguage();
  return CLOSED_ON_WEEKDAY[language](weekdayName(dayOfWeek, language));
}

export function bookableHoursOnWeekday(dayOfWeek: number, hours: string): string {
  const language = currentLanguage();
  return BOOKABLE_HOURS_ON_WEEKDAY[language](weekdayName(dayOfWeek, language), hours);
}
