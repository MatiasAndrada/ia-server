# 🤖 Sistema Multi-Agente - IA Server

El servidor ahora soporta múltiples agentes de IA con diferentes propósitos y configuraciones. Cada agente puede tener su propio modelo, prompts personalizados y conjuntos de acciones.

## 📋 Tabla de Contenidos

- [Agentes Disponibles](#agentes-disponibles)
- [API Endpoints](#api-endpoints)
- [Ejemplos de Uso](#ejemplos-de-uso)
- [Crear un Nuevo Agente](#crear-un-nuevo-agente)
- [Beneficios del Sistema](#beneficios-del-sistema)

## 🎯 Agentes Disponibles

### 1. Waitlist Agent (Lista de Espera)

**ID:** `waitlist`  
**Propósito:** Gestión de listas de espera para restaurantes vía WhatsApp  
**Modelo:** `llama3.2`

**Acciones soportadas:**
- `CHECK_STATUS` - Consultar estado en la lista
- `REGISTER` - Registrarse en la lista de espera
- `CANCEL` - Cancelar registro
- `INFO_REQUEST` - Solicitar información general

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
      "name": "Asistente de Lista de Espera",
      "description": "Gestión de listas de espera para restaurantes vía WhatsApp",
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
      "name": "Asistente de Lista de Espera"
    },
    "processingTime": 1245
  },
  "timing": {
    "total": 1250,
    "processing": 1245
  }
}
```

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
  model: 'llama3.2',
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

Para más información, consulta el [README principal](README.md) o el [QUICK_START.md](QUICK_START.md).
