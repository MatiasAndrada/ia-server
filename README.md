# 🤖 IA Server - Backend de Inteligencia Artificial para WhatsApp

API REST en Node.js/Express que funciona como backend de inteligencia artificial para un sistema de gestión de listas de espera de restaurantes vía WhatsApp, usando Ollama + Llama 3.2.

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

- 🤖 **Procesamiento de IA con Ollama**: Usa Llama 3.2 para respuestas naturales
- 🎭 **Sistema Multi-Agente**: Múltiples agentes especializados con diferentes propósitos ([Ver AGENTS.md](AGENTS.md))
- 💬 **Gestión de Conversaciones**: Mantiene historial de últimos 10 mensajes por conversación
- 🎯 **Análisis de Intenciones**: Clasifica mensajes en acciones específicas automáticamente
- ⚡ **Procesamiento por Lotes**: Endpoint batch para múltiples mensajes
- 🔒 **Seguridad**: Autenticación con API Key, CORS, Helmet, Rate Limiting
- 📊 **Cache Inteligente**: Redis para conversaciones y contexto
- 🔄 **Retry Logic**: Reintentos automáticos en fallos de Ollama
- 📝 **Logging Estructurado**: Winston para logs detallados
- ✅ **Validación Robusta**: Zod para validación de esquemas
- 🚀 **Process Management**: PM2 para producción con cluster mode
- 🔌 **API Flexible**: Soporte para múltiples agentes y casos de uso

## 🏗️ Arquitectura

```
┌─────────────┐      HTTP/REST      ┌──────────────┐
│   Next.js   │ ←─────────────────→ │  IA Server   │
│  (WhatsApp) │                     │  (Express)   │
└─────────────┘                     └──────┬───────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ↓                      ↓                      ↓
              ┌──────────┐          ┌──────────┐          ┌──────────┐
              │  Ollama  │          │  Redis   │          │PostgreSQL│
              │(Llama3.2)│          │ (Cache)  │          │(Opcional)│
              └──────────┘          └──────────┘          └──────────┘
```

### Flujo de Procesamiento

1. **Cliente WhatsApp** envía mensaje → **Next.js**
2. **Next.js** envía a `/api/chat` con contexto del negocio
3. **IA Server** recupera historial de Redis
4. **Ollama** procesa con Llama 3.2 y genera respuesta
5. Parsea **acciones** estructuradas de la respuesta
6. Guarda en **historial** y retorna a Next.js
7. **Next.js** ejecuta acciones y envía respuesta por WhatsApp

## 📦 Requisitos Previos

- **Node.js** 22+ y npm 10+
- **Redis** 6+ (para cache de conversaciones)
- **Ollama** con modelo Llama 3.2
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

# Ollama
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3.2

# PM2 (opcional)
sudo npm install -g pm2
```

#### macOS

```bash
# Homebrew
brew install node redis ollama

# Iniciar servicios
brew services start redis
ollama serve &

# Descargar modelo
ollama pull llama3.2

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

El script verificará:
- ✅ Node.js 22+
- ✅ Redis instalado y corriendo
- ✅ Ollama instalado con modelo llama3.2
- ✅ Instalación de dependencias npm
- ✅ Creación de `.env`
- ✅ Build de TypeScript

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

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
OLLAMA_TIMEOUT=30000

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
  "ollama": true,
  "redis": true,
  "model": "llama3.2",
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
- ✅ **Services**: Ollama service con mocks, retry logic
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

### Ollama no responde

```bash
# Verificar si Ollama está corriendo
curl http://localhost:11434/api/tags

# Iniciar Ollama
ollama serve

# Verificar modelo descargado
ollama list

# Descargar modelo si falta
ollama pull llama3.2
```

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

```bash
# PM2 logs
pm2 logs ia-server

# Archivos de logs
tail -f logs/combined.log
tail -f logs/error.log
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
│   ├── index.ts                 # Entry point
│   ├── config/
│   │   ├── ollama.ts           # Ollama client config
│   │   └── redis.ts            # Redis client config
│   ├── controllers/
│   │   ├── chat.controller.ts   # Chat & batch handlers
│   │   └── health.controller.ts # Health check
│   ├── services/
│   │   ├── ollama.service.ts    # Ollama API wrapper
│   │   ├── conversation.service.ts # Conversation history
│   │   ├── intent.service.ts    # Intent analysis
│   │   └── cache.service.ts     # Business context cache
│   ├── middleware/
│   │   ├── auth.middleware.ts   # API key auth
│   │   ├── rateLimit.middleware.ts # Rate limiting
│   │   └── validation.middleware.ts # Zod schemas
│   ├── utils/
│   │   ├── prompts.ts          # System prompts
│   │   ├── logger.ts           # Winston logger
│   │   └── actions.ts          # Action parsing
│   ├── types/
│   │   └── index.ts            # TypeScript types
│   └── __tests__/              # Jest tests
├── logs/                        # Log files
├── dist/                        # Compiled JS
├── .env                         # Environment variables
├── ecosystem.config.js          # PM2 config
├── setup.sh                     # Setup script
├── deploy.sh                    # Deployment script
└── README.md                    # Este archivo
```

## 📚 Documentación Adicional

- **[AGENTS.md](AGENTS.md)** - Sistema Multi-Agente: configuración, uso y creación de agentes personalizados
- **[TYPES_GENERATION.md](TYPES_GENERATION.md)** - Generación de tipos de TypeScript desde Supabase (2 métodos)
- **[QUICK_START.md](QUICK_START.md)** - Guía rápida de inicio
- **[ENDPOINTS.md](ENDPOINTS.md)** - Documentación completa de API endpoints

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
