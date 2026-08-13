# Migración: Baileys → WhatsApp Cloud API (Meta)

**Objetivo:** migrar el bot de reservas de Baileys (librería no oficial, WhatsApp Web reverso) a la **WhatsApp Business Cloud API oficial de Meta**, con el modelo:

- Cada comercio tiene **su propia WABA** (WhatsApp Business Account) y su propio número.
- El comercio se vincula mediante **Embedded Signup** (popup de Meta en nuestro frontend).
- Nuestro backend actúa como **Tech Provider**: una sola app de Meta, un solo webhook, N tenants.

Este documento es el plan de migración. No implementa nada; referencia el código actual con rutas y líneas reales.

---

## 1. Arquitectura actual vs. propuesta

### 1.1 Actual (Baileys)

```
Comercio A ── QR ──► socket Baileys A ─┐
Comercio B ── QR ──► socket Baileys B ─┼─► BaileysService (singleton) ──► WhatsAppHandler ──► Supabase/Redis/LLM
Comercio C ── QR ──► socket Baileys C ─┘
```

- **Un socket WebSocket por comercio**, creado con `makeWASocket` en [`src/services/baileys.service.ts:386`](src/services/baileys.service.ts). Toda la superficie de Baileys vive en ese único archivo (ningún otro archivo de `src/` importa `baileys`).
- **Credenciales en disco**: `useMultiFileAuthState` sobre `auth_sessions/<businessId>/` (`baileys.service.ts:365`), con recuperación de sesiones al boot (`recoverSessions`, `baileys.service.ts:950`, invocado desde `src/index.ts:295`).
- **Pairing por QR**: expuesto por polling HTTP en `GET /api/sessions/:businessId/qr` ([`src/controllers/session.controller.ts:160`](src/controllers/session.controller.ts)).
- **Reconexión**: backoff exponencial con jitter (`baileys.service.ts:521-611`), keep-alive de 15 s, manejo de `DisconnectReason`, borrado de sesión en `loggedOut`.
- **Resolución de tenant implícita por socket**: el handler de `messages.upsert` hace closure sobre `businessId` (`baileys.service.ts:439`). El tenant nunca se deduce del número receptor.
- **Envío**: un único call site, `sock.sendMessage(jid, { text })` (`baileys.service.ts:898`). **Solo texto plano** — no se usan botones, listas ni media.
- **Identidad del cliente**: JIDs de Baileys (`@s.whatsapp.net` / `@lid`), con normalización a teléfono repartida por la lógica de negocio (ver §2).

### 1.2 Propuesta (Cloud API multi-WABA)

```
                        ┌────────────────────────── Meta ──────────────────────────┐
Cliente de Comercio A ──► WABA A (phone_number_id: 111) ─┐
Cliente de Comercio B ──► WABA B (phone_number_id: 222) ─┼─► webhook único (push HTTPS)
Cliente de Comercio C ──► WABA C (phone_number_id: 333) ─┘        │
                                                                  ▼
                              POST /api/whatsapp/webhook  ── ruteo por metadata.phone_number_id
                                                                  │
                                          whatsapp_channels (phone_number_id → business_id, token)
                                                                  │
                                                                  ▼
                                             WhatsAppHandler (sin cambios de lógica)
                                                                  │
                        salida: POST graph.facebook.com/{version}/{phone_number_id}/messages
                                (token de la WABA del comercio)
```

Piezas nuevas:

| Pieza | Descripción |
|---|---|
| **Webhook único** | `GET /api/whatsapp/webhook` (handshake `hub.verify_token`) + `POST /api/whatsapp/webhook`. Validar firma `X-Hub-Signature-256` con el app secret, **responder 200 inmediatamente** y procesar async (Meta reintenta ante timeouts y penaliza webhooks lentos). |
| **Ruteo por tenant** | `entry[].changes[].value.metadata.phone_number_id` → lookup en `whatsapp_channels` (cacheado en Redis) → `businessId`. Reemplaza el "un socket = un tenant" actual. |
| **Envío saliente** | `POST /{phone_number_id}/messages` con el access token del comercio. Reemplaza `sock.sendMessage`. |
| **Onboarding** | Embedded Signup: el popup de Meta en el frontend devuelve un `code` + `waba_id` + `phone_number_id`; el backend lo intercambia por un token de system user de integración, suscribe la app a la WABA (`POST /{waba_id}/subscribed_apps`) y registra el número (`POST /{phone_number_id}/register`). Reemplaza el flujo QR completo. |

Qué desaparece: sockets, `auth_sessions/`, QR, reconexión/backoff, keep-alive, LID vs `@s.whatsapp.net`, echo-guard de mensajes propios, `whatsapp-client.js`.

Qué no cambia: `WhatsAppHandler` (máquina de estados de reservas, 5125 líneas), agentes LLM, Supabase, Redis (drafts, dedup), realtime-sync, post-visit. La clave de estado conversacional ya es `businessId-phone` ([`whatsapp-handler.service.ts:211`](src/services/whatsapp-handler.service.ts)), transport-agnóstica.

---

## 2. Capa de abstracción de transporte

### 2.1 Situación actual: no existe

`BaileysService` *es* la abstracción, y filtra detalles del transporte hacia la lógica de negocio:

- **El JID crudo se enhebra por toda la máquina de estados**: `whatsapp-handler.service.ts` recibe `jid` como parámetro en ~50 firmas de método (~150 call sites) y lo re-normaliza con su propio parser `normalizeWhatsAppNumber` ([`whatsapp-handler.service.ts:3466`](src/services/whatsapp-handler.service.ts)), duplicado de `extractPhoneFromJid` (`baileys.service.ts:123`).
- **Tres emisores en background re-implementan la resolución de JID** leyendo Redis `jid:<businessId>:<phone>` a mano: [`realtime-sync.service.ts:304-312` y `:707-734`](src/services/realtime-sync.service.ts), [`post-visit.service.ts:174-180`](src/services/post-visit.service.ts). La distinción `@lid` vs `@s.whatsapp.net` está persistida en Redis con TTL de 30 días.
- Los tipos canónicos internos se llaman `BaileysMessage` / `BaileysSession` ([`src/types/index.ts:287-302`](src/types/index.ts)).
- Fuga de control inversa: `realtime-sync.service.ts:487` llama `baileys.stopSession()` (logout destructivo) cuando faltan `weekly_hours`.

### 2.2 Interfaz propuesta: `WhatsAppTransport`

Un puerto único con dos adapters (`BaileysAdapter`, `CloudApiAdapter`), seleccionado por comercio (feature flag, §3):

```ts
interface WhatsAppTransport {
  // E.164 sin '+' como identidad canónica (ej. "5493511234567")
  sendText(businessId: string, to: string, text: string): Promise<SendResult>;
  sendInteractive(businessId: string, to: string, msg: InteractiveMessage): Promise<SendResult>; // botones (≤3) o lista
  sendTemplate(businessId: string, to: string, name: string, params: TemplateParams): Promise<SendResult>;
  getStatus(businessId: string): Promise<ChannelStatus>;
}

interface InboundMessage {
  businessId: string;
  from: string;            // E.164, ya normalizado por el adapter
  text: string;
  messageId: string;
  timestamp: number;
  type: 'text' | 'interactive_reply' | 'unsupported';
  interactiveReplyId?: string; // id del botón/fila elegida (Cloud API)
}
```

Reglas de degradación (permiten la corrida en paralelo de §5):

- `sendInteractive` en **BaileysAdapter** degrada al menú numerado en texto actual (que es exactamente lo que hoy generan `templates.askScheduleChoice()`, `editMenu()`, etc.).
- `sendTemplate` en **BaileysAdapter** renderiza el texto local equivalente de [`src/utils/message-templates.ts`](src/utils/message-templates.ts).
- En **CloudApiAdapter**, `sendText` fuera de la ventana de 24 h falla con un error tipado → el caller decide caer a `sendTemplate` ("smart send", §4).

### 2.3 Refactor previo (sin cambio de comportamiento, todo sigue sobre Baileys)

1. **Teléfono E.164 como identidad canónica.** Renombre mecánico de `jid` → `phone` en `whatsapp-handler.service.ts`; la conversión JID↔phone y el manejo de LID quedan encapsulados dentro de `BaileysAdapter`. El cache Redis `jid:*` pasa a ser un detalle interno del adapter.
2. **Un solo punto de resolución de destinatario.** Eliminar los lookups manuales de `jid:*` en `realtime-sync.service.ts` y `post-visit.service.ts`; esos servicios pasan `businessId + phone` y el adapter resuelve.
3. **Rutear los 4 emisores por la interfaz**: `WhatsAppHandler.sendWhatsAppMessage` (`whatsapp-handler.service.ts:3351`), los dos envíos de `realtime-sync.service.ts` (`:315`, `:746`), `post-visit.service.ts:184` y el endpoint manual `POST /api/messages/:businessId/send` ([`messages.controller.ts:107`](src/controllers/messages.controller.ts)).
4. **Consolidar strings salientes.** Hay ~40 textos inline fuera de `message-templates.ts` (los proactivos de `realtime-sync.service.ts:285-301,683-696`, los "Demasiados intentos inválidos" duplicados, los mensajes de scope-guard en [`src/utils/reservation-scope.ts:30-44`](src/utils/reservation-scope.ts), etc.). Moverlos a `message-templates.ts` es prerequisito para el mapeo texto-local ↔ template-Meta de §4.
5. Renombrar los tipos `BaileysMessage`/`BaileysSession` → `InboundMessage`/`ChannelState` en `src/types/index.ts`.

Este refactor es la **Fase 0** del plan (§5) y se puede mergear y desplegar de forma independiente, validado con la suite de tests existente.

---

## 3. Modelo de datos

### 3.1 Vínculo actual tenant ↔ WhatsApp

- `businesses.whatsapp_session_id` — seteado al propio `businessId` al conectar (`baileys.service.ts:643`); `!== null` se usa como flag "WhatsApp activo" (`supabase.service.ts:970`, `whatsapp-handler.service.ts:245`).
- `businesses.whatsapp_phone_number` — derivado de `sock.user.id`.
- En disco: `auth_sessions/<businessId>/{creds.json, business.meta.json}`.

### 3.2 Propuesta: tabla `whatsapp_channels`

```sql
create table whatsapp_channels (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id),
  provider              text not null check (provider in ('baileys', 'cloud_api')),
  -- Cloud API:
  waba_id               text,
  phone_number_id       text unique,          -- clave de ruteo del webhook
  display_phone_number  text,                 -- E.164 visible
  access_token          text,                 -- CIFRADO (Supabase Vault / pgcrypto), nunca en claro
  token_updated_at      timestamptz,
  status                text not null default 'disconnected', -- connected | disconnected | pending | error
  quality_rating        text,                 -- GREEN/YELLOW/RED (webhook phone_number_quality_update)
  messaging_limit_tier  text,                 -- TIER_250 / TIER_1K / ...
  connected_at          timestamptz,
  created_at            timestamptz not null default now(),
  unique (business_id, provider)
);
```

- **Ruteo del webhook**: índice único por `phone_number_id` + cache Redis `channel:<phone_number_id> → {businessId, token}` (mismo patrón que el cache de businesses de `reservation.service.ts:991`).
- **Feature flag por comercio** = `provider` del canal activo. El gateway de §2 elige el adapter según este valor.
- **Tokens**: Embedded Signup devuelve un `code` que se intercambia server-side por un **token de system user de integración** de larga duración, scopeado a la WABA del comercio. Guardarlo cifrado; jamás exponerlo al frontend. El app secret y el verify token del webhook van a env.
- **Deprecación**: `whatsapp_session_id` / `whatsapp_phone_number` quedan congelados durante la transición y se eliminan en Fase 4. El flag "activo" pasa a ser `whatsapp_channels.status = 'connected'`. Nota: hoy la desconexión ni siquiera nulifica la columna (el update solo escribe valores truthy, `supabase.service.ts:1017-1023`) — la tabla nueva arregla esa semántica de paso.
- Regenerar tipos con `npm run supabase:gen` ([`docs/TYPES_GENERATION.md`](docs/TYPES_GENERATION.md)).

### 3.3 Endpoints nuevos / reemplazados

| Actual (Baileys) | Nuevo (Cloud API) |
|---|---|
| `POST /api/sessions/:businessId/start` + polling QR | `POST /api/whatsapp/onboard` — recibe `{ code, waba_id, phone_number_id }` del popup de Embedded Signup; hace token exchange, `subscribed_apps`, `register`, aprovisiona templates (§4) y crea la fila en `whatsapp_channels` |
| `GET /api/sessions/:businessId/qr` | — (desaparece) |
| `GET /api/sessions/:businessId/status` | `GET /api/whatsapp/:businessId/status` (lee `whatsapp_channels` + health del número vía Graph) |
| `POST /api/sessions/:businessId/stop` (logout destructivo) | `DELETE /api/whatsapp/:businessId/channel` (desuscribe app; no destruye nada del lado del comercio) |
| — | `GET/POST /api/whatsapp/webhook` (verificación + recepción) |

**Env nuevos**: `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION` (ej. `v21.0`), `META_EMBEDDED_SIGNUP_CONFIG_ID`.

---

## 4. Templates de mensaje a dar de alta en Meta

**Regla de la Cloud API**: dentro de la **ventana de servicio de 24 h** (desde el último mensaje entrante del cliente) se puede enviar texto libre y mensajes interactivos sin aprobación. Fuera de la ventana, solo **templates aprobados**. Todo el flujo conversacional del bot (la máquina de estados de reservas) es respuesta a mensajes del cliente → sigue siendo texto libre, sin templates.

Los que sí necesitan template son los **mensajes proactivos** (iniciados por el negocio), que hoy son estos:

| Template | Categoría | Variables | Origen en el código actual |
|---|---|---|---|
| `reserva_confirmada` | `UTILITY` | nombre, fecha/hora, personas, código | `realtime-sync.service.ts:286,691` + `templates.reservationConfirmed` (`message-templates.ts:155`) |
| `reserva_registrada` | `UTILITY` | nombre, fecha/hora, personas, código | `realtime-sync.service.ts:296` + `templates.reservationReceived` (`message-templates.ts:175`) |
| `reserva_cancelada` | `UTILITY` | nombre, fecha/hora, código | cancelación desde dashboard (hoy `templates.reservationCancelled`, `message-templates.ts:323`) |
| `mesa_lista` | `UTILITY` | nombre, minutos de tolerancia | "🚀 ¡Es tu momento!… próximos 20 minutos" (`realtime-sync.service.ts:684`, status → `NOTIFIED`) |
| `recordatorio_reserva` | `UTILITY` | nombre, fecha/hora, personas, código | **Nuevo.** Hoy no existe ningún cron de recordatorios: la promesa "te avisaremos" solo se cumple si un humano cambia el estado en el dashboard. La migración es la oportunidad de cerrar ese gap con un scheduler estilo `PostVisitService` (`post-visit.service.ts:69`, sorted set en Redis). |
| `bienvenida_mesa` | `UTILITY` | — | `welcomeAtRestaurant` (`message-templates.ts:450`), status → `SEATED`. Suele caer dentro de ventana (el cliente acaba de escribir) → enviar free-form si la ventana está abierta, template si no. |
| `post_visita` | `MARKETING` | nombre del negocio | `postVisitMessage` (`message-templates.ts:462`). Pide reseña ⭐ → Meta lo clasifica marketing, no utility. Con delay default de 120 min (`POST_VISIT_DELAY_MINUTES`) suele estar dentro de ventana, pero no siempre. |

Decisiones de implementación:

- **Idioma**: `es_AR`. Mantener los textos actuales de `message-templates.ts` como base del cuerpo del template (ya están redactados en voseo).
- **Alta automatizada por WABA**: como cada comercio tiene su propia WABA, los templates se crean vía API en el onboarding (`POST /{waba_id}/message_templates`) — paso del endpoint `/onboard` (§3.3). La aprobación de `UTILITY` suele ser en minutos; manejar los estados `PENDING/APPROVED/REJECTED` vía webhook `message_template_status_update`.
- **"Smart send"**: un helper del gateway decide free-form vs template según la ventana (trackear timestamp del último mensaje entrante por `businessId-phone` en Redis — el dato ya pasa por `handleIncomingMessages`). Costo: template `UTILITY` **dentro** de ventana es gratis; fuera de ventana se cobra por mensaje.
- **Menús interactivos** (mejora, no requisito): los menús numerados actuales mapean a mensajes interactivos nativos — `askScheduleChoice` (2 opciones) y `cancelConfirmPrompt` → **botones** (≤3); `editMenu` (4 opciones) y `activeReservationsMenu` (N reservas) → **listas**. El parseo actual por regex (`extractNumber`, `whatsapp-handler.service.ts:4565`) se mantiene como fallback para respuestas en texto libre.

---

## 5. Plan de migración por fases

Diseñado para que **Baileys y Cloud API convivan** durante toda la transición, con switch por comercio.

### Fase 0 — Refactor de abstracción (sin Cloud API todavía)
- Implementar §2.3: interfaz `WhatsAppTransport`, `BaileysAdapter` envolviendo el código actual, E.164 canónico, consolidación de strings.
- **Riesgo bajo, deploy independiente.** Criterio de salida: suite de tests verde, comportamiento idéntico en producción.

### Fase 1 — Sandbox Cloud API
- Crear la app de Meta (tipo Business), configurar el producto WhatsApp con el **número de prueba gratuito** (§6).
- Implementar el webhook (verificación + firma + ruteo por `phone_number_id`) y el `CloudApiAdapter` (texto, interactivos, templates).
- En dev el webhook necesita HTTPS público: ngrok / cloudflared (el server ya soporta HTTPS nativo vía `USE_HTTPS`, útil recién en staging/prod).
- Probar el flujo completo de reservas contra un comercio de staging con `provider = 'cloud_api'`.

### Fase 2 — Onboarding productivo (Tech Provider)
- Migración SQL: tabla `whatsapp_channels` (§3.2) + regeneración de tipos.
- Embedded Signup end-to-end: componente FE con el SDK de Facebook Login for Business, endpoint `/onboard`, token exchange, `subscribed_apps`, `register`, aprovisionamiento de templates (§4).
- Requisitos de Meta a destrabar en esta fase (tienen lead time, empezarlos temprano): **business verification** de nuestra empresa, **acceso avanzado** a los permisos `whatsapp_business_management` y `whatsapp_business_messaging`, revisión de la app.
- Webhooks de cuenta: suscribirse también a `account_update`, `phone_number_quality_update`, `message_template_status_update` y persistirlos en `whatsapp_channels`.

### Fase 3 — Corrida en paralelo (piloto)
- **1 comercio piloto real** en `cloud_api`; el resto sigue en `baileys`. El gateway rutea por `whatsapp_channels.provider`, mensaje a mensaje.
- Los drafts de conversación en Redis (`reservation_draft:<businessId>-<phone>`) sobreviven el switch de transporte sin migración.
- Monitorear: tasa de entrega (webhook `statuses`), quality rating, costo por comercio, latencia del webhook.
- Rollback trivial: volver el flag a `baileys` (la sesión QR del piloto se mantiene viva durante esta fase — no hacer `stopSession`, que es logout destructivo).
- Ir migrando comercios por tandas a medida que completan Embedded Signup.

### Fase 4 — Decomiso de Baileys
- Con todos los comercios migrados: eliminar `BaileysAdapter`, dependencia `baileys` y `qrcode-terminal`, `auth_sessions/`, rutas/controller de sesiones QR, lógica de reconexión, echo-guard, `whatsapp-client.js`, script `whatsapp:clean`, y las columnas `whatsapp_session_id`/`whatsapp_phone_number`.
- Simplificaciones colaterales: el "logout forzado" cuando faltan `weekly_hours` (`realtime-sync.service.ts:487`) pasa a ser un toggle lógico en el canal, sin destruir nada; desaparece el workaround LID y el cache `jid:*`.

---

## 6. Qué se puede probar ya mismo con el número de prueba de Meta

El número de prueba (gratuito, sin business verification, disponible al crear la app) permite validar casi todo el trabajo técnico **antes** de tener la primera WABA real:

**Sí se puede probar hoy:**
- Webhook completo: handshake de verificación, validación de firma, ruteo por `phone_number_id`, procesamiento async.
- Recepción y envío de mensajes de texto con hasta **5 números destinatarios verificados** (los celulares del equipo).
- **Botones y listas interactivas** (y el parseo de sus respuestas) — lo más nuevo respecto a Baileys.
- Creación y envío de **templates propios** vía API (además del `hello_world` precargado) → validar los 7 templates de §4 y el flujo de aprobación.
- El flujo completo de reservas end-to-end contra staging (Fase 1 entera).
- Webhook de `statuses` (sent/delivered/read) y manejo de errores de envío.

**No se puede probar con el número de prueba:**
- Embedded Signup end-to-end (requiere app publicada, business verification y acceso avanzado a los permisos).
- Límites de mensajería reales, quality rating, facturación.
- Display name y su aprobación.

Conclusión práctica: **las Fases 0 y 1 completas no dependen de Meta más que de crear la app gratuita**. La burocracia (verification, app review) solo bloquea la Fase 2.

---

## 7. Riesgos y trade-offs vs. Baileys

### Se gana
- **Legitimidad y cero riesgo de ban**: Baileys viola los ToS de WhatsApp; un ban del número del comercio es pérdida total e irrecuperable del canal. Este es el motivo #1 de la migración.
- **Cero operación de sesiones**: desaparecen QR, re-scans, reconexiones (todo el backoff con jitter de `baileys.service.ts:521-611`), keep-alive tuning, sesiones corruptas en disco, y la fragilidad ante actualizaciones del protocolo de WhatsApp Web (el repo ya sufrió esto: bump a `7.0.0-rc14`, workarounds de LID, `creds.registered` roto).
- **Botones y listas nativos**: menos errores de parseo que los menús numerados por regex.
- **Estados de entrega** (sent/delivered/read/failed) vía webhook — hoy no existe ninguna confirmación de entrega.
- **Escalabilidad y HA**: webhooks stateless vs. N sockets vivos en un solo proceso PM2. Hoy el proceso es un SPOF con estado en disco local; con Cloud API se puede escalar horizontal detrás de un load balancer.
- Camino a **business verification / cuenta oficial (OBA)** por comercio.

### Se pierde
- **Mensajería gratuita ilimitada.** Con el pricing por mensaje de Meta (vigente desde jul-2025): las conversaciones de servicio (responder al cliente) son **gratis**, y los templates `UTILITY` **dentro** de la ventana de 24 h son gratis; se paga por template fuera de ventana (`UTILITY`) y por `MARKETING` (tarifas por país — consultar el rate card vigente de Meta para Argentina). Para este bot, mayormente reactivo, el costo esperado es bajo: los pagos serían recordatorios/confirmaciones tardías y el mensaje post-visita.
- **En el flujo estándar, el comercio pierde el uso de la app de WhatsApp en ese número.** Con Baileys el número sigue funcionando en el teléfono del comercio (el bot es un "dispositivo vinculado"); con Cloud API estándar el número queda **API-only**. **Esto es evitable** — ver §7.1.
- **`onWhatsApp()`**: hoy se pre-verifica que el destinatario tenga WhatsApp (`baileys.service.ts:851`). En Cloud API no existe: se envía y se maneja el error asincrónico del webhook.
- Grupos y broadcast (hoy ya se descartan — `baileys.service.ts:675-683` — pérdida nula).

### 7.1 Coexistence: el comercio conserva la app de WhatsApp Business

Meta soporta un modo de onboarding —**"WhatsApp Business app onboarding"**, comúnmente llamado *coexistence*— en el que el número funciona **simultáneamente** en Cloud API y en la app de WhatsApp Business del comercio. Elimina el que sería el mayor obstáculo de adopción respecto de Baileys. Verificado contra la documentación oficial de Meta (2026-08-05):

- Se activa pasando `featureType: "whatsapp_business_app_onboarding"` en el objeto `extras` del launcher de Embedded Signup. La pantalla de selección de WABA se reemplaza por una de "conectar tu cuenta de WhatsApp Business existente".
- El evento de finalización cambia: `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (en vez de `FINISH`), y su payload trae `waba_id`.
- **Se saltea el paso de registro del número** (`POST /{phone_number_id}/register`): ya viene registrado.
- Verificable con `GET /{phone_number_id}?fields=is_on_biz_app,platform_type` → `is_on_biz_app: true` + `platform_type: "CLOUD_API"`.

**Webhooks adicionales a los que hay que suscribirse** (además de `messages`):

| Campo | Para qué |
|---|---|
| `smb_message_echoes` | Mensajes que el comercio manda **a mano desde su celular**. Crítico: permite que el bot detecte una intervención humana y no responda encima. Con Baileys esto se resolvía con el echo-guard de `fromMe` (`baileys.service.ts:703`) — acá es un webhook explícito. |
| `smb_app_state_sync` | Contactos actuales y nuevos del comercio |
| `history` | Historial de mensajes previos (si el comercio elige compartirlo) |

**Restricción operativa fuerte**: tras el onboarding hay una **ventana de 24 h** para disparar la sincronización de contactos e historial vía `POST /{phone_number_id}/smb_app_data`. Cada sincronización **se puede ejecutar una sola vez**; si se pierde la ventana o falla, el comercio tiene que hacer *offboard* y repetir todo el Embedded Signup. Implicancia de diseño: **la sincronización debe dispararse automáticamente al terminar el onboarding**, no como paso manual diferido.

Decisión de producto pendiente: coexistence (mejor adopción, más complejidad y una ventana de 24 h que no perdona) vs. flujo estándar API-only (más simple, pero le pide al comercio un número dedicado). **Recomendación: coexistence**, porque preserva la propiedad que hoy tienen con Baileys y es lo que el comercio espera.

### Riesgos operativos de la migración
| Riesgo | Mitigación |
|---|---|
| Fricción del Embedded Signup por comercio (Meta Business Manager, verificación, display name) | UX guiada en el dashboard; soporte manual en las primeras tandas; empezar business verification propio ya (lead time semanas) |
| Rechazo de templates (especialmente `post_visita` como marketing) | Redactar neutro, mantener textos actuales como base; webhook de estado de template + fallback a no enviar |
| Migración del número si el comercio ya lo usa en la app WhatsApp Business | Proceso oficial de migración de número de Meta (requiere desactivar 2FA de la app); ventana breve sin servicio; comunicarlo |
| Webhook caído = mensajes demorados | Responder 200 inmediato + cola async; Meta reintenta con backoff; alerta de disponibilidad sobre `/health` |
| Ventana de 24 h corta mensajes proactivos que hoy salen gratis | "Smart send" (§4) + presupuesto de templates por comercio monitoreado en Fase 3 |
| Límite inicial de mensajería (250–1000 conversaciones únicas/día por número nuevo) | Suficiente para un restaurante; el tier sube solo con volumen y calidad; monitorear `messaging_limit_tier` |
| Token del comercio revocado (cambia password, quita permisos) | Webhook `account_update` + estado `error` en el canal + alerta y re-onboarding guiado |

---

## Apéndice: mapa de archivos afectados

| Archivo | Rol en la migración |
|---|---|
| [`src/services/baileys.service.ts`](src/services/baileys.service.ts) | Se envuelve en `BaileysAdapter` (F0), se elimina (F4) |
| [`src/services/whatsapp-handler.service.ts`](src/services/whatsapp-handler.service.ts) | Renombre `jid`→`phone`, consume la interfaz; la lógica de reservas no cambia |
| [`src/services/realtime-sync.service.ts`](src/services/realtime-sync.service.ts) | Deja de resolver JIDs a mano; textos proactivos → templates |
| [`src/services/post-visit.service.ts`](src/services/post-visit.service.ts) | Ídem; su patrón de scheduler se reutiliza para `recordatorio_reserva` |
| [`src/utils/message-templates.ts`](src/utils/message-templates.ts) | Absorbe los ~40 strings inline; fuente de los cuerpos de templates Meta |
| [`src/controllers/session.controller.ts`](src/controllers/session.controller.ts) / [`src/routes/sessions.routes.ts`](src/routes/sessions.routes.ts) | Reemplazados por endpoints de canal/onboarding (§3.3) |
| [`src/controllers/messages.controller.ts`](src/controllers/messages.controller.ts) | `POST /send` pasa por el gateway |
| [`src/types/index.ts`](src/types/index.ts) / [`src/types/supabase.ts`](src/types/supabase.ts) | Tipos de transporte renombrados; tipos regenerados con `whatsapp_channels` |
| `whatsapp-client.js`, `auth_sessions/` | Eliminados en F4 |
