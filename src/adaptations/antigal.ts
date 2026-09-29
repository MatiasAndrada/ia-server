import { BOOK_KEYWORDS, CANCEL_KEYWORDS, buildKeywordPattern } from '../i18n/keywords.js';
import { capitalize, type SharedNumberAdaptation, type WelcomeEvent } from './shared-number.js';

/**
 * Antigal Parrilla Restaurante: el mismo número lo comparten el bot de reservas
 * y Valentina.
 *
 * Como en De La Fonte el otro camino es una persona con nombre, pero acá el
 * traspaso NO es permanente: rige el comportamiento por defecto del motor
 * (`shared-number.ts`) — silencio de veinticuatro horas, con salida antes de
 * tiempo si el cliente escribe una palabra de reserva.
 */
export const antigalAdaptation: SharedNumberAdaptation = {
  // Parte de la key de Redis desde el primer despliegue: cambiarlo soltaría
  // todos los traspasos activos.
  id: 'antigal',
  businessIdEnvVar: 'ANTIGAL_BUSINESS_ID',

  /**
   * El menú pide "escribí Valentina". El nombre de una persona no es algo que
   * se escriba al pedir una mesa, así que —igual que "Simona" en De La Fonte—
   * se busca como palabra completa en cualquier parte de la frase: "quiero
   * hablar con Valentina" lleva al mismo lado.
   */
  handoffPattern: buildKeywordPattern(['valentina']),

  /**
   * Sólo palabras del mundo de la reserva. Una reactivación de más se mete en
   * medio de una conversación real; una de menos se arregla con el "escribí
   * *Reservar*" que dejó el mensaje de traspaso.
   */
  reactivationPattern: buildKeywordPattern([
    ...BOOK_KEYWORDS,
    ...CANCEL_KEYWORDS,
    'reservas',
    'mesa',
    'mesas',
    'turno',
  ]),

  welcome(customerName: string | null, events: WelcomeEvent[] = []): string {
    const lines = [
      customerName ? `Hola, ${customerName}! 👋` : 'Hola! 👋',
      '',
      'Bienvenido/a a Antigal Parrilla Restaurante',
      '',
      '📱 Este número es compartido, así que decime qué necesitás:',
      '',
      '🗣️ Hablar con Valentina → escribí Valentina',
      '📅 Reservar en el Restaurante → escribí Reservar',
    ];

    // Sin eventos no va ni la sección ni la invitación a nombrar uno: ofrecer
    // algo que no existe deja al cliente escribiendo contra la nada.
    if (events.length > 0) {
      lines.push('', '✨ Próximos eventos:', '');
      lines.push(...events.map((event) => `* ${event.title} · ${capitalize(event.whenLabel)}`));
      // Con un solo evento se nombra, que es más fácil de contestar que una
      // instrucción genérica; con varios no se puede elegir por el cliente.
      lines.push(
        '',
        events.length === 1
          ? `🎟️ Para reservar en el evento, escribí ${events[0]!.title}.`
          : '🎟️ Para reservar en un evento, escribí el nombre del evento.'
      );
    }

    return lines.join('\n');
  },

  /**
   * Lo último que dice el bot antes de callarse.
   *
   * Describe el mecanismo real: el bot deja de contestar y el chat queda para
   * Valentina. No promete que alguien "le va a transmitir" la consulta — ver la
   * nota equivalente en sky.ts.
   */
  handoffConfirmation(): string {
    return (
      '🗣️ ¡Listo! Desde acá seguís por este mismo chat con *Valentina* 💫\n\n' +
      'Dejo de responder automáticamente así no te interrumpo la conversación.\n\n' +
      '_Cuando quieras reservar en el Restaurante, escribí *Reservar* y te ayudo al toque._'
    );
  },
};
