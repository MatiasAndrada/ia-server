import { RedisConfig } from '../config/redis.js';
import { BOOK_KEYWORDS, CANCEL_KEYWORDS, buildKeywordPattern } from '../i18n/keywords.js';
import { logEvent, logger } from '../utils/logger.js';

/**
 * Adaptación de "De La Fonte": un solo número de WhatsApp para dos cosas.
 *
 * En este local el mismo contacto lo usan los clientes que quieren reservar y
 * los que quieren hablar con Simona, la dueña. Sin canalizar, el bot contesta
 * como si todo fuera una reserva: alguien que escribe para arreglar un
 * cumpleaños con ella termina peleándose con un asistente que le pregunta para
 * cuántas personas.
 *
 * La adaptación son tres piezas:
 *
 * 1. Un saludo propio que dice de entrada que el número es compartido y cómo
 *    elegir cada camino.
 * 2. Un interruptor: quien pide por Simona deja de recibir respuestas del bot.
 * 3. Una vuelta: alguna palabra de reserva reactiva al bot.
 *
 * Vive en su propio módulo, y no como columna de `businesses`, porque es una
 * excepción de un comercio y no un producto: el día que deje de hacer falta se
 * borra el archivo y se saca el llamado del handler. Si mañana un segundo local
 * pide lo mismo, ESE es el momento de generalizarlo a configuración.
 */

/**
 * Cuánto dura el silencio del bot desde que se canaliza a Simona.
 *
 * Doce horas es "el resto del día": Simona puede tardar en contestar, y hasta
 * que no cierre esa charla el bot no tiene nada que hacer ahí. No es una
 * ventana deslizante a propósito — si el cliente vuelve al día siguiente con un
 * "hola", lo que corresponde es el saludo, no más silencio. Dentro de las doce
 * horas la salida siempre está disponible escribiendo una palabra de reserva.
 */
const HANDOFF_TTL_SECONDS = 12 * 60 * 60;

const HANDOFF_KEY_PREFIX = 'adaptation:delafonte:handoff:';

/**
 * Qué comercios usan esta adaptación.
 *
 * Se resuelve por `DE_LA_FONTE_BUSINESS_ID` (uno o varios, separados por coma)
 * y, si no está configurada, por el nombre del comercio. El fallback por nombre
 * es lo que hace que esto funcione sin tocar el `.env` del servidor, que es
 * justamente donde un despliegue de una sola línea se cae.
 */
const BUSINESS_NAME_MARKER = 'de la fonte';

function configuredBusinessIds(): Set<string> {
  // Se lee en cada llamada y no al cargar el módulo: así un cambio de `.env`
  // entra con el próximo reinicio del proceso y no depende del orden de imports
  // (que es lo que rompía los tests al setear la variable en un `beforeEach`).
  return new Set(
    (process.env.DE_LA_FONTE_BUSINESS_ID ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isSharedNumberBusiness(
  businessId: string,
  businessName?: string | null
): boolean {
  if (configuredBusinessIds().has(businessId.trim().toLowerCase())) {
    return true;
  }

  return normalize(businessName ?? '').includes(BUSINESS_NAME_MARKER);
}

/**
 * Palabras con las que el cliente pide hablar con la dueña.
 *
 * El menú anuncia "escribí Simona", pero nadie escribe sólo lo que se le pide:
 * "quiero hablar con la dueña" tiene que llevar al mismo lado. Se matchean como
 * palabra completa, así que "encargada" no se dispara con "encargar".
 */
const SIMONA_PATTERN = buildKeywordPattern([
  'simona',
  'duena',
  'dueno',
  'encargada',
  'propietaria',
]);

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
const REACTIVATION_PATTERN = buildKeywordPattern([
  ...BOOK_KEYWORDS,
  ...CANCEL_KEYWORDS,
  'reservas',
  'mesa',
  'mesas',
  'turno',
]);

/**
 * Qué hacer con este turno.
 *
 * - `continue`: el bot atiende normalmente (incluye el caso "venía en silencio
 *   y el cliente lo reactivó": el mensaje que reactiva TAMBIÉN se contesta, que
 *   es lo que espera alguien que escribió "quiero reservar").
 * - `silence`: Simona está atendiendo, el bot no dice nada.
 * - `reply`: se canaliza a Simona y se confirma con este texto.
 */
export type SharedNumberOutcome =
  | { action: 'continue' }
  | { action: 'silence' }
  | { action: 'reply'; text: string };

/**
 * Decide el destino del mensaje antes de que lo toque el flujo normal.
 *
 * Corre ANTES del alta (idioma → nombre) a propósito: alguien que escribe para
 * hablar con Simona no tiene por qué pasar por un formulario de dos preguntas
 * para poder pedirlo.
 *
 * Nunca lanza. Con Redis caído no se puede saber si hay un traspaso activo, y
 * ante la duda contesta el bot: dejar callado a un cliente que sí quería
 * reservar es el peor de los dos errores.
 */
export async function interceptSharedNumberTurn(
  conversationId: string,
  messageText: string
): Promise<SharedNumberOutcome> {
  const normalized = normalize(messageText);

  if (await isHandedOff(conversationId)) {
    if (REACTIVATION_PATTERN.test(normalized)) {
      await resumeBot(conversationId);
      logEvent('info', 'handoff.resumed', { conversationId });
      return { action: 'continue' };
    }
    return { action: 'silence' };
  }

  if (SIMONA_PATTERN.test(normalized)) {
    await handOffToOwner(conversationId);
    logEvent('info', 'handoff.started', { conversationId, ttlSeconds: HANDOFF_TTL_SECONDS });
    return { action: 'reply', text: handoffConfirmation() };
  }

  return { action: 'continue' };
}

/**
 * Saludo de apertura del número compartido.
 *
 * Reemplaza al menú genérico (`templates.welcomeMenu`) sólo para este comercio.
 * La diferencia de fondo no es el texto: el menú genérico ofrece dos opciones
 * que son la misma cosa (reservar / modificar reserva), mientras que acá la
 * primera bifurcación es entre hablar con una persona o hablar con el bot, y
 * eso tiene que estar dicho en el primer mensaje o no se entiende el número.
 *
 * Las opciones se eligen por palabra y no por número: el "1" y el "2" ya
 * significan otra cosa en el resto de los menús del sistema, y un cliente que
 * arrastra ese hábito terminaría pidiendo hablar con Simona sin querer.
 */
export function sharedNumberWelcome(
  customerName: string | null,
  events: { title: string; whenLabel: string }[] = []
): string {
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
}

/**
 * Lo último que dice el bot antes de callarse.
 *
 * Tiene que dejar dos cosas claras, porque son las dos preguntas que se hace
 * quien queda del otro lado: que a partir de acá contesta una persona (y por
 * eso el silencio no es una falla), y cuál es la palabra exacta que trae al bot
 * de vuelta.
 */
function handoffConfirmation(): string {
  return (
    '🗣️ ¡Perfecto! Le paso tu mensaje a *Simona* 💛\n\n' +
    'Ella te responde por acá en cuanto pueda. Mientras tanto te dejo tranquilo/a: ' +
    'no te voy a interrumpir con mensajes automáticos.\n\n' +
    '_Cuando quieras reservar una mesa, escribí *Reservar* y te ayudo al toque._'
  );
}

async function isHandedOff(conversationId: string): Promise<boolean> {
  try {
    if (!RedisConfig.isReady()) return false;
    const raw = await RedisConfig.getClient().get(`${HANDOFF_KEY_PREFIX}${conversationId}`);
    return raw !== null;
  } catch (error) {
    logger.warn('Failed to read the De La Fonte handoff flag, the bot answers', {
      conversationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

async function handOffToOwner(conversationId: string): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().setEx(
      `${HANDOFF_KEY_PREFIX}${conversationId}`,
      HANDOFF_TTL_SECONDS,
      '1'
    );
  } catch (error) {
    logger.warn('Failed to persist the De La Fonte handoff flag', {
      conversationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function resumeBot(conversationId: string): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().del(`${HANDOFF_KEY_PREFIX}${conversationId}`);
  } catch (error) {
    logger.warn('Failed to clear the De La Fonte handoff flag', {
      conversationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/** Minúsculas y sin acentos, que es como los matchers de este módulo comparan. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
