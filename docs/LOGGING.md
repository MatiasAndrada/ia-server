# Sistema de logs

## Dónde ver los logs

El proceso escribe **sólo a stdout/stderr**. PM2 los persiste y `pm2-logrotate` los rota.

```bash
pm2 logs ia-server              # todo          → logs/pm2-out.log
pm2 logs ia-server --err        # sólo errores  → logs/pm2-error.log
```

Cada línea es un JSON válido (no hay prefijo de PM2), así que se puede filtrar:

```bash
# El estado de todas las conversaciones
pm2 logs ia-server --raw | grep '"event":"turn.completed"'

# Todo lo que pasó en una conversación
pm2 logs ia-server --raw | jq 'select(.conversationId == "<businessId>-<phone>")'

# Envíos fallidos, agrupados por causa
pm2 logs ia-server --raw | jq -r 'select(.event=="msg.out_failed") | .reason' | sort | uniq -c

# Gasto de IA de la última hora
pm2 logs ia-server --raw | jq -s 'map(select(.event=="ai.call")) | {calls: length, tokens: (map(.totalTokens // 0) | add), p50ms: (map(.durationMs) | sort | .[length/2|floor])}'
```

Para reproducir un caso puntual con toda la traza:

```bash
LOG_LEVEL=debug pm2 restart ia-server
# ... reproducir ...
LOG_LEVEL=info pm2 restart ia-server
```

En desarrollo (`npm run dev`) sale por consola, coloreado y en **una línea por log**.

## Contrato de niveles

| Nivel | Qué va | Volumen |
|---|---|---|
| `error` | Requiere acción humana: bootstrap fallido, excepción no manejada, IA agotó reintentos, canal realtime muerto | raro |
| `warn` | Degradación recuperable: Redis caído, modelo fallback, envío fallido, reserva rechazada, auth/ratelimit rechazado | poco |
| `info` | **Sólo eventos del catálogo.** Un hecho de negocio o de infraestructura que ocurrió | ~1 línea por turno |
| `debug` | Traza: pasos del draft, cache hits, resolución de JID, eventos realtime descartados, request/response del LLM | apagado en prod |

**La regla dura:** si `logger.info` no lleva un `event` del catálogo, no es `info`.
Por eso `info`, `warn` y `error` "de negocio" se emiten con `logEvent(...)`, que sólo
acepta eventos de la unión `LogEvent`; el compilador rechaza cualquier nombre inventado.
La traza usa `logger.debug(...)` con texto libre.

```ts
import { logEvent, logger } from '../utils/logger.js';

logEvent('info', 'session.linked', { businessId });          // evento
logEvent('warn', 'msg.out_failed', { to, reason: 'timeout' }); // evento
logger.debug('Processing draft step', { step, messageText }); // traza
```

## Catálogo de eventos

Definido en [`src/utils/log-events.ts`](../src/utils/log-events.ts).

| Grupo | Eventos |
|---|---|
| Proceso | `server.starting` `server.ready` `server.shutdown` `server.fatal` |
| Dependencias | `dep.ready` `dep.degraded` `dep.recovered` (`redis` \| `supabase` \| `openrouter` \| `whatsapp`) |
| Sesiones WhatsApp | `session.qr` `session.linked` `session.closed` `session.logout` `session.reconnecting` `session.recovered` `session.stopped` |
| Mensajería | `msg.in` `msg.out` `msg.out_failed` |
| IA | `ai.call` `ai.failed` `ai.degraded` `ai.fallback_model` |
| Dominio | `reservation.draft_started` `reservation.created` `reservation.updated` `reservation.cancelled` `reservation.rejected` `turn.completed` |
| Realtime / jobs | `realtime.subscribed` `realtime.lost` `realtime.notified` `realtime.recovered` `job.postvisit_sent` |
| HTTP / seguridad | `http.error` `auth.rejected` `ratelimit.exceeded` |

### `turn.completed` — el índice del sistema

Se emite una vez por turno de conversación, al final:

```json
{"event":"turn.completed","conversationId":"biz-1-5493532401540","businessId":"biz-1",
 "phone":"5493532401540","durationMs":2841,"llmCalls":2,"llmMs":2109,"outbound":1,
 "language":"es","step":"party_size"}
```

Con `grep '"event":"turn.completed"'` se ve el estado de todas las conversaciones.
Recién si algo se ve mal ahí hace falta bajar a `LOG_LEVEL=debug`.

Campos: `durationMs` (turno completo), `llmCalls` / `llmMs` (cuánto de eso fue el LLM),
`outbound` (mensajes enviados al cliente), `step` (último paso del draft),
`blocked` (por qué el turno se cortó antes de llegar al agente, si aplica).

### `ai.call` — latencia y consumo

```json
{"event":"ai.call","purpose":"reservation_nlu","model":"...","durationMs":830,
 "promptTokens":1204,"completionTokens":47,"totalTokens":1251,"toolCalls":1}
```

`purpose` distingue quién llamó: `agent`, `intent`, `reservation_nlu`,
`reservation_planner`, `blocked_date_reason`, `health_check`.

## Correlación

No hay que pasar identificadores a mano. [`src/utils/log-context.ts`](../src/utils/log-context.ts)
usa `AsyncLocalStorage` (mismo patrón que `runWithLanguage` en `src/i18n/context.ts`) y el
logger mergea el contexto activo en cada línea.

Se abre en cuatro lugares, y sólo ahí:

| Punto | Campos |
|---|---|
| `src/index.ts` — middleware HTTP | `requestId` |
| `whatsapp-handler.service.ts` — `runTurn()` | `businessId` `phone` `conversationId` |
| `realtime-sync.service.ts` — handlers de evento | `businessId` `entryId` |
| `post-visit.service.ts` — envío M12 | `businessId` `entryId` |

```ts
await withLogContext({ businessId, entryId }, () => hacerAlgo());
```

## Datos sensibles

Decisión del proyecto: **los datos de negocio se loguean completos** — teléfono, nombre del
cliente y contenido de los mensajes. Sirven para reproducir un caso concreto y el servidor
es propio.

Lo que **nunca** sale al log:

1. **Credenciales.** Denylist de claves (`authorization`, `apiKey`, `token`, `password`,
   `secret`, `creds`, …) aplicada en cualquier nivel de anidamiento.
2. **Errores crudos.** Todo `error` / `err` / `reason` / `cause` se reduce a
   `{ name, message, code, status, httpStatus, responseData }` (+ `stack` sólo en `error`).
   Esto es lo que cierra la fuga real que existía: `logger.error('...', { error })` con un
   error de Axios serializaba `error.config.headers.Authorization`, o sea la
   `OPENROUTER_API_KEY` en texto plano.

Además se acota el tamaño: strings > 500 chars, arrays > 20 elementos y profundidad > 4.
Es lo que impide que vuelva a colarse un payload entero de Postgres por descuido.

Cubierto por [`src/__tests__/utils/logger.test.ts`](../src/__tests__/utils/logger.test.ts).

## Errores repetidos

Los bucles de reintento emitían miles de líneas idénticas (`Session not found` ×1754,
`Error subscribing to ...` ×1000 cada uno). [`src/utils/log-throttle.ts`](../src/utils/log-throttle.ts)
deja pasar la primera de cada clave y suprime el resto durante la ventana, informando
cuántas se suprimieron:

```ts
const t = throttle(`msg.out_failed:${businessId}`, 60_000);
if (t.allowed) logEvent('warn', 'msg.out_failed', { reason, suppressed: t.suppressed });
```

## Recetas de debug

**Un cliente dice que no le llegó la confirmación**

```bash
pm2 logs ia-server --raw | jq 'select(.phone == "5493532401540")'
```
Buscar `msg.out` (llegó) o `msg.out_failed` (no llegó, con `reason`). Si no hay ninguno,
buscar `turn.completed` con `blocked` para ver si el turno se cortó antes.

**Un comercio dice que el bot no responde**

```bash
pm2 logs ia-server --raw | jq 'select(.businessId == "<id>" and (.event | startswith("session.")))'
```
`session.reconnecting` repetido = la sesión no logra vincularse. `session.logout` = hay que
volver a escanear el QR.

**El bot está lento**

```bash
pm2 logs ia-server --raw | jq 'select(.event=="turn.completed" and .durationMs > 5000)'
```
Comparar `durationMs` contra `llmMs`: si son parecidos, es el LLM; si difieren mucho, es
Supabase o Redis.

## Variables de entorno

| Variable | Default | Efecto |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` habilita toda la traza |
| `NODE_ENV` | `development` | `production` → JSON de una línea; si no, formato legible coloreado |
| `WHATSAPP_QR_TERMINAL` | auto | Dibuja el QR en la terminal. Por defecto activo fuera de producción; en producción el QR se lee vía `GET /api/sessions/:businessId/qr` |
