import { RedisConfig } from '../config/redis.js';
import { GREETING_UNIT_SOURCE } from '../i18n/keywords.js';
import { logEvent, logger } from '../utils/logger.js';
import {
  hasPermanentHandoff,
  hasSilence,
  removeSilence,
  savePermanentHandoff,
  saveSilence,
} from './handoff-store.js';

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
 * La adaptación son siempre las mismas cuatro piezas:
 *
 * 1. Un saludo propio que dice de entrada que el número es compartido y cómo
 *    elegir cada camino.
 * 2. Un interruptor: quien pide por la persona — o le escribe algo que no es
 *    para el bot — deja de recibir respuestas.
 * 3. Una vuelta: alguna palabra de reserva reactiva al bot.
 * 4. Si la persona del local escribe en un chat desde el celular, ese chat es
 *    suyo y el bot se corre (ver `registerHumanReply`). Sin esto, el amigo que
 *    le contesta un mensaje a la dueña recibe la respuesta del bot.
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
 * también cambia entre locales: De La Fonte busca "personal" en cualquier
 * parte de la frase, mientras que SKY exige el mensaje exacto porque su
 * palabra de canalización es su propio nombre. Ver cada archivo.
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

  /** Con qué vuelve el bot a hablar. Se ignora si `permanentHandoff` está activo. */
  reactivationPattern: RegExp;

  /**
   * Con qué recupera el bot un chat que quedó en manos de la persona porque
   * ELLA escribió ahí desde el celular (ver `registerHumanReply`).
   *
   * A diferencia de `reactivationPattern`, tiene que ser el mensaje ENTERO
   * ("Reservar", "Cancelar"): en una charla con la persona es normal que
   * aparezca "mesa" o "reserva" en medio de una frase ("¿tenés mesa el
   * sábado?"), y eso es para ella, no para el bot. La palabra sola, en
   * cambio, es la que el saludo y la confirmación del traspaso le enseñan al
   * cliente — y la que le piden los recordatorios para cancelar.
   *
   * Sin esto ese silencio termina sólo con el tiempo. Se ignora si
   * `permanentHandoff` está activo: ahí nada reactiva al bot.
   */
  resumeCommandPattern?: RegExp;

  /**
   * Si es `true`, canalizar a la persona es definitivo para esa conversación:
   * el traspaso se guarda sin vencimiento en el archivo local (ver
   * `handoff-store.ts`) y NADA reactiva al bot — ni `reactivationPattern`, ni
   * el paso del tiempo, ni un saludo al día siguiente. Sin esto rige el
   * comportamiento por defecto (silencio de cuarenta y ocho horas con salida
   * por palabra de reserva), que también se guarda en ese archivo.
   */
  permanentHandoff?: boolean;

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

  /**
   * Quién más atiende este número y qué mensajes son suyos, dicho para el
   * modelo. Es lo que le permite reconocer lo que no matchea `handoffPattern`
   * pero tampoco es para el bot: el amigo que escribe "holaa simo todo bien?",
   * el empleado que avisa que mañana falta, el proveedor que ofrece
   * mercadería.
   *
   * Con esto el modelo tiene disponible `hand_off_to_human` (ver
   * `agent/tools/handoff.tools.ts`), que deja el chat en manos de la persona
   * SIN responder nada. Antes el modelo le contestaba a esa gente pidiéndole
   * que escribiera la palabra del menú — que es exactamente el bot metiéndose
   * en una charla ajena. Se inyecta en el prompt estático (ver
   * `buildStaticPrompt`), así que el texto tiene que quedar igual entre
   * turnos del mismo comercio.
   */
  humanContext: string;

  /**
   * Opcional. Qué hacer con el cliente que escribe algo ajeno a las reservas y
   * NO le habla a la persona ("quería preguntar por un evento privado"). Sin
   * esto el modelo lo deriva en silencio con `hand_off_to_human`; con esto le
   * contesta, siguiendo este texto (ver `buildSharedNumberSection` en
   * system-prompt.ts).
   *
   * Lo personal, lo de proveedores/empleados y lo dirigido a la persona por su
   * nombre sigue yendo en silencio: esto sólo cubre al cliente. Se inyecta en
   * el prompt estático, así que tiene que quedar igual entre turnos.
   */
  inquiryGuidance?: string;

  /** Saludo de apertura, en reemplazo del menú genérico. */
  welcome(customerName: string | null, events: WelcomeEvent[]): string;

  /** Lo último que dice el bot antes de callarse. */
  handoffConfirmation(): string;
}

/**
 * Cuánto dura el silencio del bot desde que se canaliza a una persona.
 *
 * Cuarenta y ocho horas cubren un par de días completos: la persona puede
 * tardar en contestar, y hasta que no cierre esa charla el bot no tiene nada
 * que hacer ahí. No es una ventana deslizante a propósito — si el cliente
 * vuelve pasadas las cuarenta y ocho horas con un "hola", lo que corresponde
 * es el saludo, no más silencio. Dentro de la ventana la salida siempre está
 * disponible escribiendo una palabra de reserva.
 */
const HANDOFF_TTL_SECONDS = 48 * 60 * 60;

function handoffKey(adaptation: SharedNumberAdaptation, conversationId: string): string {
  return `adaptation:${adaptation.id}:handoff:${conversationId}`;
}

/**
 * Cuánto dura el silencio cuando la persona del local ESCRIBIÓ en el chat
 * (ver `registerHumanReply`). Se renueva con cada mensaje suyo, así que es
 * "cuarenta y ocho horas desde la última vez que ella habló ahí".
 *
 * Hoy vale lo mismo que `HANDOFF_TTL_SECONDS`, pero se mantienen separadas:
 * la señal es distinta — no es un cliente que pidió por alguien, es ella
 * atendiendo — y acá la ventana sí se desliza. Un cliente que quiera volver a
 * reservar con el bot antes de que venza tiene la salida de
 * `resumeCommandPattern`.
 */
const HUMAN_REPLY_TTL_SECONDS = 48 * 60 * 60;

function humanReplyKey(adaptation: SharedNumberAdaptation, conversationId: string): string {
  return `adaptation:${adaptation.id}:human:${conversationId}`;
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
 * - `silence`: el chat es de la persona y el bot no dice nada — porque el
 *   cliente pidió por ella (`handoff`) o porque ella escribió ahí (`human`).
 *   Incluye el mensaje que recién canaliza sin hablarle al bot ("Hola
 *   Simona!", ver `talksToTheBot`).
 * - `reply`: se canaliza a la persona y se confirma con este texto.
 */
export type SharedNumberOutcome =
  | { action: 'continue' }
  | { action: 'silence'; reason: 'handoff' | 'human' }
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

  // La persona escribió en este chat: la conversación es suya. Va antes que
  // el traspaso porque es la señal más fuerte, y porque su salida es más
  // estricta (sólo el mensaje exacto, ver `resumeCommandPattern`).
  if (await isHumanInCharge(adaptation, conversationId)) {
    if (adaptation.resumeCommandPattern?.test(normalized)) {
      await resumeBot(adaptation, conversationId);
      logEvent('info', 'handoff.resumed', {
        conversationId,
        adaptation: adaptation.id,
        via: 'command',
      });
      return { action: 'continue' };
    }
    return { action: 'silence', reason: 'human' };
  }

  if (await isHandedOff(adaptation, conversationId)) {
    if (!adaptation.permanentHandoff && adaptation.reactivationPattern.test(normalized)) {
      await resumeBot(adaptation, conversationId);
      logEvent('info', 'handoff.resumed', { conversationId, adaptation: adaptation.id });
      return { action: 'continue' };
    }
    return { action: 'silence', reason: 'handoff' };
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

    // Contestar el menú ("PERSONAL", "quiero hablar con Valentina") es
    // hablarle al bot, y el bot confirma antes de callarse. Nombrar a la
    // persona en medio de otra cosa ("Hola Simona!! ¿cómo estás?", "Buen día
    // Simona, te quería ofrecer...") es hablarle a ELLA: el bot se corre sin
    // aparecer, que es justo lo que se le reclamaba.
    const answersTheMenu = isMenuDigit || talksToTheBot(adaptation.handoffPattern, normalized);
    logEvent('info', 'handoff.started', {
      conversationId,
      adaptation: adaptation.id,
      ttlSeconds: adaptation.permanentHandoff ? null : HANDOFF_TTL_SECONDS,
      via: isMenuDigit ? 'menu-digit' : 'keyword',
      silent: !answersTheMenu,
    });
    return answersTheMenu
      ? { action: 'reply', text: adaptation.handoffConfirmation() }
      : { action: 'silence', reason: 'handoff' };
  }

  return { action: 'continue' };
}

/**
 * Las fórmulas con las que se le pide AL BOT por la persona: "quiero hablar
 * con", "quería comunicarme con la"..., con un saludo opcional adelante. El
 * texto ya viene normalizado (minúsculas, sin acentos ni signos).
 */
const ASKS_FOR_SOMEONE_PREFIX = new RegExp(
  `^(?:${GREETING_UNIT_SOURCE}\\s+)*` +
    '(?:(?:quiero|quisiera|queria|necesito|puedo|podria|me gustaria)\\s+)?' +
    '(?:hablar|comunicarme|charlar)\\s+con\\s+(?:la\\s+|el\\s+)?'
);

/**
 * ¿El mensaje que matcheó `handoffPattern` le habla al bot, o a la persona?
 *
 * Le habla al bot si es la palabra del menú sola ("PERSONAL", "Valentina") o
 * un pedido que arranca por ella ("quería hablar con la dueña por un
 * cumpleaños"). Cualquier otra forma de nombrarla es hablarle a ella: "Hola
 * Simona", "Simona, te paso las facturas".
 */
function talksToTheBot(handoffPattern: RegExp, normalized: string): boolean {
  const request = ASKS_FOR_SOMEONE_PREFIX.exec(normalized);
  const start = request ? request[0].length : 0;
  // La palabra tiene que estar justo donde termina el pedido (o al principio).
  // Se busca sobre el texto entero, anclada en esa posición, y no sobre el
  // resto recortado: un patrón con lookbehind (el "vale" de Antigal) necesita
  // ver lo que viene antes.
  const anchored = new RegExp(handoffPattern.source, `${handoffPattern.flags.replace(/[gy]/g, '')}y`);
  anchored.lastIndex = start;
  const match = anchored.exec(normalized);
  if (!match) return false;
  // Después de un pedido puede venir el motivo; sin pedido, sólo vale la
  // palabra sola.
  return request !== null || match[0].length === normalized.length - start;
}

/**
 * La persona del local escribió en este chat (desde el celular o WhatsApp
 * Web): a partir de acá la conversación es suya y el bot no contesta.
 *
 * Con `permanentHandoff` es el mismo traspaso permanente de siempre — archivo
 * local, sin salida —, porque para ese local "el bot no vuelve en un chat que
 * atendió una persona" ya es la regla. Si no, silencio de
 * `HUMAN_REPLY_TTL_SECONDS` que se renueva con cada mensaje suyo y se levanta
 * antes con `resumeCommandPattern`.
 *
 * Quién decide que el mensaje lo escribió ella y no el celular solo (el
 * saludo automático de WhatsApp Business) es el handler, antes de llamar acá.
 *
 * Devuelve si el chat recién ahora pasó a sus manos, para loguear el cambio
 * una vez y no en cada mensaje suyo. Nunca lanza.
 */
export async function registerHumanReply(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<boolean> {
  if (adaptation.permanentHandoff) {
    if (await hasPermanentHandoff(adaptation.id, conversationId)) return false;
    await savePermanentHandoff(adaptation.id, conversationId);
    return true;
  }

  const alreadyHers = await isHumanInCharge(adaptation, conversationId);
  // El archivo es lo que sobrevive a un reinicio de Redis; Redis queda como
  // copia, y para los silencios que ya estaban ahí antes del archivo.
  await saveSilence(adaptation.id, conversationId, {
    kind: 'human',
    expiresAt: new Date(Date.now() + HUMAN_REPLY_TTL_SECONDS * 1000),
  });
  try {
    if (RedisConfig.isReady()) {
      await RedisConfig.getClient().setEx(
        humanReplyKey(adaptation, conversationId),
        HUMAN_REPLY_TTL_SECONDS,
        '1'
      );
    }
  } catch (error) {
    logger.warn('Failed to persist the human-reply flag in Redis, the file keeps it', {
      conversationId,
      adaptation: adaptation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
  return !alreadyHers;
}

/**
 * El traspaso que decide el modelo (`hand_off_to_human`): el mismo silencio
 * que pedir por la persona con la palabra del menú, pero sin la confirmación.
 * Quien escribió no le estaba hablando al bot — un amigo, un proveedor —, así
 * que el bot no aparece.
 */
export async function handOffWithoutReply(
  adaptation: SharedNumberAdaptation,
  conversationId: string,
  reason?: string
): Promise<void> {
  await handOffToHuman(adaptation, conversationId);
  logEvent('info', 'handoff.started', {
    conversationId,
    adaptation: adaptation.id,
    ttlSeconds: adaptation.permanentHandoff ? null : HANDOFF_TTL_SECONDS,
    via: 'agent',
    silent: true,
    ...(reason && { reason }),
  });
}

/**
 * ¿El bot tiene que quedarse callado en este chat, por la razón que sea?
 *
 * Lo usa el handler después de que el modelo contesta: si mientras se
 * generaba la respuesta la persona empezó a escribir desde el celular, esa
 * respuesta ya no se manda. Nunca lanza.
 */
export async function isBotMuted(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<boolean> {
  return (
    (await isHumanInCharge(adaptation, conversationId)) ||
    (await isHandedOff(adaptation, conversationId))
  );
}

async function isHumanInCharge(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<boolean> {
  // Con traspaso permanente, que escriba la persona ES un traspaso permanente
  // (ver `registerHumanReply`): ya lo responde `isHandedOff`.
  if (adaptation.permanentHandoff) return false;

  if (await hasSilence(adaptation.id, conversationId, 'human')) return true;

  // Los silencios anteriores al archivo viven sólo en Redis hasta que vencen.
  try {
    if (!RedisConfig.isReady()) return false;
    const raw = await RedisConfig.getClient().get(humanReplyKey(adaptation, conversationId));
    return raw !== null;
  } catch (error) {
    logger.warn('Failed to read the human-reply flag, the bot answers', {
      conversationId,
      adaptation: adaptation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

async function isHandedOff(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<boolean> {
  // Los traspasos permanentes viven en el archivo local (ver `handoff-store.ts`)
  // y no dependen de Redis: es lo que los hace sobrevivir a un reinicio suyo.
  if (adaptation.permanentHandoff) {
    return hasPermanentHandoff(adaptation.id, conversationId);
  }

  if (await hasSilence(adaptation.id, conversationId)) return true;

  // Los silencios anteriores al archivo viven sólo en Redis hasta que vencen.
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
  if (adaptation.permanentHandoff) {
    // Sin vencimiento y sin Redis. Si el disco falla, `savePermanentHandoff`
    // deja el error en el log y el silencio rige hasta el próximo reinicio.
    await savePermanentHandoff(adaptation.id, conversationId);
    return;
  }

  // El archivo es lo que sobrevive a un reinicio de Redis (ver `handoff-store.ts`).
  await saveSilence(adaptation.id, conversationId, {
    expiresAt: new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000),
  });
  try {
    if (!RedisConfig.isReady()) return;
    await RedisConfig.getClient().setEx(
      handoffKey(adaptation, conversationId),
      HANDOFF_TTL_SECONDS,
      '1'
    );
  } catch (error) {
    logger.warn('Failed to persist the shared-number handoff flag in Redis, the file keeps it', {
      conversationId,
      adaptation: adaptation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/** Le devuelve el chat al bot: levanta los dos silencios, el que haya. */
async function resumeBot(
  adaptation: SharedNumberAdaptation,
  conversationId: string
): Promise<void> {
  await removeSilence(adaptation.id, conversationId, 'human');
  await removeSilence(adaptation.id, conversationId, 'handoff');
  try {
    if (!RedisConfig.isReady()) return;
    const client = RedisConfig.getClient();
    await client.del(humanReplyKey(adaptation, conversationId));
    await client.del(handoffKey(adaptation, conversationId));
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
