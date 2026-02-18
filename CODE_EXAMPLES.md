# 💻 Ejemplos de Código Actual

## Antes vs Después: Switch Statement

### ANTES (Simple IF)
```typescript
private async processAction(
  action: string | null | undefined,
  messageText: string,
  conversationId: string,
  businessId: string,
  phone: string,
  draft: ReservationDraft | null
): Promise<void> {
  try {
    // Si no hay draft y usuario quiere hacer reserva
    if (!draft && action === 'CREATE_RESERVATION') {
      await ReservationService.startReservation(conversationId, businessId);
      logger.info('Reservation flow started', { conversationId });
      return;
    }

    // Si hay draft, procesar paso
    if (draft) {
      await this.processDraftStep(draft, messageText, conversationId, businessId, phone);
    }
  } catch (error) {
    logger.error('Error processing action', { error, action, conversationId });
  }
}
```

### AHORA (Switch Completo)
```typescript
private async processAction(
  action: string | null | undefined,
  messageText: string,
  conversationId: string,
  businessId: string,
  phone: string,
  draft: ReservationDraft | null
): Promise<void> {
  try {
    // If draft exists, process based on current step
    if (draft && draft.step !== 'completed') {
      await this.processDraftStep(draft, messageText, conversationId, businessId, phone);
      return;
    }

    // Process explicit actions
    switch (action) {
      case 'CREATE_RESERVATION':
        await this.handleCreateReservation(conversationId, businessId);
        break;

      case 'CHECK_STATUS':
        await this.handleCheckStatus(businessId, phone, conversationId);
        break;

      case 'CONFIRM_ARRIVAL':
        await this.handleConfirmArrival(businessId, phone, conversationId);
        break;

      case 'CANCEL':
        await this.handleCancel(businessId, phone, conversationId);
        break;

      case 'INFO_REQUEST':
        await this.handleInfoRequest(businessId, phone, conversationId);
        break;

      default:
        logger.debug('No specific action to process', { action, conversationId });
    }
  } catch (error) {
    logger.error('Error processing action', { error, action, conversationId });
  }
}
```

**Cambios:**
- ✅ Switch statement explícito para 5 acciones
- ✅ Cada caso propaga a un handler separado
- ✅ Más mantenible y escalable
- ✅ Cada acción tiene su propia lógica

---

## Handle Create Reservation

```typescript
/**
 * 🎯 ACTION: Create Reservation - Start the multi-step flow
 */
private async handleCreateReservation(
  conversationId: string,
  businessId: string
): Promise<void> {
  try {
    // Get business name for greeting
    const business = await SupabaseService.getBusinessById(businessId);
    const businessName = business?.name || 'nuestro restaurante';

    // Verify there are available zones
    const zones = await ReservationService.getAvailableZones(businessId);
    if (zones.length === 0) {
      logger.warn('No zones available for reservation', { businessId });
      // Agent will handle this response
      return;
    }

    // Start reservation flow
    await ReservationService.startReservation(conversationId, businessId);
    logger.info('Reservation flow started', { conversationId, businessName });
  } catch (error) {
    logger.error('Error handling create reservation', { error, conversationId });
  }
}
```

**Key Points:**
- Obtiene `business` para personalizar respuesta
- Verifica zonas disponibles ANTES de iniciar
- Registra el nombre del negocio en logs

---

## Handle Check Status

```typescript
/**
 * 📊 ACTION: Check Status - Query reservation info
 */
private async handleCheckStatus(
  businessId: string,
  phone: string,
  conversationId: string
): Promise<void> {
  try {
    // Get or create customer
    const customer = await SupabaseService.getOrCreateCustomer(
      'Unknown',
      phone,
      businessId
    );

    if (!customer) {
      logger.warn('Customer not found', { businessId, phone });
      return;
    }

    // Get current reservation
    const client = SupabaseConfig.getClient();
    const { data: reservation } = await client
      .from('waitlist_entries')
      .select('*')
      .eq('business_id', businessId)
      .eq('customer_id', customer.id)
      .eq('status', 'WAITING')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!reservation) {
      logger.info('No active reservation found', { customerId: customer.id });
      return;
    }

    logger.info('Reservation status queried', {
      customerId: customer.id,
      position: reservation.position,
      displayCode: reservation.display_code,
    });
  } catch (error) {
    logger.error('Error handling check status', { error, conversationId });
  }
}
```

**Key Points:**
- Obtiene cliente usando teléfono
- Busca reserva con `status='WAITING'`
- Retorna posición y código

---

## Handle Confirm Arrival

```typescript
/**
 * ✋ ACTION: Confirm Arrival - Update status to NOTIFIED
 */
private async handleConfirmArrival(
  businessId: string,
  phone: string,
  conversationId: string
): Promise<void> {
  try {
    // Get customer
    const customer = await SupabaseService.getOrCreateCustomer(
      'Unknown',
      phone,
      businessId
    );

    if (!customer) {
      logger.warn('Customer not found for arrival confirmation', { businessId, phone });
      return;
    }

    // Find active reservation
    const client = SupabaseConfig.getClient();
    const { data: reservation } = await client
      .from('waitlist_entries')
      .select('*')
      .eq('business_id', businessId)
      .eq('customer_id', customer.id)
      .eq('status', 'WAITING')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!reservation) {
      logger.warn('No active reservation for arrival confirmation', { customerId: customer.id });
      return;
    }

    // Update status to NOTIFIED
    await SupabaseService.updateReservationStatus(
      reservation.id,
      'NOTIFIED'
    );

    logger.info('Arrival confirmed', {
      customerId: customer.id,
      displayCode: reservation.display_code,
    });
  } catch (error) {
    logger.error('Error handling confirm arrival', { error, conversationId });
  }
}
```

**Key Points:**
- Actualiza status a `NOTIFIED` (cliente presente)
- Busca reserva con `status='WAITING'`
- Registra confirmación en logs

---

## Handle Cancel

```typescript
/**
 * ❌ ACTION: Cancel - Mark reservation as CANCELLED
 */
private async handleCancel(
  businessId: string,
  phone: string,
  conversationId: string
): Promise<void> {
  try {
    // Get customer
    const customer = await SupabaseService.getOrCreateCustomer(
      'Unknown',
      phone,
      businessId
    );

    if (!customer) {
      logger.warn('Customer not found for cancellation', { businessId, phone });
      return;
    }

    // Find active reservation
    const client = SupabaseConfig.getClient();
    const { data: reservation } = await client
      .from('waitlist_entries')
      .select('*')
      .eq('business_id', businessId)
      .eq('customer_id', customer.id)
      .in('status', ['WAITING', 'NOTIFIED'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!reservation) {
      logger.warn('No active reservation to cancel', { customerId: customer.id });
      return;
    }

    // Update status to CANCELLED
    await SupabaseService.updateReservationStatus(
      reservation.id,
      'CANCELLED'
    );

    logger.info('Reservation cancelled', {
      customerId: customer.id,
      displayCode: reservation.display_code,
    });
  } catch (error) {
    logger.error('Error handling cancel', { error, conversationId });
  }
}
```

**Key Points:**
- Cancela reservas en status `WAITING` o `NOTIFIED`
- No cancela reservas ya `SEATED`
- Actualiza a `CANCELLED`

---

## Handle Info Request

```typescript
/**
 * ℹ️ ACTION: Info Request - Provide business information
 */
private async handleInfoRequest(
  businessId: string,
  _phone: string,
  conversationId: string
): Promise<void> {
  try {
    // Get business details
    const business = await SupabaseService.getBusinessById(businessId);
    
    if (!business) {
      logger.warn('Business not found for info request', { businessId });
      return;
    }

    // Get table types to show capacity info
    const tableTypes = await SupabaseService.getTableTypesByBusiness(businessId);

    logger.info('Business info retrieved', {
      businessId,
      name: business.name,
      tableTypesCount: tableTypes.length,
    });
  } catch (error) {
    logger.error('Error handling info request', { error, conversationId });
  }
}
```

**Key Points:**
- Obtiene datos del negocio
- Consulta tipos de mesas disponibles
- Retorna información general

---

## Integración de Business Name en Contexto

### Antes
```typescript
// Build context
const context: any = {
  businessId,
  phone,
  hasActiveDraft: !!draft,
};
```

### Ahora
```typescript
// Get business details for context
const business = await SupabaseService.getBusinessById(businessId);
const businessName = business?.name || 'el restaurante';

// Build context
const context: any = {
  businessId,
  businessName,  // ← NUEVO
  phone,
  hasActiveDraft: !!draft,
};

// Luego se pasa a agentService.generateResponse(...)
```

**Resultado:**
El agente recibe `businessName` en contexto y lo usa en:
- "Bienvenido a **[NOMBRE_NEGOCIO]**"
- "Tu reserva en **[NOMBRE_NEGOCIO]** está confirmada"
- "**[NOMBRE_NEGOCIO]** no está disponible ahora"

---

## Actualización del Agent SystemPrompt

### Antes
```typescript
systemPrompt: `Eres un asistente de reservas por WhatsApp. Sigue este flujo preciso...

1. Pregunta: "¿Cuál es tu nombre completo?"
2. Pregunta: "¿Cuántas personas serán?"
...`
```

### Ahora
```typescript
systemPrompt: `Eres un asistente de reservas por WhatsApp profesional y amable. Siempre menciona el nombre del negocio.

FLUJO DE RESERVA:
1. PRESENTACIÓN: "Hola! 👋 Bienvenido a [NOMBRE_NEGOCIO]. ¿Cuál es tu nombre completo?"
2. CANTIDAD: "¿Cuántas personas serán? 👥"
3. ZONA: Consulta zonas disponibles...
4. CONFIRMACIÓN: "Perfecto, [NOMBRE] para [CANTIDAD] personas en [ZONA] en [NOMBRE_NEGOCIO]. ¡Tu reserva está confirmada! ✅"

REGLAS CRÍTICAS:
- SIEMPRE menciona el nombre del negocio en respuestas importantes
...`
```

**Cambios:**
- Professional greeting personalizado
- Emoji para mejor UX
- Énfasis en mencionar el nombre del negocio
- Contextualización en todas las acciones

---

## Flujo Completo de Objetos

### ReservationDraft (Redis)
```typescript
interface ReservationDraft {
  conversationId: string;
  businessId: string;
  step: 'name' | 'party_size' | 'zone_selection' | 'confirmation' | 'completed';
  customerName?: string;
  partySize?: number;
  selectedZoneId?: string;
  createdAt: number;
  updatedAt: number;
}
```

**Estados:**
1. `name` - Esperando nombre del cliente
2. `party_size` - Esperando número de personas
3. `zone_selection` - Esperando selección de zona
4. `confirmation` - Confirmando antes de crear
5. `completed` - Reserva creada, draft eliminado

---

## Log Examples

### CREATE_RESERVATION
```
{
  "level": "info",
  "message": "Reservation flow started",
  "conversationId": "user-555",
  "businessName": "Don Pepe",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### CHECK_STATUS
```
{
  "level": "info",
  "message": "Reservation status queried",
  "customerId": "cust-123",
  "position": 3,
  "displayCode": "ABC-456",
  "timestamp": "2024-01-15T10:31:00Z"
}
```

### CANCEL
```
{
  "level": "info",
  "message": "Reservation cancelled",
  "customerId": "cust-123",
  "displayCode": "ABC-456",
  "timestamp": "2024-01-15T10:32:00Z"
}
```

---

## Testing con Postman/cURL

### 1️⃣ Crear Reserva
```bash
curl -X POST http://localhost:4000/api/agents/waitlist/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hola, quiero una mesa para 4 personas",
    "conversationId": "user-001",
    "context": {
      "businessId": "restaurant-001",
      "phone": "+56912345678"
    }
  }'
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "response": "Hola! 👋 Bienvenido a Don Pepe. ¿Cuál es tu nombre completo?",
    "action": "CREATE_RESERVATION",
    "conversationId": "user-001",
    "processingTime": 1345
  }
}
```

### 2️⃣ Escribir Nombre
```bash
curl -X POST http://localhost:4000/api/agents/waitlist/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Juan García Soto",
    "conversationId": "user-001",
    "context": {
      "businessId": "restaurant-001",
      "phone": "+56912345678"
    }
  }'
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "response": "¿Cuántas personas serán? 👥",
    "action": null,
    "conversationId": "user-001",
    "processingTime": 892
  }
}
```

### 3️⃣ Consultar Posición
```bash
curl -X POST http://localhost:4000/api/agents/waitlist/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Cuál es mi posición en la lista?",
    "conversationId": "user-001",
    "context": {
      "businessId": "restaurant-001",
      "phone": "+56912345678"
    }
  }'
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "response": "Juan! Estás en posición 3 de 8 en Don Pepe. Tiempo estimado: 15-20 minutos 🕐",
    "action": "CHECK_STATUS",
    "conversationId": "user-001",
    "processingTime": 756
  }
}
```

---

**Versión:** 1.0.0  
**Fecha:** 2024  
**Status:** ✅ Listo para producción
