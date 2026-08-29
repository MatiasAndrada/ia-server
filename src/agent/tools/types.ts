import { LlmToolDefinition } from '../../types/index.js';
import type { SupportedLanguage } from '../../i18n/index.js';

/**
 * Resultado uniforme de toda herramienta del agente v2.
 *
 * Se serializa a JSON y se devuelve al modelo como contenido de un mensaje
 * `tool`. El modelo lee `data` para redactar, y `error.hint` para saber qué
 * explicarle al cliente cuando una regla de negocio rechazó la operación.
 *
 * `verbatim` es el mecanismo del modo híbrido: cuando la herramienta produce
 * texto que el modelo NO debe parafrasear (un código de reserva, el motivo de
 * una fecha bloqueada, la confirmación de una cancelación), se devuelve acá el
 * string exacto. El orquestador lo envía tal cual al cliente y el system prompt
 * le prohíbe al modelo repetir esos datos con sus palabras. Así el LLM conversa
 * pero nunca puede alterar un dato operativo.
 */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    /** Código estable, apto para métricas (`date_blocked`, `out_of_window`...). */
    code: string;
    /** Qué explicarle al cliente. El modelo lo reformula en su idioma y su tono. */
    hint: string;
  };
  /** Texto que se envía TAL CUAL, sin pasar por el modelo. */
  verbatim?: string;
  /**
   * Imágenes a enviar en este turno. Mismo principio que `verbatim`: el modelo
   * no puede producir una imagen, así que la herramienta la adjunta y el
   * orquestador la entrega. Se usan para las fotos de un evento, que en v1
   * mandaba `applyEventChoice`.
   */
  attachments?: { imageUrl: string; caption?: string }[];
}

export function ok<T>(data: T, verbatim?: string): ToolResult<T> {
  return verbatim ? { ok: true, data, verbatim } : { ok: true, data };
}

export function fail(code: string, hint: string, verbatim?: string): ToolResult<never> {
  return verbatim ? { ok: false, error: { code, hint }, verbatim } : { ok: false, error: { code, hint } };
}

/**
 * Todo lo que una herramienta necesita saber del turno. Se arma una vez por
 * mensaje entrante y se pasa a cada ejecución — las herramientas no leen estado
 * global ni resuelven el idioma por su cuenta.
 */
export interface ToolContext {
  businessId: string;
  conversationId: string;
  /** Teléfono normalizado (sin sufijo de JID). */
  phone: string;
  /** JID de WhatsApp, para los envíos que dispara una herramienta (ej. imágenes de evento). */
  jid: string;
  language: SupportedLanguage;
}

/** Una herramienta: su schema para el modelo y su implementación. */
export interface AgentTool<A = any> {
  definition: LlmToolDefinition;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}
