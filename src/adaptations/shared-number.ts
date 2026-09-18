import { RedisConfig } from '../config/redis.js';
import { logEvent, logger } from '../utils/logger.js';

/**
 * Motor de las adaptaciones de "número compartido".
 *
 * Hay locales cuyo número de WhatsApp no es sólo del bot: el mismo contacto lo
 * usan los clientes que quieren reservar y los que quieren cualquier otra cosa
 * (hablar con la dueña, preguntar por un evento privado, un proveedor). Sin
 * canalizar, el bot contesta como si todo fuera una reserva, y alguien que
 * escribió para arreglar un cumpleaños termina peleándose con un asistente que
 * le pregunta para cuántas personas.
 *
 * La adaptación son siempre las mismas tres piezas:
 *
 * 1. Un saludo propio que dice de entrada que el número es compartido y cómo
 *    elegir cada camino.
 * 2. Un interruptor: quien pide por la persona deja de recibir respuestas.
 * 3. Una vuelta: alguna palabra de reserva reactiva al bot.
 *
 * Lo que cambia de un local a otro es el texto y las palabras, no el mecanismo.
 * Por eso el mecanismo vive acá y cada local aporta sólo su configuración (ver
 * `de-la-fonte.ts`, `sky.ts` y el registro en `index.ts`).
 *
 * Sigue sin ser una columna de `businesses` a propósito: son excepciones
 * puntuales con texto escrito a mano para cada local, no un producto que el
 * comercio configure solo. El día que un tercero o un cuarto pidan lo mismo con
 * la misma forma, ESE es el momento de moverlo a la base.
 */

/** Un evento vigente, tal como se lista en el saludo de apertura. */
export interface WelcomeEvent {
  title: string;
  whenLabel: string;
}

/**
 * Todo lo que distingue a un local de otro dentro de este mecanismo.
 *
 * Los patrones de `handoffPattern` y `reactivationPattern` llegan ya
 * construidos (y no como listas de palabras) porque la FORMA de matchear
 * también cambia entre locales: De La Fonte busca "simona" en cualquier parte
 * de la frase, mientras que SKY exige el mensaje exacto porque su palabra de
 * canalización es su propio nombre. Ver cada archivo.
 */
export interface SharedNumberAdaptation {
  /**
   * Identificador corto y estable. Es parte de la key de Redis, así que
   * cambiarlo suelta todos los traspasos activos de ese local: no se toca.
   */
  id: string;

  /** Variable de entorno con el/los id de comercio, separados por coma. */
  businessIdEnvVar: string;

  /** Con qué pide el cliente que lo atienda una persona. */
  handoffPattern: RegExp;

  /** Con qué vuelve el bot a hablar. */
  reactivationPattern: RegExp;

  /**
   * Sólo para locales cuyo saludo ofrece elegir por número además de por
   * palabra (ver `la-mision.ts`). Si está seteado, vale exactamente lo mismo
   * que `handoffPattern` — pero únicamente en la respuesta INMEDIATA al
   * saludo, la que llega justo después de mostrarlo (ver `markWelcomeMenuShown`
   * más abajo).
   *
   * Pasado ese único turno, el dígito vuelve a ser un mensaje cualquiera: si
   * más adelante el flujo de reserva pregunta algo que se contesta con un
   * número ("¿para cuántos? 1"), esa respuesta no tiene que poder canalizar
   * por accidente. Y un traspaso ya activo tampoco se reactiva con el dígito
   * nunca — de eso se ocupan sólo las palabras de `reactivationPattern`, así
   * que ni siquiera se consulta acá dentro del branch de `isHandedOff`.
   */
  handoffMenuDigit?: string;

  /** Saludo de apertura, en reemplazo del menú genérico. */
  welcome(customerName: string | null, events: WelcomeEvent[]): string;

  /** Lo último que dice el bot antes de callarse. */
  handoffConfirmation(): string;
}

/**
 * Cuánto dura el silencio del bot desde que se canaliza a una persona.
 *
 * Doce horas es "el resto del día": la persona puede tardar en contestar, y
 * hasta que no cierre esa charla el bot no tiene nada que hacer ahí. No es una
 * ventana deslizante a propósito — si el cliente vuelve al día siguiente con un
 * "hola", lo que corresponde es el saludo, no más silencio. Dentro de las doce
 * horas la salida siempre está disponible escribiendo una palabra de reserva.
 */
const HANDOFF_TTL_SECONDS = 12 * 60 * 60;

function handoffKey(adaptation: SharedNumberAdaptation, conversationId: string): string {
  return `adaptation:${adaptation.id}:handoff:${conversationId}`;
}

/**
 * Cuánto dura la ventana en la que el dígito de `handoffMenuDigit` vale como
 * respuesta al saludo. Media hora es tiempo de sobra para contestar un menú
 * que se acaba de leer; pasado eso, un "1" suelto no tiene por qué seguir
 * significando "consultas" — es más probable que sea la respuesta a otra
 * pregunta que ya se le hizo al cliente.
 */
const MENU_REPLY_TTL_SECONDS = 30 * 60;

function menuReplyKey(adaptation: SharedNumberAdaptation, conversationId: string): string {
  return `adaptation:${adaptation.id}:menu-reply:${conversationId}`;
}

/**
 * Marca que se acaba de mostrar el saludo de este local, así el próximo turno
 * sabe que un dígito suelto puede ser la respuesta a ese menú.
 *
 * No hace nada si el local no ofrece elegir por número: guardar la marca para
 * un local que nunca la va a consultar es trabajo de más contra Redis.
 */
export async function markWelcomeMenuShown(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<void> {
  if (adaptation.handoffMenuDigit === undefined) return;

  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().setEx(
      menuReplyKey(adaptation, conversationId),
      MENU_REPLY_TTL_SECONDS,
      '1'
    );
  } catch (error) {
    logger.warn('Failed to persist the welcome-menu-reply flag', {
      conversationId,
      adaptation: adaptation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Consume la marca de `markWelcomeMenuShown`: la lee y la borra en el mismo
 * paso, para que sólo pueda valer una vez. Se llama en CADA turno sin
 * traspaso activo (no sólo cuando el mensaje es el dígito) — si no se
 * consumiera siempre, un primer "hola" la dejaría viva y un "1" varios
 * mensajes después la heredaría sin ser realmente la respuesta al saludo.
 */
async function consumeMenuReplyFlag(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<boolean> {
  if (adaptation.handoffMenuDigit === undefined) return false;

  try {
    if (!RedisConfig.isReady()) return false;
    const client = RedisConfig.getClient();
    const key = menuReplyKey(adaptation, conversationId);
    const raw = await client.get(key);
    if (raw !== null) await client.del(key);
    return raw !== null;
  } catch (error) {
    logger.warn('Failed to read the welcome-menu-reply flag, the digit is ignored', {
      conversationId,
      adaptation: adaptation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/**
 * ¿Este comercio usa esta adaptación?
 *
 * Se resuelve únicamente por la variable de entorno (uno o varios ids
 * separados por coma). Si no está configurada, la adaptación se trata como si
 * no existiera: no hay fallback por nombre, porque matchear por nombre puede
 * activar la adaptación en un comercio que no es el que se quiso configurar.
 */
export function matchesBusiness(adaptation: SharedNumberAdaptation, businessId: string): boolean {
  return configuredBusinessIds(adaptation.businessIdEnvVar).has(businessId.trim().toLowerCase());
}

function configuredBusinessIds(envVar: string): Set<string> {
  // Se lee en cada llamada y no al cargar el módulo: así un cambio de `.env`
  // entra con el próximo reinicio del proceso y no depende del orden de imports
  // (que es lo que rompía los tests al setear la variable en un `beforeEach`).
  return new Set(
    (process.env[envVar] ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Qué hacer con este turno.
 *
 * - `continue`: el bot atiende normalmente (incluye el caso "venía en silencio
 *   y el cliente lo reactivó": el mensaje que reactiva TAMBIÉN se contesta, que
 *   es lo que espera alguien que escribió "quiero reservar").
 * - `silence`: está atendiendo una persona, el bot no dice nada.
 * - `reply`: se canaliza a la persona y se confirma con este texto.
 */
export type SharedNumberOutcome =
  | { action: 'continue' }
  | { action: 'silence' }
  | { action: 'reply'; text: string };

/**
 * Decide el destino del mensaje antes de que lo toque el flujo normal.
 *
 * Corre ANTES del alta (idioma → nombre) a propósito: alguien que escribe para
 * hablar con una persona no tiene por qué pasar por un formulario de dos
 * preguntas para poder pedirlo.
 *
 * Nunca lanza. Con Redis caído no se puede saber si hay un traspaso activo, y
 * ante la duda contesta el bot: dejar callado a un cliente que sí quería
 * reservar es el peor de los dos errores.
 */
export async function interceptSharedNumberTurn(
  adaptation: SharedNumberAdaptation,
  conversationId: string,
  messageText: string
): Promise<SharedNumberOutcome> {
  const normalized = normalize(messageText);

  if (await isHandedOff(adaptation, conversationId)) {
    if (adaptation.reactivationPattern.test(normalized)) {
      await resumeBot(adaptation, conversationId);
      logEvent('info', 'handoff.resumed', { conversationId, adaptation: adaptation.id });
      return { action: 'continue' };
    }
    return { action: 'silence' };
  }

  // Se consume en CADA turno sin traspaso activo, no sólo cuando el mensaje
  // matchea el dígito: es la única forma de que la marca sirva nada más que
  // para la respuesta inmediata al saludo (ver `consumeMenuReplyFlag`).
  const repliedToMenu = await consumeMenuReplyFlag(adaptation, conversationId);
  const isMenuDigit =
    repliedToMenu &&
    adaptation.handoffMenuDigit !== undefined &&
    normalized === adaptation.handoffMenuDigit;

  if (adaptation.handoffPattern.test(normalized) || isMenuDigit) {
    await handOffToHuman(adaptation, conversationId);
    logEvent('info', 'handoff.started', {
      conversationId,
      adaptation: adaptation.id,
      ttlSeconds: HANDOFF_TTL_SECONDS,
      via: isMenuDigit ? 'menu-digit' : 'keyword',
    });
    return { action: 'reply', text: adaptation.handoffConfirmation() };
  }

  return { action: 'continue' };
}

async function isHandedOff(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<boolean> {
  try {
    if (!RedisConfig.isReady()) return false;
    const raw = await RedisConfig.getClient().get(handoffKey(adaptation, conversationId));
    return raw !== null;
  } catch (error) {
    logger.warn('Failed to read the shared-number handoff flag, the bot answers', {
      conversationId,
      adaptation: adaptation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

async function handOffToHuman(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().setEx(
      handoffKey(adaptation, conversationId),
      HANDOFF_TTL_SECONDS,
      '1'
    );
  } catch (error) {
    logger.warn('Failed to persist the shared-number handoff flag', {
      conversationId,
      adaptation: adaptation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function resumeBot(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<void> {
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().del(handoffKey(adaptation, conversationId));
  } catch (error) {
    logger.warn('Failed to clear the shared-number handoff flag', {
      conversationId,
      adaptation: adaptation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/** Minúsculas y sin acentos, que es como los matchers de este módulo comparan. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
