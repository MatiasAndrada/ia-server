/**
 * Los matchers de intención aceptan la UNIÓN de los tres idiomas, no un set por
 * idioma activo: los clientes mezclan idiomas todo el tiempo ("ok", "yes", "sí",
 * "sim") y un brasileño puede escribir CANCEL. Estos tests fijan ese contrato.
 */

import { WhatsAppHandler } from '../../services/whatsapp-handler.service';
import { isMultilingualGreeting } from '../../i18n/keywords';
import {
  evaluateReservationScope,
  normalizeReservationScopeText,
} from '../../utils/reservation-scope';

jest.mock('../../utils/logger');

const handler = new WhatsAppHandler({
  sendMessage: jest.fn(),
  getSelfJid: jest.fn().mockReturnValue(''),
} as any);

const call = (method: string, text: string): boolean =>
  (handler as any)[method](text) as boolean;

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

describe('isCancellationIntent', () => {
  const positives = [
    'quiero cancelar',
    'cancelar',
    'anular mi reserva',
    'cancel',
    'I want to cancel my booking',
    'please delete my reservation',
    'quero cancelar',
    'desmarcar a reserva',
    'quero desistir',
  ];

  it.each(positives)('%p → true', (text) => {
    expect(call('isCancellationIntent', text)).toBe(true);
  });

  const negatives = ['quiero reservar', 'a table for 4', 'uma mesa para 4'];
  it.each(negatives)('%p → false', (text) => {
    expect(call('isCancellationIntent', text)).toBe(false);
  });
});

describe('isExitKeyword', () => {
  const positives = [
    'salir', 'dejalo', 'olvidalo',
    'exit', 'quit', 'nevermind', 'forget it', 'no thanks',
    'sair', 'esquece', 'voltar',
  ];

  it.each(positives)('%p → true', (text) => {
    expect(call('isExitKeyword', text)).toBe(true);
  });
});

describe('isGratitudeMessage', () => {
  const positives = [
    'gracias', 'muchas gracias', 'mil gracias',
    'thanks', 'thank you', 'thank you so much', 'thx',
    'obrigado', 'obrigada', 'muito obrigado', 'valeu',
  ];

  it.each(positives)('%p → true', (text) => {
    expect(call('isGratitudeMessage', text)).toBe(true);
  });
});

describe('isShortAcknowledgementMessage', () => {
  const positives = [
    'ok', 'dale', 'perfecto', 'listo',
    'sure', 'alright', 'great', 'got it',
    'beleza', 'certo', 'otimo',
  ];

  it.each(positives)('%p → true', (text) => {
    expect(call('isShortAcknowledgementMessage', text)).toBe(true);
  });
});

describe('isModificationIntent', () => {
  const positives = [
    'quiero modificar mi reserva',
    'cambiar mi reserva',
    'I want to change my booking',
    'can you modify my reservation',
    'reschedule',
    'quero alterar minha reserva',
    'remarcar',
  ];

  it.each(positives)('%p → true', (text) => {
    expect(call('isModificationIntent', text)).toBe(true);
  });
});

describe('isExplicitNewReservationIntent', () => {
  const positives = [
    'reservar',
    'quiero hacer otra reserva',
    'nueva reserva',
    'book',
    'I want to book',
    'make a reservation',
    'another booking',
    'quero reservar',
    'nova reserva',
  ];

  it.each(positives)('%p → true', (text) => {
    expect(call('isExplicitNewReservationIntent', text)).toBe(true);
  });
});
