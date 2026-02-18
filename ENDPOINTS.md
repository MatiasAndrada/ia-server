# 🌐 IA Server - Endpoints Documentation (HTTP/HTTPS)

Documentación completa de endpoints HTTP/HTTPS disponibles en el servidor IA. Los WebSockets han sido migrados a endpoints HTTP para mayor compatibilidad y simplicidad.

**Base URL**: http://149.50.129.227 ó https://tu-dominio.com  
**Protocolo**: HTTP/HTTPS  
**Formato**: JSON  

⚠️ **Nota**: Todos los endpoints `/api` requieren autenticación vía:  
`Authorization: Bearer YOUR_API_KEY`

## 📡 Configuración HTTPS

El servidor soporta HTTPS mediante variables de entorno:

```bash
USE_HTTPS=true
SSL_KEY_PATH=/path/to/private-key.pem  
SSL_CERT_PATH=/path/to/certificate.pem
```

Si no se configuran certificados, el servidor usa HTTP para desarrollo.

## 🔄 Migración de WebSockets

**Por qué se eliminaron los WebSockets:**
- Mayor simplicidad en la implementación
- Mejor compatibilidad con proxies (Nginx, Cloudflare, etc.)
- No requiere conexiones persistentes
- Cacheable y escalable
- Compatible con REST estándar

**Cómo migrar tu frontend:**
1. Reemplaza conexiones WebSocket con polling HTTP
2. Usa los nuevos endpoints de sesiones y mensajes
3. Implementa polling para actualizaciones en tiempo real (recomendado: cada 2-5 segundos para QR codes, cada 10-30 segundos para mensajes)

## HTTP

### Health and stats

- GET /health
  - Auth: no
  - Rate limit: healthCheckRateLimiter
  - Response: JSON from healthHandler
  - Example response (200):
    {
      "status": "healthy",
      "ollama": true,
      "redis": true,
      "model": "llama3.2",
      "uptime": 12345,
      "timestamp": "2026-02-11T18:05:21.123Z"
    }

- GET /stats
  - Auth: yes
  - Rate limit: generalRateLimiter
  - Response: JSON from statsHandler
  - Example response (200):
    {
      "uptime": 12345,
      "memory": {
        "heapUsed": "78 MB",
        "heapTotal": "120 MB",
        "rss": "156 MB"
      },
      "conversations": {
        "totalConversations": 42,
        "avgMessagesPerConversation": 6
      },
      "timestamp": "2026-02-11T18:05:21.123Z"
    }

### Legacy chat (compat)

- POST /api/chat
  - Auth: yes
  - Validation: chatSchema
  - Response: JSON from chatHandler
  - Example request:
    {
      "phone": "+5491112345678",
      "message": "Hola",
      "businessId": "biz-123",
      "context": {
        "language": "es"
      }
    }
  - Example response (200):
    {
      "response": "Hola! En que puedo ayudarte?",
      "actions": [],
      "confidence": 0.72
    }

- POST /api/analyze-intent
  - Auth: yes
  - Validation: intentSchema
  - Response: JSON from analyzeIntentHandler
  - Example request:
    {
      "message": "Quiero una mesa para 4",
      "context": {
        "language": "es"
      }
    }
  - Example response (200):
    {
      "intent": "RESERVATION_REQUEST",
      "confidence": 0.86
    }

- DELETE /api/conversations/:phone
  - Auth: yes
  - Validation: validatePhoneParam
  - Response: JSON from clearConversationHandler
  - Example response (204): no content

- POST /api/batch
  - Auth: yes
  - Rate limit: batchRateLimiter
  - Validation: batchSchema
  - Response: JSON from batchHandler
  - Example request:
    {
      "messages": [
        {
          "phone": "+5491112345678",
          "message": "Hola",
          "businessId": "biz-123"
        },
        {
          "phone": "+5491123456789",
          "message": "Quiero reservar",
          "businessId": "biz-123"
        }
      ]
    }
  - Example response (200):
    {
      "results": [
        { "success": true, "response": "..." },
        { "success": true, "response": "..." }
      ]
    }

### Agents (multi-agent)

- GET /api/agents
  - Auth: yes
  - Response: JSON from listAgentsHandler
  - Example response (200):
    {
      "success": true,
      "count": 2,
      "agents": [
        { "id": "waitlist", "name": "Asistente de Lista de Espera" }
      ]
    }

- GET /api/agents/:agentId
  - Auth: yes
  - Response: JSON from getAgentHandler
  - Example response (200):
    {
      "success": true,
      "agent": {
        "id": "waitlist",
        "name": "Asistente de Lista de Espera",
        "description": "...",
        "model": "llama3.2",
        "enabled": true,
        "actions": [
          { "type": "CHECK_STATUS", "description": "Consultar estado" }
        ]
      }
    }

- POST /api/agents/:agentId/chat
  - Auth: yes
  - Response: JSON from agentChatHandler
  - Example request:
    {
      "message": "Hola, quiero ver el estado de mi turno",
      "conversationId": "user-123",
      "context": {
        "customerName": "Juan Perez",
        "phone": "+1234567890"
      }
    }
  - Example response (200):
    {
      "success": true,
      "data": {
        "response": "Hola Juan! ...",
        "action": "CHECK_STATUS",
        "conversationId": "user-123",
        "agent": {
          "id": "waitlist",
          "name": "Asistente de Lista de Espera"
        },
        "processingTime": 1245
      },
      "timing": { "total": 1250, "processing": 1245 }
    }

- DELETE /api/agents/:agentId/conversations/:conversationId
  - Auth: yes
  - Response: JSON from agentClearConversationHandler
  - Example response (200):
    {
      "success": true,
      "message": "Conversation history cleared successfully",
      "conversationId": "user-123"
    }

### Reservations

- GET /api/reservations/zones/:businessId
  - Auth: yes
  - Response: JSON from getAvailableZonesHandler
  - Example response (200):
    {
      "success": true,
      "data": { "zones": [], "count": 0 }
    }

- GET /api/reservations/draft/:conversationId
  - Auth: yes
  - Response: JSON from getDraftStatusHandler
  - Example response (200, no draft):
    {
      "success": true,
      "data": { "hasActiveDraft": false, "draft": null }
    }

- POST /api/reservations
  - Auth: yes
  - Response: JSON from createReservationHandler
  - Example request:
    {
      "businessId": "biz-123",
      "customerName": "Maria Garcia",
      "customerPhone": "+5491112345678",
      "partySize": 4,
      "tableTypeId": "table-type-1",
      "zone": "salon"
    }
  - Example response (201):
    {
      "success": true,
      "waitlistEntry": { "id": "entry-123" }
    }

- PATCH /api/reservations/:reservationId/status
  - Auth: yes
  - Response: JSON from updateReservationStatusHandler
  - Example request:
    { "status": "SEATED" }
  - Example response (200):
    { "success": true, "message": "Reservation status updated" }

- DELETE /api/reservations/draft/:conversationId
  - Auth: yes
  - Response: JSON from deleteDraftHandler
  - Example response (200):
    { "success": true, "message": "Draft deleted" }

### Errors

- 404: JSON { error, message }
- 500: JSON { error, message }

## 📱 WhatsApp Sessions API

Gestión de sesiones de WhatsApp (reemplaza funcionalidad WebSocket).

### GET /api/sessions
**Obtener todas las sesiones activas**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "count": 2,
    "sessions": [
      {
        "businessId": "business-123",
        "isConnected": true,
        "hasQrCode": false,
        "lastActivity": "2026-02-12T09:30:00.000Z"
      }
    ]
  }
}
```

### GET /api/sessions/:businessId/status
**Obtener estado de sesión específica**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "businessId": "business-123",
    "hasSession": true,
    "isConnected": true,
    "qrCode": null,
    "lastActivity": "2026-02-12T09:30:00.000Z",
    "sessionPath": "/auth_sessions/business-123"
  }
}
```

### GET /api/sessions/:businessId/qr
**Obtener código QR para conectar WhatsApp**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response 200 (QR disponible):**
```json
{
  "success": true,
  "data": {
    "businessId": "business-123",
    "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
    "isConnected": false
  }
}
```

**Response 404 (QR no disponible):**
```json
{
  "success": false,
  "error": "QR code not available",
  "message": "Session may be connected or QR not generated yet"
}
```

### POST /api/sessions/:businessId/start
**Iniciar sesión de WhatsApp**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response 200:**
```json
{
  "success": true,
  "message": "Session start requested",
  "data": {
    "businessId": "business-123",
    "status": "starting"
  }
}
```

### POST /api/sessions/:businessId/stop
**Detener sesión de WhatsApp**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response 200:**
```json
{
  "success": true,
  "message": "Session stopped",
  "data": {
    "businessId": "business-123",
    "status": "stopped"
  }
}
```

## 💬 WhatsApp Messages API

Gestión de mensajes de WhatsApp.

### GET /api/messages/:businessId
**Obtener mensajes recientes**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Query Parameters:**
- `limit` (optional): Número de mensajes (default: 50, max: 100)
- `offset` (optional): Offset para paginación (default: 0)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "businessId": "business-123",
    "messages": [
      {
        "from": "+5491234567890",
        "message": "Hola, necesito una mesa",
        "timestamp": "2026-02-12T09:30:00.000Z",
        "businessId": "business-123",
        "fromMe": false,
        "type": "received"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "count": 1
    }
  }
}
```

### POST /api/messages/:businessId/send
**Enviar mensaje vía WhatsApp**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

**Body:**
```json
{
  "to": "+5491234567890",
  "message": "Tu mesa está lista. Mesa 5, por favor."
}
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "businessId": "business-123",
    "to": "+5491234567890",
    "message": "Tu mesa está lista. Mesa 5, por favor.",
    "timestamp": "2026-02-12T09:35:00.000Z"
  }
}
```

**Response 400 (sesión no conectada):**
```json
{
  "success": false,
  "error": "WhatsApp session not connected",
  "message": "Session exists but is not connected to WhatsApp"
}
```

### GET /api/messages/:businessId/stats
**Obtener estadísticas de mensajes**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "businessId": "business-123",
    "stats": {
      "totalMessages": 156,
      "messagesLastHour": 5,
      "messagesLastDay": 28,
      "recentMessagesSample": [
        {
          "from": "+5491234567890",
          "message": "Gracias!",
          "timestamp": "2026-02-12T09:30:00.000Z"
        }
      ]
    }
  }
}
```

### DELETE /api/messages/:businessId
**Limpiar caché de mensajes**

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response 200:**
```json
{
  "success": true,
  "message": "Messages cleared",
  "data": {
    "businessId": "business-123"
  }
}
```

## 🔄 Polling en Frontend

Para reemplazar la funcionalidad tiempo real de WebSockets, implementa polling:

**Ejemplo JavaScript:**
```javascript
// Polling para estado de sesión y QR code
async function checkSessionStatus(businessId) {
  try {
    const response = await fetch(`/api/sessions/${businessId}/status`, {
      headers: {
        'Authorization': 'Bearer YOUR_API_KEY'
      }
    });
    const data = await response.json();
    
    if (data.success) {
      // Actualizar UI con estado de sesión
      if (!data.data.isConnected && data.data.qrCode) {
        // Mostrar QR code
        displayQRCode(data.data.qrCode);
      } else if (data.data.isConnected) {
        // Sesión conectada, ocultar QR
        hideQRCode();
      }
    }
  } catch (error) {
    console.error('Error checking session status:', error);
  }
}

// Polling para mensajes nuevos
async function checkNewMessages(businessId, lastMessageTimestamp) {
  try {
    const response = await fetch(`/api/messages/${businessId}?limit=10`, {
      headers: {
        'Authorization': 'Bearer YOUR_API_KEY'
      }
    });
    const data = await response.json();
    
    if (data.success) {
      // Filtrar mensajes más nuevos que lastMessageTimestamp
      const newMessages = data.data.messages.filter(
        msg => new Date(msg.timestamp) > lastMessageTimestamp
      );
      
      if (newMessages.length > 0) {
        // Procesar mensajes nuevos
        handleNewMessages(newMessages);
      }
    }
  } catch (error) {
    console.error('Error checking messages:', error);
  }
}

// Configurar polling intervals
setInterval(() => checkSessionStatus('your-business-id'), 3000); // Cada 3 segundos
setInterval(() => checkNewMessages('your-business-id', lastTimestamp), 10000); // Cada 10 segundos
```
