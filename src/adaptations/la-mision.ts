import {
  BOOK_KEYWORDS,
  CANCEL_KEYWORDS,
  buildExactKeywordPattern,
  buildKeywordPattern,
} from '../i18n/keywords.js';
import { capitalize, type SharedNumberAdaptation, type WelcomeEvent } from './shared-number.js';

/**
 * Restaurante La Misión, dentro del Gran Amérian Portal del Iguazú: el número
 * de WhatsApp es el del hotel, no el del restaurante. El otro camino no es una
 * persona con nombre (como en De La Fonte) ni "todo lo que no sea reservar"
 * (como en SKY), sino específicamente las consultas del hotel — check-in,
 * habitaciones, todo lo que este bot de reservas de mesa no sabe responder.
 *
 * La diferencia de fondo con SKY y De La Fonte es que acá el saludo también
 * ofrece elegir por número (1/2/3), no sólo por palabra. Ese número sólo vale
 * como respuesta inmediata al saludo — el mecanismo vive en
 * `shared-number.ts` (`handoffMenuDigit`, `markWelcomeMenuShown`) precisamente
 * para que un "1" contestado más adelante en la conversación (por ejemplo, a
 * "¿para cuántas noches?") no channel por accidente. Las opciones 2 y 3 no
 * necesitan ese mecanismo: al no matchear `handoffPattern`, siguen al flujo
 * normal y es el modelo el que las interpreta con el menú recién mostrado a
 * la vista, igual que ya hace con el menú genérico de dos opciones.
 */
export const laMisionAdaptation: SharedNumberAdaptation = {
  // Parte de la key de Redis desde el primer despliegue: cambiarlo soltaría
  // todos los traspasos activos.
  id: 'lamision',
  businessIdEnvVar: 'LA_MISION_BUSINESS_ID',

  /**
   * Igual que en SKY: la palabra de canalización ("consultas") no es el
   * nombre del restaurante, así que no hay riesgo de que un pedido real de
   * reserva la dispare. Se exige el mensaje entero por la misma razón que en
   * SKY — es literalmente lo que el menú pide escribir.
   */
  handoffPattern: buildExactKeywordPattern(['consultas', 'consulta']),

  /** El dígito de la opción 1 del menú, sólo válido como su respuesta inmediata. */
  handoffMenuDigit: '1',

  /**
   * Palabras del mundo de la reserva de mesa, más el nombre del restaurante:
   * es la opción 2 del menú, así que pedirlo por nombre también tiene que
   * traer de vuelta al bot. Deliberadamente sin nada específico del evento de
   * turno (hoy "sushi"): esta lista es del mecanismo, no del cartel de la
   * semana, y ese cambia sin tocar código.
   */
  reactivationPattern: buildKeywordPattern([
    ...BOOK_KEYWORDS,
    ...CANCEL_KEYWORDS,
    'reservas',
    'mesa',
    'mesas',
    'turno',
    'mision',
  ]),

  welcome(_customerName: string | null, events: WelcomeEvent[] = []): string {
    const lines = [
      '✨ Bienvenidos al Gran Amérian Portal del Iguazú',
      '',
      'Será un placer acompañarte. ¿Qué te gustaría hacer?',
      '',
      '1️⃣ Consultas sobre el hotel',
      'Escribí CONSULTAS o respondé 1',
      '',
      '2️⃣ Reservar en Restaurante La Misión 🍽️',
      'Escribí LA MISIÓN o respondé 2',
    ];

    // Sin eventos no va ni la opción 3 ni la invitación a nombrar uno: ofrecer
    // algo que no existe deja al cliente escribiendo contra la nada.
    if (events.length > 0) {
      lines.push('', '3️⃣ Próximos eventos ✨');

      if (events.length === 1) {
        const event = events[0]!;
        // Con un solo evento se ofrece también por número, que es más fácil de
        // contestar; con varios no se puede elegir "3" por el cliente.
        lines.push(`🍣 ${event.title}`, `📅 ${capitalize(event.whenLabel)}`, '');
        lines.push(`Escribí ${event.title.toUpperCase()} o respondé 3 para reservar tu lugar.`);
      } else {
        lines.push(...events.map((event) => `🍣 ${event.title} · ${capitalize(event.whenLabel)}`));
        lines.push('', 'Escribí el nombre del evento para reservar tu lugar.');
      }
    }

    return lines.join('\n');
  },

  /**
   * Lo último que dice el bot antes de callarse.
   *
   * Describe el mecanismo real: el bot deja de contestar y el chat queda para
   * el equipo del hotel. No promete que alguien "le va a transmitir" la
   * consulta — ver la nota equivalente en sky.ts.
   */
  handoffConfirmation(): string {
    return (
      '🗣️ ¡Listo! Desde acá seguís por este mismo chat con el equipo del hotel 💫\n\n' +
      'Dejo de responder automáticamente así no te interrumpo la conversación.\n\n' +
      '_Cuando quieras reservar en Restaurante La Misión, escribí *LA MISIÓN* y te ayudo al toque._'
    );
  },
};
