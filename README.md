# 🤖 IA Server - Backend de Inteligencia Artificial para WhatsApp

API REST en Node.js/Express que funciona como backend de inteligencia artificial para un sistema de gestión de listas de espera de restaurantes vía WhatsApp, usando OpenRouter (acceso a Claude, GPT, Gemini y otros modelos vía una única API).

## 📋 Tabla de Contenidos

- [Características](#características)
- [Arquitectura](#arquitectura)
- [Requisitos Previos](#requisitos-previos)
- [Instalación](#instalación)
- [Configuración](#configuración)
- [API Endpoints](#api-endpoints)
- [Integración con Next.js](#integración-con-nextjs)
- [Deployment](#deployment)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## ✨ Características

- 📲 **WhatsApp directo**: conexión multi-sesión por negocio vía Baileys (QR, start/stop), sin depender de un proveedor externo de WhatsApp Business API — ver [docs/ENDPOINTS.md](docs/ENDPOINTS.md)
- 📅 **Reservas conversacionales — dos motores en paralelo, por negocio (flag `AGENT_MODE`)**:
  - **v1 (default)**: flujo multi-paso (personas, día, horario, confirmación, edición, cancelación) manejado de forma determinística en `WhatsAppHandler`.
  - **v2 (`src/agent/`, opt-in por `AGENT_V2_BUSINESS_IDS`)**: orquestador con tool-calling — el LLM lleva la conversación libremente (sin pasos ni menús forzados) y solo las reglas de negocio (disponibilidad, fechas bloqueadas, ventana de reserva, reserva única activa) quedan en tools deterministas que el modelo invoca. Ver [Arquitectura](#arquitectura).
  - Ambos motores comparten fechas bloqueadas por negocio y la política de una reserva activa por cliente.
- 🌐 **Multi-idioma (ES/EN/PT)**: detección automática por mensaje y cambio explícito en cualquier momento de la conversación (`src/i18n`)
- 🤖 **Procesamiento de IA con OpenRouter**: Acceso a modelos de última generación (Claude, GPT, Gemini, etc.) vía una única API, con failover automático entre modelos
- 🎭 **Sistema Multi-Agente (legacy, `src/agents/`)**: agente conversacional de respaldo para conversación libre fuera del flujo de reserva de v1, y endpoint HTTP standalone ([Ver docs/AGENTS.md](docs/AGENTS.md)) — no confundir con el orquestador v2 de arriba, que es un sistema distinto
- 💬 **Gestión de Conversaciones**: Mantiene historial de últimos 10 mensajes por conversación
- 🎯 **Análisis de Intenciones**: Clasifica mensajes en acciones específicas automáticamente
- ⚡ **Procesamiento por Lotes**: Endpoint batch para múltiples mensajes
- 🔒 **Seguridad**: Autenticación con API Key, CORS, Helmet, Rate Limiting
- 📊 **Cache Inteligente**: Redis para conversaciones y contexto
- 🔄 **Retry Logic**: Reintentos automáticos en fallos de OpenRouter, con failover entre modelos
- 📝 **Logging Estructurado**: Winston para logs detallados
- ✅ **Validación Robusta**: Zod para validación de esquemas
- 🚀 **Process Management**: PM2 para producción con cluster mode
- 🔌 **API Flexible**: Soporte para múltiples agentes y casos de uso

## 🏗️ Arquitectura

El servidor se conecta directamente a WhatsApp (vía Baileys) con una sesión propia por negocio; no depende de un frontend intermedio para recibir mensajes. Un panel externo (opcional) puede usar la API HTTP para gestionar sesiones, enviar mensajes o consumir la ruta legacy `/api/chat`.

```
              WhatsApp (Baileys — una sesión por businessId)
                              ↕
┌──────────────┐   HTTP/REST   ┌──────────────┐
│  Panel Admin │ ←───────────→ │  IA Server   │
│  (opcional)  │               │  (Express)   │
└──────────────┘               └──────┬───────┘
                                       │
                    ┌──────────────────────┼──────────────────────┐
                    ↓                      ↓                      ↓
              ┌──────────┐          ┌──────────┐          ┌──────────┐
              │OpenRouter│          │  Redis   │          │ Supabase │
              │(multi-LLM│          │ (Cache,  │          │(negocios,│
              │ vía API) │          │  locks)  │          │reservas…)│
              └──────────┘          └──────────┘          └──────────┘
```

### Flujo de Procesamiento (WhatsApp directo — camino principal)

El cliente escribe por **WhatsApp** a un número conectado vía Baileys (uno por negocio). `WhatsAppHandler._processMessage` resuelve el **idioma** de la conversación y, en un único punto de bifurcación, decide **v1 o v2** según si el `businessId` está en `AGENT_V2_BUSINESS_IDS` (ver `src/agent/feature-flag.ts`). El resto del handler — locks, debounce, envío por Baileys — es compartido por ambos motores.

**v1 (default, `WhatsAppHandler`/`ReservationService`):**

1. Resuelve el **paso actual** de la reserva (`ReservationDraft`), si hay una en curso.
2. Según el paso y el mensaje, el flujo avanza de forma **determinística** (día, horario, personas, confirmación, edición, cancelación); recurre al LLM (OpenRouter) puntualmente para comprensión de lenguaje natural o para conversación libre fuera de paso (agente `waitlist`, ver [docs/AGENTS.md](docs/AGENTS.md)).
3. Las respuestas salen de templates (`src/utils/prompts.ts`, catálogos i18n).

**v2 (opt-in por negocio, `src/agent/`):**

1. Se resuelve el **perfil del cliente para ese negocio** (`agent/state.ts` → `loadCustomerProfile`, `customers` está keyed por `(business_id, phone)`) *antes* del primer token del modelo, para saludar por nombre y en su idioma sin gastar una iteración del loop.
2. `agent/orchestrator.ts` arma el system prompt (`agent/system-prompt.ts`: parte estable + bloque de estado — horarios, eventos activos, perfil) y corre `openrouter.service.runToolLoop`: el modelo decide libremente qué preguntar y en qué orden, y llama tools (`src/agent/tools/`) para cada acción real (`create_reservation`, `check_availability`, `cancel_reservation`, `list_events`, …).
3. Las tools son las mismas reglas de negocio de v1 reusadas como funciones puras (`reservation-datetime.ts`) — ventana de reserva, fechas bloqueadas, horarios, reserva única activa — devueltas como `ToolResult`. Un campo `verbatim` permite que un hecho crítico (código de reserva, motivo de fecha bloqueada) salga tal cual, sin que el modelo lo parafrasee.
4. Historial y estado se persisten en Redis bajo el prefijo `agent_v2:` (namespace separado de v1).
5. `AGENT_SHADOW_BUSINESS_IDS` corre v2 en **modo sombra**: procesa el mismo mensaje real con `dryRun` (sin escribir en la DB ni responder al cliente) para comparar contra v1 sin arriesgar tráfico — ver evento `agent.shadow` en los logs.

Ninguno de los dos motores necesita reprocesar reglas de negocio en el prompt: viven en el código (`reservation-datetime.ts` y las tools), no en texto que el modelo pueda malinterpretar.

> `POST /api/chat` y las rutas bajo `/api/agents` se mantienen por compatibilidad para integraciones externas que ya reciben el mensaje por otro canal — no pasan por el flag v1/v2, solo por el agente `waitlist` legacy. Ver [docs/ENDPOINTS.md](docs/ENDPOINTS.md) para el detalle de ambos caminos (WhatsApp directo y HTTP).

## 📦 Requisitos Previos

- **Node.js** 22+ y npm 10+
- **Redis** 6+ (para cache de conversaciones)
- **Cuenta de OpenRouter** (https://openrouter.ai) con API key y crédito cargado
- **PM2** (opcional, para producción)

### Instalación de Dependencias

#### Linux (Ubuntu/Debian)

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Redis
sudo apt-get install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server

# PM2 (opcional)
sudo npm install -g pm2
```

No hace falta instalar ni servir ningún modelo localmente — OpenRouter es un servicio HTTP externo, solo necesitás la API key (ver sección de Configuración).

#### macOS

```bash
# Homebrew
brew install node redis

# Iniciar Redis
brew services start redis

# PM2
npm install -g pm2
```

## 🚀 Instalación

### 1. Clonar/Descargar el proyecto

```bash
cd /tmp/ia-server
```

### 2. Ejecutar script de setup

```bash
chmod +x setup.sh
./setup.sh
```

El script verificará Node.js, Redis, conectividad con OpenRouter y las dependencias npm. No requiere instalar ningún modelo de IA localmente.

### 3. Configurar variables de entorno

```bash
nano .env
```

Edita las siguientes variables:

```env
# Server
PORT=4000

# Modo de ejecución: production, development, test
# - production: responde a todos los chats de clientes, ignora mensajes propios (fromMe)
# - test: responde SOLO en tu chat personal de WhatsApp, ignora otros chats
#   útil para probar sin enviar respuestas a clientes reales
NODE_ENV=production

# OpenRouter (https://openrouter.ai)
OPENROUTER_API_KEY=tu_openrouter_api_key
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
# Opcional: modelos de respaldo separados por coma, probados en orden si el principal falla
OPENROUTER_FALLBACK_MODELS=
OPENROUTER_TIMEOUT=30000

# Security - ¡CAMBIAR EN PRODUCCIÓN!
API_KEY=tu_api_key_secreta_aqui_cambiar_en_produccion
ALLOWED_ORIGINS=https://tu-dominio.com,http://localhost:3000

# Redis
REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=info
```

## ⚙️ Configuración

### Generar API Key Segura

```bash
# Generar una API key aleatoria
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copia el resultado a `API_KEY` en `.env`.

### Configurar CORS

Agrega los dominios permitidos en `ALLOWED_ORIGINS`:

```env
ALLOWED_ORIGINS=https://mi-app.com,https://admin.mi-app.com,http://localhost:3000
```

## 📡 API Endpoints

### 1. POST `/api/chat`

Procesa un mensaje con IA usando historial de conversación.

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

**Body:**
```json
{
  "phone": "+5491112345678",
  "message": "Hola, quiero anotarme para 4 personas",
  "businessId": "123e4567-e89b-12d3-a456-426614174000",
  "context": {
    "businessName": "Restaurante La Plaza",
    "businessAddress": "Av. Corrientes 1234, CABA",
    "businessHours": "12:00 - 23:00",
    "currentWaitlist": 5,
    "averageWaitTime": 20,
    "customerInfo": {
      "isKnown": false
    }
  }
}
```

**Response:**
```json
{
  "response": "¡Hola! Claro, te anoto para 4 personas. ¿Me podrías decir tu nombre completo? El tiempo de espera estimado es de 20 minutos.",
  "actions": [
    {
      "type": "REGISTER",
      "data": {
        "partySize": 4,
        "status": "pending_name"
      },
      "confidence": 0.9
    }
  ],
  "confidence": 0.92
}
```

### 2. POST `/api/analyze-intent`

Determina la intención de un mensaje.

**Body:**
```json
{
  "message": "Quiero cancelar mi reserva",
  "context": {
    "businessName": "Restaurante La Plaza"
  }
}
```

**Response:**
```json
{
  "intent": "cancel",
  "entities": {
    "action": "cancel"
  },
  "confidence": 0.95
}
```

### 3. DELETE `/api/conversations/:phone`

Limpia el historial de conversación de un teléfono.

**Example:**
```bash
curl -X DELETE \
  -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:4000/api/conversations/+5491112345678
```

**Response:** `204 No Content`

### 4. GET `/health`

Health check del servidor (sin autenticación).

**Response:**
```json
{
  "status": "healthy",
  "llm": true,
  "redis": true,
  "model": "anthropic/claude-3.5-sonnet",
  "uptime": 3600,
  "timestamp": "2026-02-06T10:30:00Z"
}
```

### 5. POST `/api/batch`

Procesa múltiples mensajes en batch (máx. 50).

**Body:**
```json
{
  "messages": [
    {
      "phone": "+5491112345678",
      "message": "Hola",
      "businessId": "uuid-1",
      "context": { "businessName": "Restaurant 1" }
    },
    {
      "phone": "+5491187654321",
      "message": "Quiero reservar",
      "businessId": "uuid-2",
      "context": { "businessName": "Restaurant 2" }
    }
  ]
}
```

**Response:**
```json
{
  "results": [
    {
      "index": 0,
      "success": true,
      "data": {
        "response": "...",
        "actions": [],
        "confidence": 0.85
      }
    },
    {
      "index": 1,
      "success": true,
      "data": {
        "response": "...",
        "actions": [],
        "confidence": 0.9
      }
    }
  ],
  "processedCount": 2,
  "failedCount": 0
}
```

---

## 🎭 Sistema Multi-Agente (Nuevo)

El servidor ahora soporta múltiples agentes especializados. **Ver [AGENTS.md](AGENTS.md) para documentación completa**.

### 6. GET `/api/agents`

Lista todos los agentes disponibles.

**Example:**
```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:4000/api/agents
```

### 7. GET `/api/agents/:agentId`

Obtiene detalles de un agente específico.

**Example:**
```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:4000/api/agents/waitlist
```

### 8. POST `/api/agents/:agentId/chat`

Genera una respuesta usando un agente específico.

**Example:**
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hola, cuál es mi posición?",
    "conversationId": "user-123",
    "context": {"phone": "+1234567890"}
  }' \
  http://localhost:4000/api/agents/waitlist/chat
```

**Response:**
```json
{
  "success": true,
  "data": {
    "response": "Hola! Con gusto te ayudo...",
    "action": "CHECK_STATUS",
    "conversationId": "user-123",
    "agent": {
      "id": "waitlist",
      "name": "Asistente de Lista de Espera"
    },
    "processingTime": 1245
  }
}
```

### 9. DELETE `/api/agents/:agentId/conversations/:conversationId`

Limpia el historial de una conversación específica.

---

## 🔌 Integración con Next.js

### Ejemplo de Cliente

```typescript
// lib/ia-client.ts
const IA_API_URL = process.env.IA_SERVER_URL || 'http://localhost:4000';
const IA_API_KEY = process.env.IA_API_KEY;

export async function processMessage(
  phone: string,
  message: string,
  businessId: string,
  context?: any
) {
  const response = await fetch(`${IA_API_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${IA_API_KEY}`,
    },
    body: JSON.stringify({
      phone,
      message,
      businessId,
      context,
    }),
  });

  if (!response.ok) {
    throw new Error(`IA Server error: ${response.status}`);
  }

  return await response.json();
}
```

### Uso en API Route

```typescript
// app/api/whatsapp/route.ts
import { processMessage } from '@/lib/ia-client';

export async function POST(req: Request) {
  const { phone, message, businessId } = await req.json();

  // Obtener contexto del negocio de tu DB
  const business = await db.business.findUnique({ where: { id: businessId } });
  const waitlist = await db.waitlist.count({ where: { businessId } });

  // Procesar con IA
  const aiResponse = await processMessage(phone, message, businessId, {
    businessName: business.name,
    businessAddress: business.address,
    currentWaitlist: waitlist,
    averageWaitTime: 15,
  });

  // Ejecutar acciones
  for (const action of aiResponse.actions) {
    if (action.type === 'REGISTER') {
      // Crear entrada en waitlist
      await db.waitlist.create({
        data: {
          businessId,
          phone,
          partySize: action.data.partySize,
        },
      });
    }
    // ... otras acciones
  }

  // Enviar respuesta por WhatsApp con Baileys
  await sendWhatsAppMessage(phone, aiResponse.response);

  return Response.json({ success: true });
}
```

## 🚀 Deployment

### Modo Desarrollo

```bash
npm run dev
```

### Modo Producción (Node)

```bash
npm run build
npm start
```

### Modo Producción (PM2)

```bash
# Iniciar
npm run pm2:start

# Ver logs
pm2 logs ia-server

# Monitorear
pm2 monit

# Reiniciar
npm run pm2:restart

# Detener
npm run pm2:stop
```

### Script de Deployment

```bash
chmod +x deploy.sh
./deploy.sh
```

### Systemd Service (Linux)

Crear `/etc/systemd/system/ia-server.service`:

```ini
[Unit]
Description=IA Server
After=network.target redis.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/ia-server
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable ia-server
sudo systemctl start ia-server
sudo systemctl status ia-server
```

## 🧪 Testing

### Ejecutar Tests

```bash
# Todos los tests
npm test

# Watch mode
npm run test:watch

# Con cobertura
npm run test:coverage
```

### Tests Incluidos

- ✅ **Utils**: Actions parsing, prompts, entities extraction
- ✅ **Services**: OpenRouter service con mocks, retry logic, tool calling
- ✅ **Integration**: API endpoints con supertest

### Probar Endpoints Manualmente

```bash
# Health check
curl http://localhost:4000/health

# Chat (requiere API key)
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "phone": "+5491112345678",
    "message": "Hola, quiero anotarme",
    "businessId": "123e4567-e89b-12d3-a456-426614174000",
    "context": {
      "businessName": "Mi Restaurante",
      "currentWaitlist": 3,
      "averageWaitTime": 15
    }
  }'

# Analyze intent
curl -X POST http://localhost:4000/api/analyze-intent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "message": "Quiero cancelar"
  }'

# Clear conversation
curl -X DELETE http://localhost:4000/api/conversations/+5491112345678 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Probar con WhatsApp en Modo Test

Para probar la IA sin enviar respuestas a clientes reales:

1. **Configurar modo test**:
   ```bash
   # En .env
   NODE_ENV=test
   ```

2. **Iniciar el servidor**:
   ```bash
   npm start
   ```

3. **Conectar WhatsApp** (escanear QR desde tu cuenta)

4. **Enviar mensajes desde tu propio chat de WhatsApp**:
   - ✅ El bot responderá SOLO en tu chat personal
   - ❌ Ignorará mensajes de otros chats
   - ❌ No responderá a clientes reales

5. **Volver a producción**:
   ```bash
   # En .env
   NODE_ENV=production
   ```

> **Nota**: En modo `production`, el bot responde a todos los chats de clientes pero ignora tus propios mensajes (fromMe=true).

## 🔧 Troubleshooting

### OpenRouter no responde / errores de IA

```bash
# Verificar que la API key es válida y hay crédito disponible
curl https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY"

# Ver el estado reportado por el propio server
curl http://localhost:4000/health
```

Causas típicas: `OPENROUTER_API_KEY` vacía o inválida, sin crédito cargado en la cuenta de OpenRouter, o el modelo en `OPENROUTER_MODEL` no existe/fue deprecado (ver catálogo en https://openrouter.ai/models).

### Redis no conecta

```bash
# Verificar si Redis está corriendo
redis-cli ping

# Iniciar Redis
# Linux
sudo systemctl start redis-server

# macOS
brew services start redis

# Verificar conexión
redis-cli
> KEYS *
> QUIT
```

### Error: API_KEY not set

```bash
# Asegurarse que .env existe y tiene API_KEY
cat .env | grep API_KEY

# Si no existe, copiar de ejemplo
cp .env.example .env
nano .env
```

### Rate Limit Exceeded

El servidor tiene rate limiting de 100 req/min por IP. Para testing local:

```typescript
// Comentar temporalmente en src/index.ts
// app.use('/api', generalRateLimiter);
```

### Memory Issues

Si el servidor consume mucha memoria:

```bash
# Ajustar max memory en ecosystem.config.js
max_memory_restart: '500M'

# O reducir número de instancias
instances: 1
```

### Ver Logs

El proceso escribe **sólo a stdout/stderr** en JSON estructurado; PM2 lo persiste
y `pm2-logrotate` lo rota. Detalle completo del contrato en [docs/LOGGING.md](docs/LOGGING.md).

```bash
# Todo (info/warn/debug) — logs/pm2-out.log
pm2 logs ia-server

# Sólo errores — logs/pm2-error.log
pm2 logs ia-server --err

# Cada línea es un JSON válido, así que se puede filtrar por evento
pm2 logs ia-server --raw | grep '"event":"turn.completed"'
pm2 logs ia-server --raw | jq 'select(.conversationId == "<businessId>-<phone>")'

# Ver la traza paso a paso de un problema puntual
LOG_LEVEL=debug pm2 restart ia-server
```

Rotación (una sola vez por servidor, `deploy.sh` ya lo hace):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

## 📊 Monitoreo

### PM2 Monitoring

```bash
pm2 monit
```

### Stats Endpoint

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:4000/stats
```

### Redis Keys

```bash
redis-cli
> KEYS conversation:*
> GET conversation:+5491112345678
> KEYS business:*
```

## 📝 Estructura del Proyecto

```
ia-server/
├── src/
│   ├── index.ts                        # Entry point (HTTP + sesiones de WhatsApp)
│   ├── config/                         # Clientes de OpenRouter, Redis, Supabase
│   ├── controllers/                    # chat, agent, reservation, blocked-date, session, messages, health
│   ├── services/
│   │   ├── whatsapp-handler.service.ts     # Punto de bifurcación v1/v2 + flujo determinístico de v1 (reserva, idioma, cancelación…)
│   │   ├── baileys.service.ts              # Conexión directa a WhatsApp (multi-sesión por negocio)
│   │   ├── reservation.service.ts          # Ciclo de vida de la reserva (draft → confirmada) — usado por v1
│   │   ├── reservation-nlu.service.ts      # Extracción de datos de reserva en lenguaje natural (v1)
│   │   ├── reservation-planner.service.ts  # Descompone mensajes con varias acciones (v1)
│   │   ├── realtime-sync.service.ts        # Sync en tiempo real con Supabase (fechas bloqueadas, etc.) — compartido
│   │   ├── openrouter.service.ts           # OpenRouter API wrapper + runToolLoop (usado por v2)
│   │   ├── conversation.service.ts         # Historial de conversación (v1)
│   │   ├── intent.service.ts               # Análisis de intención (ruta legacy /api/chat y v1)
│   │   └── supabase.service.ts             # Acceso a datos (negocios, clientes, reservas, mesas)
│   ├── agent/                           # Orquestador v2: tool-calling, sin pasos (state.ts, system-prompt.ts, orchestrator.ts, tools/, feature-flag.ts)
│   ├── agents/                          # Config del agente conversacional de respaldo "waitlist" (legacy, no confundir con agent/ de arriba)
│   ├── i18n/                           # Detección/selección de idioma + catálogos es/en/pt
│   ├── middleware/                     # Auth, rate limiting, validación (Zod)
│   ├── routes/                         # Sessions API y Messages API de WhatsApp
│   ├── utils/                          # Prompts, plantillas, fechas/horarios, logger + catálogo de eventos
│   ├── types/                          # Tipos de TypeScript (incl. generados desde Supabase)
│   └── __tests__/                      # Jest: unit, integration, escenarios de conversación
├── scripts/                             # chat-simulator.ts (--mode v1|v2), agent-eval.ts (`pnpm eval`, v2 contra el modelo real), utilidades de setup/tipos
├── logs/                                # Salida de PM2 (pm2-out.log / pm2-error.log)
├── dist/                                # Compiled JS
├── docs/                                # AGENTS.md, ENDPOINTS.md, TYPES_GENERATION.md
├── .env                                 # Environment variables
├── ecosystem.config.js                  # PM2 config
├── setup.sh                             # Setup script
├── deploy.sh                            # Deployment script
└── README.md                            # Este archivo
```

## 📚 Documentación Adicional

- **[docs/AGENTS.md](docs/AGENTS.md)** - Sistema Multi-Agente: configuración, uso y creación de agentes personalizados
- **[docs/TYPES_GENERATION.md](docs/TYPES_GENERATION.md)** - Generación de tipos de TypeScript desde Supabase (2 métodos)
- **[QUICK_START.md](QUICK_START.md)** - Guía rápida de inicio
- **[docs/ENDPOINTS.md](docs/ENDPOINTS.md)** - Documentación completa de API endpoints

## 🤝 Contribuciones

Este es un proyecto interno. Para cambios:

1. Crear branch: `git checkout -b feature/nueva-funcionalidad`
2. Hacer cambios y tests
3. Commit: `git commit -m "Descripción"`
4. Push: `git push origin feature/nueva-funcionalidad`

## 📄 Licencia

MIT

---

**Desarrollado para sistema de gestión de listas de espera vía WhatsApp**
