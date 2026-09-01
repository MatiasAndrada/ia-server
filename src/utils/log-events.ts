/**
 * Catálogo cerrado de eventos de log.
 *
 * Regla del sistema de logs: **una línea `info` o superior siempre lleva un
 * `event` de esta unión**. Lo que no entra acá no es `info` — es traza, y va a
 * `logger.debug` con texto libre.
 *
 * El objetivo es que el log sea grepeable y agregable (`grep '"event":"msg.out'`)
 * y que el mismo hecho se escriba siempre igual, cosa que con strings libres
 * nunca se sostuvo: había 561 llamadas con ~50 emojis y frases distintas para
 * los mismos hechos.
 */
export type LogEvent =
  // ─── Infraestructura / ciclo de vida del proceso ───
  | 'server.starting'
  | 'server.ready'
  | 'server.shutdown'
  | 'server.fatal'
  | 'dep.ready'
  | 'dep.degraded'
  | 'dep.recovered'

  // ─── Sesiones de WhatsApp (una por comercio) ───
  | 'session.qr'
  | 'session.linked'
  | 'session.closed'
  | 'session.logout'
  | 'session.unrecoverable'
  | 'session.reconnecting'
  | 'session.recovered'
  | 'session.stopped'

  // ─── Mensajería ───
  | 'msg.in'
  | 'msg.out'
  | 'msg.out_failed'

  // ─── IA ───
  | 'ai.call'
  | 'ai.failed'
  | 'ai.degraded'
  | 'ai.fallback_model'
  // Una herramienta ejecutada dentro del loop de tool-calling del agente.
  | 'ai.tool_call'
  // El modelo agotó el tope de iteraciones sin cerrar el turno.
  | 'ai.tool_loop_exhausted'

  // ─── Dominio ───
  | 'reservation.draft_started'
  | 'reservation.created'
  | 'reservation.updated'
  | 'reservation.cancelled'
  | 'reservation.rejected'
  | 'turn.completed'
  | 'turn.silenced'

  // ─── Realtime / jobs ───
  | 'realtime.subscribed'
  | 'realtime.lost'
  | 'realtime.notified'
  | 'realtime.recovered'
  | 'job.reminder_sent'

  // ─── HTTP / seguridad ───
  | 'http.error'
  | 'auth.rejected'
  | 'ratelimit.exceeded';

/**
 * Texto humano de cada evento. Vive acá y no en el call site para que el mismo
 * evento se lea siempre igual en `pm2 logs`, sin importar desde qué archivo se
 * haya emitido.
 */
export const EVENT_LABELS: Record<LogEvent, string> = {
  'server.starting': 'Server starting',
  'server.ready': 'Server ready',
  'server.shutdown': 'Server shutting down',
  'server.fatal': 'Server fatal error',
  'dep.ready': 'Dependency ready',
  'dep.degraded': 'Dependency degraded',
  'dep.recovered': 'Dependency recovered',

  'session.qr': 'WhatsApp QR generated',
  'session.linked': 'WhatsApp session linked',
  'session.closed': 'WhatsApp session closed',
  'session.logout': 'WhatsApp session logged out',
  'session.unrecoverable': 'WhatsApp session rejected by server, cleared for re-linking',
  'session.reconnecting': 'WhatsApp session reconnecting',
  'session.recovered': 'WhatsApp session recovered',
  'session.stopped': 'WhatsApp session stopped',

  'msg.in': 'Message received',
  'msg.out': 'Message sent',
  'msg.out_failed': 'Message send failed',

  'ai.call': 'LLM call',
  'ai.failed': 'LLM call failed',
  'ai.degraded': 'LLM unavailable, degraded response',
  'ai.fallback_model': 'LLM served by fallback model',
  'ai.tool_call': 'Agent tool executed',
  'ai.tool_loop_exhausted': 'Agent tool loop hit its iteration cap',

  'reservation.draft_started': 'Reservation draft started',
  'reservation.created': 'Reservation created',
  'reservation.updated': 'Reservation updated',
  'reservation.cancelled': 'Reservation cancelled',
  'reservation.rejected': 'Reservation rejected',
  'turn.completed': 'Conversation turn completed',
  'turn.silenced': 'Turn closed without replying',

  'realtime.subscribed': 'Realtime channel subscribed',
  'realtime.lost': 'Realtime channel lost',
  'realtime.notified': 'Realtime notification sent',
  'realtime.recovered': 'Realtime missed notifications recovered',
  'job.reminder_sent': 'Reservation reminder sent',

  'http.error': 'HTTP request failed',
  'auth.rejected': 'Auth rejected',
  'ratelimit.exceeded': 'Rate limit exceeded',
};

/** Dependencias externas que pueden entrar en estado degradado. */
export type Dependency = 'redis' | 'supabase' | 'openrouter' | 'whatsapp';

/** Motivos por los que un envío saliente puede fallar. */
export type SendFailureReason =
  | 'no_session'
  | 'not_connected'
  /** El destinatario no tiene un solo dígito: no hay JID posible. */
  | 'invalid_recipient'
  | 'timeout'
  | 'send_error';

/** Qué parte del sistema originó una llamada al LLM. */
export type AiCallPurpose =
  | 'agent'
  | 'intent'
  | 'reservation_nlu'
  | 'reservation_planner'
  | 'blocked_date_reason'
  /** Una iteración del loop de tool-calling del agente (ver src/agent/orchestrator.ts). */
  | 'orchestrator';
