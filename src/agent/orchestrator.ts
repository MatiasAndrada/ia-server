import { openRouterService } from '../services/openrouter.service.js';
import {
  executeToolCall,
  getToolDefinitions,
  HAND_OFF_TO_HUMAN,
  ToolContext,
  ToolResult,
} from './tools/index.js';
import type { ToolAttachment } from './tools/types.js';
import { buildStateBlock, buildStaticPrompt, NO_REPLY_SENTINEL } from './system-prompt.js';
import {
  bumpUnproductiveStreak,
  clearHistory,
  clearUnproductiveStreak,
  loadCustomerProfile,
  loadHistory,
  saveHistory,
} from './state.js';
import { loadBusinessRules } from './tools/business-rules.js';
import { SupabaseService } from '../services/supabase.service.js';
import { LlmMessage } from '../types/index.js';
import { evaluateReservationScope } from '../utils/reservation-scope.js';
import { logEvent, logger } from '../utils/logger.js';
import * as templates from '../utils/message-templates.js';
import type { SupportedLanguage } from '../i18n/index.js';

/**
 * Orquestador del agente.
 *
 * Un turno es: cargar quién escribe → armar el prompt → dejar que el modelo
 * decida qué herramientas usar → devolver lo que haya que enviar.
 *
 * No hay pasos, ni draft, ni gates compitiendo por consumir el mensaje. Lo
 * único que corre ANTES del modelo es el guard determinista que no es
 * negociable (inyección de prompt); todo lo demás es decisión del modelo,
 * acotada por lo que las herramientas le dejan hacer.
 */

export interface TurnResult {
  /** Mensajes a enviar, en orden. Los `verbatim` van primero. */
  messages: string[];
  /** Archivos a enviar antes de los mensajes (fotos de un evento, la carta). */
  attachments: ToolAttachment[];
  /** Herramientas ejecutadas — el harness de tests asierta sobre esto. */
  toolsCalled: string[];
  iterations: number;
  /**
   * El modelo dejó el chat en manos de la persona del local
   * (`hand_off_to_human`): `messages` y `attachments` vienen vacíos a
   * propósito y no hay que mandar nada.
   */
  handedOff?: boolean;
}

const GENERATION_OPTIONS = {
  // Temperatura media-baja: alcanza para que el fraseo varíe y no suene a
  // plantilla, sin que el modelo se ponga creativo con los datos operativos.
  temperature: 0.6,
  maxTokens: 800,
  // Gemini descuenta el "thinking" del mismo presupuesto que la salida visible;
  // sin este techo un turno con varias herramientas puede quedar truncado.
  reasoningMaxTokens: 300,
};

export interface TurnInput {
  businessId: string;
  conversationId: string;
  phone: string;
  jid: string;
  messageText: string;
  language: SupportedLanguage;
  businessName: string;
  /**
   * Modo dry-run: el turno se computa entero pero ninguna herramienta escribe
   * y la respuesta no se envía. Usa su propio historial (ver state.historyKey).
   */
  dryRun?: boolean;
  /**
   * Sólo para comercios de número compartido (ver `humanContext` en
   * `adaptations/shared-number.ts`): quién más atiende el número. Con esto el
   * modelo puede derivar con `hand_off_to_human` lo que no es para el bot.
   */
  humanContext?: string;
  /** Cómo contestar al cliente con una consulta ajena a las reservas (ver `inquiryGuidance`). */
  inquiryGuidance?: string;
}

/**
 * Procesa un mensaje entrante. Debe invocarse dentro de `runWithLanguage`
 * para que los templates de los `verbatim` salgan en el idioma del turno.
 */
export async function handleTurn(input: TurnInput): Promise<TurnResult> {
  const { businessId, conversationId, phone, jid, messageText, language, businessName } = input;
  const dryRun = input.dryRun ?? false;
  const humanContext = input.humanContext;

  // --- Guard determinista: nunca llega al modelo ---
  const scope = evaluateReservationScope(messageText, { businessName });
  if (scope.reason === 'prompt_injection') {
    logger.debug('Agent: blocked by deterministic scope guard', {
      conversationId,
      decision: scope.decision,
      reason: scope.reason,
    });
    return {
      messages: [scope.message ?? templates.genericError()],
      attachments: [],
      toolsCalled: [],
      iterations: 0,
    };
  }

  const [profile, rules, history, activeEvents] = await Promise.all([
    loadCustomerProfile(phone, businessId),
    loadBusinessRules(businessId),
    loadHistory(conversationId, dryRun),
    SupabaseService.getActiveEvents(businessId),
  ]);

  if (!rules) {
    logger.error('Agent: business not found', { businessId });
    return { messages: [templates.genericError()], attachments: [], toolsCalled: [], iterations: 0 };
  }

  // Estable primero, volátil después — ver la nota de caching en system-prompt.ts.
  const systemPrompt = `${buildStaticPrompt(businessName, humanContext, input.inquiryGuidance)}\n\n${buildStateBlock(
    rules.business,
    profile,
    rules.weeklyHours,
    activeEvents
  )}`;

  const messages: LlmMessage[] = [...history, { role: 'user', content: messageText }];

  const ctx: ToolContext = { businessId, conversationId, phone, jid, language, dryRun };

  // Los `verbatim` se juntan acá durante la ejecución del loop: son texto ya
  // aprobado que se envía sin pasar por el modelo.
  const verbatimMessages: string[] = [];
  const attachments: TurnResult['attachments'] = [];

  const result = await openRouterService.runToolLoop(
    messages,
    systemPrompt,
    getToolDefinitions({ humanHandoff: Boolean(humanContext) }),
    async (call) => {
      const toolResult = await executeToolCall(call, ctx);
      if (toolResult.verbatim) {
        verbatimMessages.push(toolResult.verbatim);
      }
      if (toolResult.attachments?.length) {
        attachments.push(...toolResult.attachments);
      }
      return toolResult;
    },
    {
      ...GENERATION_OPTIONS,
      // Sticky routing por conversación: mantiene el mismo proveedor entre
      // iteraciones y turnos para que el prefijo cacheado acierte.
      sessionId: conversationId,
    },
    'orchestrator'
  );

  // El modelo puede cerrar el turno sin nada que decir (ver "Cuándo no
  // contestar" en el system prompt). Ese silencio tiene que ser distinguible de
  // un turno vacío por falla: uno se manda callado y el otro cae en el fallback
  // genérico, y desde afuera los dos se ven igual — texto vacío.
  const rawText = result.content?.trim() ?? '';
  const silenced = rawText.includes(NO_REPLY_SENTINEL);

  // El historial se persiste SIN los `verbatim`: ya están representados como
  // resultados de herramienta dentro de `result.messages`, y duplicarlos como
  // texto del assistant haría que el modelo los repita en el turno siguiente.
  const finalText = silenced ? rawText.split(NO_REPLY_SENTINEL).join('').trim() : rawText;

  // El modelo dejó el chat en manos de la persona del local: de este turno no
  // se manda NADA — ni su texto, ni un `verbatim`, ni el fallback de turno
  // vacío. Quien escribió no le estaba hablando al bot, y hasta un "te paso
  // con Simona" es el bot apareciendo donde nadie lo llamó. Por lo mismo, ese
  // texto tampoco va al historial: nunca se dijo.
  const handedOff = result.executedToolCalls.some(
    (c) => c.name === HAND_OFF_TO_HUMAN && (c.output as ToolResult | undefined)?.ok === true
  );

  const toPersist: LlmMessage[] = [...result.messages];
  if (finalText && !handedOff) {
    toPersist.push({ role: 'assistant', content: finalText });
  }
  await saveHistory(conversationId, toPersist, dryRun);

  if (handedOff) {
    logEvent('info', 'turn.silenced', {
      conversationId,
      businessId,
      via: dryRun ? 'agent_handoff_dry_run' : 'agent_handoff',
      droppedText: finalText.length > 0 || verbatimMessages.length > 0,
    });
    return {
      messages: [],
      attachments: [],
      toolsCalled: result.executedToolCalls.map((c) => c.name),
      iterations: result.iterations,
      handedOff: true,
    };
  }

  // Un turno es improductivo si el modelo agotó las iteraciones sin cerrar, o
  // si todas las herramientas que pidió fallaron. Dos seguidos y se corta: sin
  // esto el cliente puede quedar en un loop sin salida.
  const allToolsFailed =
    result.executedToolCalls.length > 0 &&
    result.executedToolCalls.every((c) => (c.output as ToolResult | undefined)?.ok === false);

  // Un turno sin IA (sin saldo, proveedor caído) no dice nada de la
  // conversación: ni corta la racha ni la suma. Cortarla sería contarlo como
  // un turno logrado; sumarla terminaría mandándole a un cliente que no hizo
  // nada mal el mensaje de "no nos estamos entendiendo".
  if (!dryRun && !result.degraded) {
    if (result.exhausted || allToolsFailed) {
      const streak = await bumpUnproductiveStreak(conversationId);
      if (streak >= 2) {
        logger.warn('Agent: unproductive streak reached, handing off', {
          conversationId,
          businessId,
          streak,
        });
        await clearHistory(conversationId);
        await clearUnproductiveStreak(conversationId);
        return {
          messages: [templates.tooManyInvalidAttempts()],
          attachments: [],
          toolsCalled: result.executedToolCalls.map((c) => c.name),
          iterations: result.iterations,
        };
      }
    } else {
      await clearUnproductiveStreak(conversationId);
    }
  }

  const outbound = [...verbatimMessages, finalText].filter((text) => text.length > 0);

  if (silenced) {
    logEvent('info', 'turn.silenced', {
      conversationId,
      businessId,
      via: dryRun ? 'agent_dry_run' : 'agent',
      // El centinela debería venir solo; si vino con texto, ese texto igual se envía.
      withText: outbound.length > 0,
    });
  }

  // Un turno sin nada que decir deja al cliente esperando. Sólo puede pasar si
  // el modelo devolvió vacío y ninguna herramienta produjo `verbatim` — y no
  // si el silencio fue deliberado.
  //
  // Si fue porque la IA no respondió, el texto es otro: "¿me lo repetís?"
  // invita a reintentar enseguida, y con la IA caída eso no cambia nada. Si
  // antes de caerse alcanzó a ejecutar algo con `verbatim` (una reserva
  // creada), se manda sólo eso: sumarle "problemas técnicos" haría pensar que
  // la reserva no se hizo y que hay que pedirla de nuevo.
  if (!silenced && outbound.length === 0 && attachments.length === 0) {
    logger.warn('Agent: empty turn, falling back to a fixed reply', {
      conversationId,
      iterations: result.iterations,
      exhausted: result.exhausted,
      degraded: result.degraded === true,
    });
    outbound.push(result.degraded ? templates.aiUnavailable(businessName) : templates.genericError());
  }

  logEvent('info', 'turn.completed', {
    conversationId,
    businessId,
    via: dryRun ? 'agent_dry_run' : 'agent',
    iterations: result.iterations,
    tools: result.executedToolCalls.map((c) => c.name),
    exhausted: result.exhausted,
    model: result.model,
    ...(result.degraded && { degraded: true }),
  });

  return {
    messages: outbound,
    attachments,
    toolsCalled: result.executedToolCalls.map((c) => c.name),
    iterations: result.iterations,
  };
}

/** Reinicia la conversación (usado al cerrar un flujo o desde tests). */
export async function resetConversation(conversationId: string): Promise<void> {
  await clearHistory(conversationId);
}
