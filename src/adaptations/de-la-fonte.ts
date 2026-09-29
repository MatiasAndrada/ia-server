import { BOOK_KEYWORDS, CANCEL_KEYWORDS, buildKeywordPattern } from '../i18n/keywords.js';
import { capitalize, type SharedNumberAdaptation, type WelcomeEvent } from './shared-number.js';

/**
 * De La Fonte: el mismo número lo comparten el bot de reservas y una persona
 * del local que atiende lo que no es reserva.
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
   * El menú anuncia "escribí PERSONAL", pero nadie escribe sólo lo que se le
   * pide: "quiero hablar con la dueña" tiene que llevar al mismo lado. Se
   * matchean como palabra completa en cualquier parte de la frase, así que
   * "encargada" no se dispara con "encargar". Los sinónimos previos ("simona",
   * el nombre que usaba el menú viejo) se mantienen para no romper el traspaso
   * de quien todavía escribe por costumbre.
   */
  handoffPattern: buildKeywordPattern([
    'personal',
    'duena',
    'dueña',
    'dueño',
    'dueno',
    'encargada',
    'propietaria',
    'simona',
  ]),

  /**
   * Igual que en `antigal.ts`: un pedido ajeno a las reservas no siempre trae
   * una de las palabras de `handoffPattern`, y sin este hint el modelo caía
   * en su fallback genérico en vez de nombrar la vía real de contacto.
   */
  outOfScopeHint:
    'Si quien te escribe no es cliente de reservas — un proveedor, un trámite ajeno al local — ' +
    'o pide explícitamente hablar con una persona o atención personalizada, no lo mandes a ' +
    '"contactar al local": decile que escriba *PERSONAL* (en negrita) y ese mismo chat sigue ' +
    'con alguien del local.',

  /**
   * Una vez que el cliente elige atención personalizada, el bot no vuelve a
   * activarse en ese chat, de ninguna manera: sin vencimiento y sin palabra de
   * salida. Por eso `reactivationPattern` queda definido sólo por requisito de
   * la interfaz y el motor no lo consulta.
   */
  permanentHandoff: true,

  /** No se usa mientras `permanentHandoff` esté activo (ver arriba). */
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
   * arrastra ese hábito terminaría pidiendo atención personalizada sin querer.
   */
  welcome(customerName: string | null, events: WelcomeEvent[] = []): string {
    const lines = [
      customerName ? `¡Hola, ${customerName}! 👋` : '¡Hola! 👋',
      'Bienvenido/a a De La Fonte',
      '',
      '¿Qué te gustaría hacer?',
      '',
      '📅 *Reservar una mesa* → escribí *RESERVAR*',
      '🗣️ *Atención personalizada* → escribí *PERSONAL*',
    ];

    // Sin eventos no va ni la sección ni la invitación a nombrar uno: ofrecer
    // algo que no existe deja al cliente escribiendo contra la nada.
    if (events.length > 0) {
      lines.push(
        '',
        events.length === 1
          ? '✨ También podés reservar para nuestro próximo evento:'
          : '✨ También podés reservar para nuestros próximos eventos:'
      );
      lines.push(...events.map((event) => `🍝 ${event.title} · ${capitalize(event.whenLabel)}`));
      // Con un solo evento se nombra, que es más fácil de contestar que una
      // instrucción genérica; con varios no se puede elegir por el cliente.
      lines.push(
        events.length === 1
          ? `→ Escribí *${events[0]!.title}* para reservar tu lugar.`
          : '→ Escribí el nombre del evento para reservar tu lugar.'
      );
    }

    return lines.join('\n');
  },

  /**
   * Lo último que dice el bot antes de callarse para siempre en este chat.
   *
   * Tiene que dejar clara la pregunta de quien queda del otro lado: que a
   * partir de acá contesta una persona y por eso el silencio no es una falla.
   * No ofrece salida — no la hay.
   */
  handoffConfirmation(): string {
    return (
      '🗣️ ¡Perfecto! Le paso tu mensaje al equipo de *De La Fonte* 💛\n\n' +
      'Te van a responder por acá apenas puedan. No te enviaremos mensajes automáticos ' +
      'para no interrumpirte.'
    );
  },
};
