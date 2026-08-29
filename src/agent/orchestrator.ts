import { openRouterService } from '../services/openrouter.service.js';
import { executeToolCall, getToolDefinitions, ToolContext } from './tools/index.js';
import { buildStateBlock, buildStaticPrompt } from './system-prompt.js';
import { clearHistory, loadCustomerProfile, loadHistory, saveHistory } from './state.js';
import { loadBusinessRules } from './tools/business-rules.js';
import { LlmMessage } from '../types/index.js';
import { evaluateReservationScope } from '../utils/reservation-scope.js';
import { logEvent, logger } from '../utils/logger.js';
import * as templates from '../utils/message-templates.js';
import type { SupportedLanguage } from '../i18n/index.js';

/**
 * Orquestador del agente v2.
 *
 * Un turno es: cargar quién escribe → armar el prompt → dejar que el modelo
 * decida qué herramientas usar → devolver lo que haya que enviar.
 *
 * No hay pasos, ni draft, ni gates compitiendo por consumir el mensaje. Lo
 * único que corre ANTES del modelo son los dos guards deterministas que no son
 * negociables (inyección de prompt y ventana de 7 días); todo lo demás es
 * decisión del modelo, acotada por lo que las herramientas le dejan hacer.
 */

export interface TurnResult {
  /** Mensajes a enviar, en orden. Los `verbatim` van primero. */
  messages: string[];
  /** Herramientas ejecutadas — el harness de tests asierta sobre esto. */
  toolsCalled: string[];
  iterations: number;
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
}

/**
 * Procesa un mensaje entrante. Debe invocarse dentro de `runWithLanguage`
 * para que los templates de los `verbatim` salgan en el idioma del turno.
 */
export async function handleTurn(input: TurnInput): Promise<TurnResult> {
  const { businessId, conversationId, phone, jid, messageText, language, businessName } = input;

  // --- Guards deterministas: nunca llegan al modelo ---
  const scope = evaluateReservationScope(messageText, { businessName });
  if (scope.decision === 'out_of_window' || scope.reason === 'prompt_injection') {
    logger.debug('Agent v2: blocked by deterministic scope guard', {
      conversationId,
      decision: scope.decision,
      reason: scope.reason,
    });
    return {
      messages: [scope.message ?? templates.genericError()],
      toolsCalled: [],
      iterations: 0,
    };
  }

  const [profile, rules, history] = await Promise.all([
    loadCustomerProfile(phone, businessId),
    loadBusinessRules(businessId),
    loadHistory(conversationId),
  ]);

  if (!rules) {
    logger.error('Agent v2: business not found', { businessId });
    return { messages: [templates.genericError()], toolsCalled: [], iterations: 0 };
  }

  // Estable primero, volátil después — ver la nota de caching en system-prompt.ts.
  const systemPrompt = `${buildStaticPrompt(businessName)}\n\n${buildStateBlock(
    rules.business,
    profile,
    rules.weeklyHours
  )}`;

  const messages: LlmMessage[] = [...history, { role: 'user', content: messageText }];

  const ctx: ToolContext = { businessId, conversationId, phone, jid, language };

  // Los `verbatim` se juntan acá durante la ejecución del loop: son texto ya
  // aprobado que se envía sin pasar por el modelo.
  const verbatimMessages: string[] = [];

  const result = await openRouterService.runToolLoop(
    messages,
    systemPrompt,
    getToolDefinitions(),
    async (call) => {
      const toolResult = await executeToolCall(call, ctx);
      if (toolResult.verbatim) {
        verbatimMessages.push(toolResult.verbatim);
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

  // El historial se persiste SIN los `verbatim`: ya están representados como
  // resultados de herramienta dentro de `result.messages`, y duplicarlos como
  // texto del assistant haría que el modelo los repita en el turno siguiente.
  const finalText = result.content?.trim() ?? '';
  const toPersist: LlmMessage[] = [...result.messages];
  if (finalText) {
    toPersist.push({ role: 'assistant', content: finalText });
  }
  await saveHistory(conversationId, toPersist);

  const outbound = [...verbatimMessages, finalText].filter((text) => text.length > 0);

  // Un turno sin nada que decir deja al cliente esperando. Sólo puede pasar si
  // el modelo devolvió vacío y ninguna herramienta produjo `verbatim`.
  if (outbound.length === 0) {
    logger.warn('Agent v2: empty turn, falling back to generic reply', {
      conversationId,
      iterations: result.iterations,
      exhausted: result.exhausted,
    });
    outbound.push(templates.genericError());
  }

  logEvent('info', 'turn.completed', {
    conversationId,
    businessId,
    via: 'agent_v2',
    iterations: result.iterations,
    tools: result.executedToolCalls.map((c) => c.name),
    exhausted: result.exhausted,
    model: result.model,
  });

  return {
    messages: outbound,
    toolsCalled: result.executedToolCalls.map((c) => c.name),
    iterations: result.iterations,
  };
}

/** Reinicia la conversación (usado al cerrar un flujo o desde tests). */
export async function resetConversation(conversationId: string): Promise<void> {
  await clearHistory(conversationId);
}
