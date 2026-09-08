import { BOOK_KEYWORDS, CANCEL_KEYWORDS, buildKeywordPattern } from '../i18n/keywords.js';
import { capitalize, type SharedNumberAdaptation, type WelcomeEvent } from './shared-number.js';

/**
 * De La Fonte: el mismo número lo comparten el bot de reservas y Simona, la
 * dueña del lugar.
 *
 * Acá vive sólo lo que es propio de este local — a quién se pide, con qué
 * palabras y qué se le dice. El mecanismo (el silencio, su TTL, la vuelta) es
 * el de `shared-number.ts`.
 */
export const deLaFonteAdaptation: SharedNumberAdaptation = {
  // Parte de la key de Redis desde el primer despliegue: cambiarlo soltaría
  // todos los traspasos activos.
  id: 'delafonte',
  businessIdEnvVar: 'DE_LA_FONTE_BUSINESS_ID',

  /**
   * El menú anuncia "escribí Simona", pero nadie escribe sólo lo que se le
   * pide: "quiero hablar con la dueña" tiene que llevar al mismo lado. Se
   * matchean como palabra completa en cualquier parte de la frase, así que
   * "encargada" no se dispara con "encargar".
   */
  handoffPattern: buildKeywordPattern(['simona', 'duena', 'dueno', 'encargada', 'propietaria']),

  /**
   * Palabras que traen al bot de vuelta.
   *
   * Deliberadamente cortas y todas del mundo de la reserva: una reactivación de
   * más es peor que una de menos. Si el bot se mete en medio de la charla con
   * Simona porque el cliente escribió "evento", arruina la conversación que
   * justamente vinimos a proteger; en cambio, si no reactiva cuando debía, el
   * cliente escribe "reservar" — que es lo que el propio mensaje de traspaso le
   * dejó dicho — y listo.
   */
  reactivationPattern: buildKeywordPattern([
    ...BOOK_KEYWORDS,
    ...CANCEL_KEYWORDS,
    'reservas',
    'mesa',
    'mesas',
    'turno',
  ]),

  /**
   * Saludo de apertura del número compartido.
   *
   * Reemplaza al menú genérico (`templates.welcomeMenu`) sólo para este
   * comercio. La diferencia de fondo no es el texto: el menú genérico ofrece
   * dos opciones que son la misma cosa (reservar / modificar reserva), mientras
   * que acá la primera bifurcación es entre hablar con una persona o hablar con
   * el bot, y eso tiene que estar dicho en el primer mensaje o no se entiende
   * el número.
   *
   * Las opciones se eligen por palabra y no por número: el "1" y el "2" ya
   * significan otra cosa en el resto de los menús del sistema, y un cliente que
   * arrastra ese hábito terminaría pidiendo hablar con Simona sin querer.
   */
  welcome(customerName: string | null, events: WelcomeEvent[] = []): string {
    const lines = [
      customerName ? `¡Hola, ${customerName}! 👋` : '¡Hola! 👋',
      '',
      'Bienvenido/a a *De La Fonte* 🍝',
      '',
      '📱 Este número es compartido, así que decime qué necesitás:',
      '',
      '🗣️ *Hablar con Simona* → escribí *Simona*',
      '📅 *Reservar en De La Fonte* → escribí *Reservar*',
    ];

    // Sin eventos no va ni la sección ni la invitación a nombrar uno: ofrecer
    // algo que no existe deja al cliente escribiendo contra la nada.
    if (events.length > 0) {
      lines.push('', '✨ *Próximos eventos:*', '');
      lines.push(...events.map((event) => `• ${event.title} · ${capitalize(event.whenLabel)}`));
      lines.push('', 'También podés escribirme el nombre del evento.');
    }

    return lines.join('\n');
  },

  /**
   * Lo último que dice el bot antes de callarse.
   *
   * Tiene que dejar dos cosas claras, porque son las dos preguntas que se hace
   * quien queda del otro lado: que a partir de acá contesta una persona (y por
   * eso el silencio no es una falla), y cuál es la palabra exacta que trae al
   * bot de vuelta.
   */
  handoffConfirmation(): string {
    return (
      '🗣️ ¡Perfecto! Le paso tu mensaje a *Simona* 💛\n\n' +
      'Ella te responde por acá en cuanto pueda. Mientras tanto te dejo tranquilo/a: ' +
      'no te voy a interrumpir con mensajes automáticos.\n\n' +
      '_Cuando quieras reservar una mesa, escribí *Reservar* y te ayudo al toque._'
    );
  },
};
