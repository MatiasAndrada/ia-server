# 🤖 Sistema Multi-Agente - IA Server

El servidor soporta múltiples agentes de IA con diferentes propósitos y configuraciones. Cada agente puede tener su propio modelo, prompts personalizados y conjuntos de acciones. Hoy solo hay un agente registrado (`waitlist`), pero el sistema está pensado para sumar más sin tocar el core (ver [Crear un Nuevo Agente](#crear-un-nuevo-agente)).

> **Importante — qué maneja este agente y qué no:** el flujo de reserva paso a paso (personas → día → horario → confirmación → edición → cancelación) para clientes que escriben por WhatsApp es **determinístico** y vive en `WhatsAppHandler`/`ReservationService`, no en este agente. El `waitlist` agent se usa en dos lugares puntuales:
> 1. Como **fallback conversacional** dentro de ese mismo flujo, para turnos fuera de paso (saludos sueltos, preguntas generales, un borrador en un estado inesperado) — `WhatsAppHandler` le pasa el mensaje y, si el agente infiere una de las tres acciones deterministas (`CREATE_RESERVATION`, `CHECK_STATUS`, `CANCEL`), dispara ese handler; para el resto, contesta en lenguaje natural.
> 2. Como endpoint standalone (`POST /api/agents/waitlist/chat`, más abajo) para integraciones externas o pruebas, sin pasar por WhatsApp ni por el flujo determinístico.

## 📋 Tabla de Contenidos

- [Agentes Disponibles](#agentes-disponibles)
- [API Endpoints](#api-endpoints)
- [Ejemplos de Uso](#ejemplos-de-uso)
- [Crear un Nuevo Agente](#crear-un-nuevo-agente)
- [Beneficios del Sistema](#beneficios-del-sistema)

## 🎯 Agentes Disponibles

### 1. Waitlist Agent (Reservas)

**ID:** `waitlist`  
**Propósito:** Respaldo conversacional para reservas de restaurantes vía WhatsApp — conversación libre fuera del flujo paso a paso, que es determinístico (ver nota arriba)  
**Modelo:** `openrouter` (resuelto por OPENROUTER_MODEL)

**Acciones que puede inferir** (por keyword, definidas en `src/agents/waitlist.agent.ts` — el `action` que devuelve `/api/agents/waitlist/chat` es esta inferencia, no una ejecución automática):
- `CREATE_RESERVATION` - Crear nueva reserva *(dispara el flujo real cuando se detecta desde WhatsApp)*
- `UPDATE_RESERVATION` - Modificar reserva existente
- `LIST_RESERVATIONS` - Listar reservas del cliente
- `CHECK_STATUS` - Consultar estado en la lista *(dispara el handler real cuando se detecta desde WhatsApp)*
- `GET_WAIT_TIME` - Consultar tiempo de espera estimado
- `NOTIFY_DELAY` - Notificar retraso
- `CANCEL` - Cancelar reserva *(dispara el handler real cuando se detecta desde WhatsApp)*

## 🔌 API Endpoints

### Listar Agentes Disponibles

```http
GET /api/agents
Authorization: Bearer YOUR_API_KEY
```

**Respuesta:**
```json
{
  "success": true,
  "count": 1,
  "agents": [
    {
      "id": "waitlist",
      "name": "Asistente de Reservas",
      "description": "Gestión de reservas para restaurantes vía WhatsApp",
      "enabled": true,
      "actions": [
        {
          "type": "CHECK_STATUS",
          "description": "Consultar estado en la lista de espera"
        }
      ]
    }
  ]
}
```

### Obtener Detalles de un Agente

```http
GET /api/agents/:agentId
Authorization: Bearer YOUR_API_KEY
```

**Ejemplo:**
```bash
curl http://localhost:4000/api/agents/waitlist \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Chat con un Agente

```http
POST /api/agents/:agentId/chat
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

**Body:**
```json
{
  "message": "Hola, quiero ver el estado de mi turno",
  "conversationId": "user-123",
  "context": {
    "customerName": "Juan Pérez",
    "phone": "+1234567890"
  }
}
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "response": "Hola Juan! Claro, con gusto te ayudo. ¿Podrías decirme el número de teléfono con el que te registraste?",
    "action": "CHECK_STATUS",
    "conversationId": "user-123",
    "agent": {
      "id": "waitlist",
      "name": "Asistente de Reservas"
    },
    "processingTime": 1245
  },
  "timing": {
    "total": 1250,
    "processing": 1245
  }
}
```

> `action` es la inferencia por keyword descripta en [Agentes Disponibles](#agentes-disponibles): identifica de qué habla el mensaje, pero llamar a este endpoint directamente **no** crea, modifica ni cancela ninguna reserva — `response` es solo texto conversacional.

### Limpiar Historial de Conversación

```http
DELETE /api/agents/:agentId/conversations/:conversationId
Authorization: Bearer YOUR_API_KEY
```

## 💡 Ejemplos de Uso

### Ejemplo 1: Consultar estado con Waitlist Agent

```bash
curl -X POST http://localhost:4000/api/agents/waitlist/chat \
  -H "Authorization: Bearer f1c93149f93fb2432f6abd7e2a0322f7568e3d21f271903a9ffee85918f05844" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hola, cuál es mi posición en la lista?",
    "conversationId": "user-555-1234567890",
    "context": {
      "customerName": "María García",
      "phone": "+1234567890"
    }
  }'
```

### Ejemplo 2: Listar todos los agentes disponibles

```bash
curl http://localhost:4000/api/agents \
  -H "Authorization: Bearer f1c93149f93fb2432f6abd7e2a0322f7568e3d21f271903a9ffee85918f05844" \
  -H "Content-Type: application/json"
```

### Ejemplo 3: Limpiar historial de conversación

```bash
curl -X DELETE http://localhost:4000/api/agents/waitlist/conversations/user-555-1234567890 \
  -H "Authorization: Bearer f1c93149f93fb2432f6abd7e2a0322f7568e3d21f271903a9ffee85918f05844"
```

## 🔧 Crear un Nuevo Agente

### Paso 1: Crear el archivo de configuración

Crea un nuevo archivo en `src/agents/` (por ejemplo, `sales.agent.ts`):

```typescript
import { AgentConfig } from '../types';

export const salesAgent: AgentConfig = {
  id: 'sales',
  name: 'Asistente de Ventas',
  description: 'Asiste en consultas y cotizaciones de productos',
  model: 'openrouter',
  temperature: 0.8,
  maxTokens: 600,
  enabled: true,
  
  systemPrompt: `Eres un asistente de ventas profesional y persuasivo.

Tu trabajo es:
1. Responder consultas sobre productos
2. Generar cotizaciones personalizadas
3. Recomendar productos basados en necesidades
4. Cerrar ventas de manera efectiva

IMPORTANTE:
- Sé amable y profesional
- Escucha las necesidades del cliente
- Ofrece opciones relevantes
- Destaca beneficios, no solo características`,
  
  actions: [
    {
      type: 'PRODUCT_INFO',
      priority: 1,
      keywords: ['producto', 'precio', 'característica', 'especificaciones'],
      description: 'Información de productos'
    },
    {
      type: 'QUOTE',
      priority: 2,
      keywords: ['cotizar', 'presupuesto', 'cuánto cuesta', 'valor'],
      description: 'Generar cotización'
    },
    {
      type: 'RECOMMEND',
      priority: 3,
      keywords: ['recomendar', 'sugerir', 'mejor opción', 'qué me conviene'],
      description: 'Recomendar productos'
    }
  ]
};
```

### Paso 2: Registrar el agente

Edita `src/agents/index.ts` para incluir tu nuevo agente:

```typescript
import { salesAgent } from './sales.agent';

// En el constructor de AgentRegistry
private registerDefaultAgents(): void {
  this.register(waitlistAgent);
  this.register(salesAgent); // ← Agregar aquí
  
  logger.info('Default agents registered', {
    count: this.agents.size,
    agents: Array.from(this.agents.keys())
  });
}

// Exportar el agente
export { waitlistAgent, salesAgent };
```

### Paso 3: Compilar y probar

```bash
npm run build
npm start

# Probar el nuevo agente
curl http://localhost:4000/api/agents \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## ✨ Beneficios del Sistema

### 🎯 Modular
Cada agente tiene su propia lógica, prompts y acciones completamente aisladas.

### 📈 Escalable
Agregar nuevos agentes no requiere modificar el código core del servidor.

### 🔄 Flexible
Diferentes modelos, temperaturas y parámetros por agente según necesidad.

### 🛠️ Mantenible
Código organizado y separado por responsabilidad, fácil de mantener.

### ♻️ Reutilizable
Un solo servidor sirve múltiples propósitos sin duplicar infraestructura.

### 🔌 Compatible
Las rutas legacy (`/api/chat`) siguen funcionando para no romper integraciones existentes.

## 🔐 Seguridad

Todos los endpoints requieren autenticación con API Key en el header:

```
Authorization: Bearer YOUR_API_KEY
```

Configura tu API Key en el archivo `.env`:

```env
API_KEY=your-secure-api-key-here
```

## 📊 Monitoreo

Los agentes generan logs detallados para monitoreo y debugging:

```typescript
// Logs de ejemplo
{
  "level": "info",
  "message": "Generating response with agent",
  "agentId": "waitlist",
  "conversationId": "user-123",
  "messageLength": 45
}
```

## 🚀 Próximos Pasos

1. **Agregar más agentes** según tus necesidades
2. **Personalizar prompts** para mejorar respuestas
3. **Definir acciones personalizadas** por caso de uso
4. **Implementar callbacks** para ejecutar acciones automáticamente
5. **Agregar métricas** para analizar performance de agentes

---

Para más información, consulta el [README principal](../README.md), el [QUICK_START.md](../QUICK_START.md) o [ENDPOINTS.md](ENDPOINTS.md) para el resto de la API HTTP.
