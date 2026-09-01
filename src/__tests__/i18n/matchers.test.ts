/**
 * Los matchers de intención aceptan la UNIÓN de los tres idiomas, no un set por
 * idioma activo: los clientes mezclan idiomas todo el tiempo ("ok", "yes", "sí",
 * "sim") y un brasileño puede escribir CANCEL. Estos tests fijan ese contrato.
 */

import { isMultilingualGreeting } from '../../i18n/keywords.js';
import {
  evaluateReservationScope,
  normalizeReservationScopeText,
} from '../../utils/reservation-scope.js';

jest.mock('../../utils/logger');

describe('saludos multilingües', () => {
  const greetings = [
    // Español
    'hola', 'holaa', 'buenas', 'buenos dias', 'que tal',
    // Inglés
    'hi', 'hello', 'hey', 'good morning', 'good evening',
    // Portugués
    'oi', 'ola', 'opa', 'bom dia', 'boa noite', 'boa tarde',
  ];

  it.each(greetings)('%p es un saludo', (text) => {
    expect(isMultilingualGreeting(normalizeReservationScopeText(text))).toBe(true);
  });

  const notGreetings = ['quiero una mesa', 'i want a table', 'quero uma mesa', '4', ''];
  it.each(notGreetings)('%p NO es un saludo', (text) => {
    expect(isMultilingualGreeting(normalizeReservationScopeText(text))).toBe(false);
  });

  it('el guard de alcance no rebota un saludo en inglés o portugués', () => {
    for (const text of ['hi', 'hello', 'oi', 'bom dia']) {
      expect(evaluateReservationScope(text, {}).decision).toBe('allow');
    }
  });
});

describe('pedidos de reserva en los tres idiomas pasan el guard de alcance', () => {
  const requests = [
    'quiero una mesa para 4',
    'I want to book a table for 4 people',
    'can I book a table for tomorrow',
    'quero uma mesa para 4 pessoas',
    'gostaria de reservar uma mesa',
  ];

  it.each(requests)('%p → allow', (text) => {
    expect(evaluateReservationScope(text, {}).decision).toBe('allow');
  });
});
