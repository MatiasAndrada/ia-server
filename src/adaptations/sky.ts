import {
  BOOK_KEYWORDS,
  CANCEL_KEYWORDS,
  buildExactKeywordPattern,
  buildKeywordPattern,
} from '../i18n/keywords.js';
import { capitalize, type SharedNumberAdaptation, type WelcomeEvent } from './shared-number.js';

/**
 * SKY Restaurante and Bar: el número es el del local, no el del bot.
 *
 * A diferencia de De La Fonte, acá el otro camino no es una persona con nombre
 * y apellido sino "todo lo que no sea reservar": consultas, proveedores,
 * eventos privados. El menú lo dice así y el efecto es el mismo — el bot se
 * calla y la conversación queda para el equipo del local.
 */
export const skyAdaptation: SharedNumberAdaptation = {
  id: 'sky',
  businessIdEnvVar: 'SKY_BUSINESS_ID',

  /**
   * Acá está la diferencia importante con De La Fonte, y el motivo por el que
   * el patrón se declara por local y no lo arma el motor.
   *
   * La palabra de canalización de SKY es *el nombre del local*, que es
   * exactamente lo que la gente escribe cuando QUIERE reservar: "hola, quiero
   * reservar en Sky para 4". Buscándola en cualquier parte de la frase, la
   * adaptación silenciaría al bot justo en el mensaje que venía a pedir una
   * mesa — al revés de para lo que existe.
   *
   * Por eso se exige el mensaje entero: "SKY" a secas, que es literalmente lo
   * que el menú pide escribir. El precio es que "hola sky" no canaliza; el
   * cliente recibe el saludo, que vuelve a decirle la palabra exacta.
   */
  handoffPattern: buildExactKeywordPattern([
    'sky',
    'consulta',
    'consultas',
    'otra consulta',
    'otras consultas',
    'otro tipo de consulta',
    'info',
    'informacion',
    'otra info',
  ]),

  /**
   * Igual que en `antigal.ts`: un pedido ajeno a las reservas no siempre trae
   * una de las palabras de `handoffPattern` ("hola, quería preguntar por un
   * evento privado" no dice "SKY" ni "consulta"). Con este contexto el modelo
   * lo reconoce. Lo que es para el equipo y no para el bot (proveedores,
   * empleados, amigos) queda en silencio; el cliente que consulta por algo
   * ajeno a la reserva se contesta (ver `inquiryGuidance`).
   */
  humanContext:
    'Este número de WhatsApp es el del local SKY Restaurante and Bar y lo atiende también su ' +
    'equipo: las consultas que no son reservas de mesa, los eventos privados, los proveedores y ' +
    'los temas internos son de ellos.',

  /**
   * "Hola, quería preguntar por un evento privado" es un cliente, no un
   * mensaje para el equipo: silenciarlo lo deja sin respuesta en el primer
   * contacto. El bot le contesta y le muestra la salida que el menú ya enseña
   * — escribir *SKY* —, que es la que efectivamente deja el chat al equipo.
   * No inventa condiciones ni precios de eventos que no conoce.
   */
  inquiryGuidance:
    'Respondé con naturalidad a lo que preguntó (por ejemplo, que los eventos privados los ' +
    'coordina directamente el equipo de SKY), sin inventar precios, capacidades ni disponibilidad, ' +
    'y cerrá diciéndole que escriba *SKY* (en negrita) para seguir esa consulta por este mismo ' +
    'chat con el equipo. Si además quiere reservar una mesa, atendelo vos.',

  /**
   * Igual que en De La Fonte: sólo palabras del mundo de la reserva. Una
   * reactivación de más se mete en medio de una conversación real; una de menos
   * se arregla con el "escribí *Reserva*" que dejó el mensaje de traspaso.
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
   * Si fue el equipo el que escribió en el chat, sólo la palabra sola le
   * devuelve el chat al bot: "Reserva" (lo que enseñan el saludo y la
   * confirmación) o "Cancelar" (lo que piden los recordatorios).
   */
  resumeCommandPattern: buildExactKeywordPattern([...BOOK_KEYWORDS, ...CANCEL_KEYWORDS, 'reservas']),

  welcome(customerName: string | null, events: WelcomeEvent[] = []): string {
    const lines = [
      customerName ? `¡Hola, ${customerName}! 👋` : '¡Hola! 👋',
      'Bienvenido/a a SKY Restaurante and Bar',
      '',
      '¿Qué te gustaría hacer?',
      '',
      '📅 *Reservar una mesa* → escribí *Reserva*',
      '🗣️ *Otro tipo de consulta o info* → escribí *SKY*',
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
   * Lo último que dice el bot antes de callarse.
   *
   * Describe el mecanismo real y nada más: el bot deja de contestar y el chat
   * queda para el local. No promete que alguien "le va a transmitir" la
   * consulta — esa mentira es justamente la que el system prompt le prohíbe al
   * modelo (ver src/agent/system-prompt.ts), y no tendría sentido que el texto
   * fijo la dijera igual.
   */
  handoffConfirmation(): string {
    return (
      '🗣️ ¡Listo! Desde acá seguís por este mismo chat con *SKY* 💫\n\n' +
      'Dejo de responder automáticamente así no te interrumpo la conversación.\n\n' +
      '_Cuando quieras reservar una mesa, escribí *Reserva* y te ayudo al toque._'
    );
  },
};
