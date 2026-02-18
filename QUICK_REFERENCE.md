# 📚 Guía Rápida - Funciones Principales

## WhatsApp Handler Service

### `private processAction()`
**Línea:** 400-440  
**Propósito:** Switch explícito que enruta a 5 handlers según tipo de acción  

```typescript
switch (action) {
  case 'CREATE_RESERVATION': handleCreateReservation(...)
  case 'CHECK_STATUS': handleCheckStatus(...)
  case 'CONFIRM_ARRIVAL': handleConfirmArrival(...)
  case 'CANCEL': handleCancel(...)
  case 'INFO_REQUEST': handleInfoRequest(...)
}
```

---

### `private async handleCreateReservation()`
**Línea:** 447-468  
**Propósito:** Inicia flujo de reserva multi-paso  

**Qué hace:**
1. Obtiene nombre del negocio via `SupabaseService.getBusinessById()`
2. Verifica zonas disponibles via `ReservationService.getAvailableZones()`
3. Inicia flujo multi-paso via `ReservationService.startReservation()`

**Datos pasados:**
- `businessName`: Nombre del restaurante para personalizar respuesta
- `zones`: Array de zonas disponibles

**Logs:** Registra inicio del flujo con nombre del negocio

---

### `private async handleCheckStatus()`
**Línea:** 476-505  
**Propósito:** Consultar estado de reserva existente  

**Qué hace:**
1. Obtiene cliente via `SupabaseService.getOrCreateCustomer()` con teléfono
2. Busca reserva activa **(status='WAITING')**
3. Retorna posición y código de reserva

**Query Supabase:**
```sql
SELECT * FROM waitlist_entries 
WHERE business_id = ? 
  AND customer_id = ? 
  AND status = 'WAITING'
ORDER BY created_at DESC
LIMIT 1
```

**Datos retornados:**
- `position`: Posición en lista
- `display_code`: Código para cliente
- `created_at`: Cuándo se hizo la reserva

---

### `private async handleConfirmArrival()`
**Línea:** 513-543  
**Propósito:** Marcar cliente como presente  

**Qué hace:**
1. Obtiene cliente por teléfono
2. Busca reserva activa (status='WAITING')
3. Actualiza status a **'NOTIFIED'**

**Estado del cliente:**
- Antes: `WAITING` (esperando en lista)
- Después: `NOTIFIED` (ha llegado, espera ser llamado)

**Logs:** Registra código de reserva confirmada

---

### `private async handleCancel()`
**Línea:** 551-586  
**Propósito:** Cancelar reserva existente  

**Qué hace:**
1. Obtiene cliente por teléfono
2. Busca reservas activas (status IN ['WAITING', 'NOTIFIED'])
3. Actualiza status a **'CANCELLED'**

**Estados válidos para cancelar:**
- `WAITING`: Aún no llamado
- `NOTIFIED`: Ya ha llegado pero no comprobó

**No se pueden cancelar:**
- `SEATED`: Ya sentado en mesa
- `NO_SHOW`: No se presentó
- `CANCELLED`: Ya está cancelada

---

### `private async handleInfoRequest()`
**Línea:** 594-619  
**Propósito:** Proporcionar información general del negocio  

**Qué hace:**
1. Obtiene datos del negocio via `SupabaseService.getBusinessById()`
2. Consulta tipos de mesas via `SupabaseService.getTableTypesByBusiness()`
3. Retorna información de capacidades

**Información proporcionada:**
- Nombre del negocio
- Teléfono de contacto
- Tipos de mesas disponibles (con capacidad min/max)
- Zonas disponibles

**Tabla Consultada:**
```
Businesses: {
  id, name, phone, whatsapp_phone, 
  whatsapp_enabled, whatsapp_qr, ...
}

TableTypes: {
  id, business_id, name, 
  capacity_min, capacity_max, zone, priority, ...
}
```

---

## Cambios en `processMessage()`
**Línea:** 65-80  

**Adición: Obtener businessName**
```typescript
const business = await SupabaseService.getBusinessById(businessId);
const businessName = business?.name || 'el restaurante';

const context: any = {
  businessId,
  businessName,  // ← NUEVO
  phone,
  hasActiveDraft: !!draft,
};
```

**Por qué:**
El Agent ahora recibe el nombre del negocio en el contexto para:
- Personalizar saludo: *"Bienvenido a [NEGOCIO]"*
- Personalizar confirmación: *"Reserva confirmada en [NEGOCIO]"*
- Mencionar en advertencias: *"[NEGOCIO] no está disponible"*

---

## Cambios en `waitlist.agent.ts`

### Actualización del SystemPrompt

**Antigua presentación:**
```
"¿Cuál es tu nombre completo?"
```

**Nueva presentación:**
```
"Hola! 👋 Bienvenido a [NOMBRE_NEGOCIO]. ¿Cuál es tu nombre completo?"
```

**Antigua confirmación:**
```
"Perfecto, [NOMBRE] para [CANTIDAD] personas en [ZONA]. ¡Reserva confirmada! ✅"
```

**Nueva confirmación:**
```
"Perfecto, [NOMBRE] para [CANTIDAD] personas en [ZONA] en [NOMBRE_NEGOCIO]. ¡Reserva confirmada! ✅"
```

**Regla agregada:**
```
IMPORTANTE:
- SIEMPRE menciona el nombre del negocio en respuestas importantes
```

---

## Flujo de Base de Datos

### Para CREATE_RESERVATION:
```
1. ReservationService.startReservation()
   └─ Creates draft in Redis with step='name'
   
2. processDraftStep() in subsequent messages
   └─ name → party_size → zone_selection → confirmation
   
3. ReservationService.createReservation()
   └─ INSERT INTO waitlist_entries(...)
   └─ status = 'WAITING'
```

### Para CHECK_STATUS:
```
1. SupabaseService.getOrCreateCustomer(name, phone, businessId)
   └─ SELECT * FROM customers WHERE phone=? AND business_id=?
   └─ If not exists: INSERT
   
2. Query waitlist_entries WHERE customer_id=? AND status='WAITING'
   └─ Returns position, display_code, estimated_wait
```

### Para CANCEL:
```
1. SupabaseService.getOrCreateCustomer(name, phone, businessId)
   
2. Query waitlist_entries WHERE status IN ('WAITING', 'NOTIFIED')
   
3. SupabaseService.updateReservationStatus(entryId, 'CANCELLED')
   └─ UPDATE waitlist_entries SET status='CANCELLED', updated_at=NOW()
```

### Para CONFIRM_ARRIVAL:
```
1. SupabaseService.getOrCreateCustomer(name, phone, businessId)
   
2. Query waitlist_entries WHERE status='WAITING'
   
3. SupabaseService.updateReservationStatus(entryId, 'NOTIFIED')
   └─ UPDATE waitlist_entries SET status='NOTIFIED', updated_at=NOW()
```

### Para INFO_REQUEST:
```
1. SupabaseService.getBusinessById(businessId)
   └─ SELECT * FROM businesses WHERE id=?
   
2. SupabaseService.getTableTypesByBusiness(businessId)
   └─ SELECT * FROM table_types WHERE business_id=?
   
3. Return: name, phone, table_types[].{name, capacity_min, capacity_max, zone}
```

---

## Estados de Reserva en Supabase

```typescript
type WaitlistStatus = 'WAITING' | 'NOTIFIED' | 'SEATED' | 'CANCELLED' | 'NO_SHOW';

// Flujo típico:
'WAITING' (creada)
    ↓
'NOTIFIED' (cliente confirma llegada)
    ↓
'SEATED' (colocado en mesa)
    ↓
[Completada]

// Flujo cancelado:
'WAITING' / 'NOTIFIED'
    ↓
'CANCELLED' (usuario en handleCancel)
    ↓
[Cerrada]
```

---

## Validaciones Importantes

### En CREATE_RESERVATION:
```typescript
✓ Verificar negocio activo (en processMessage)
✓ Verificar zonas disponibles
✓ Iniciar draft en Redis (multi-step)
```

### En CHECK_STATUS:
```typescript
✓ Encontrar cliente por ID + businessId
✓ Buscar SOLO reservas status='WAITING'
✓ Si no existe: Agent responde sin error (graceful)
```

### En CANCEL:
```typescript
✓ Buscar en status=['WAITING', 'NOTIFIED']
✓ Rechazar si ya está SEATED o CANCELLED
✓ Actualizar timestamp
```

### En CONFIRM_ARRIVAL:
```typescript
✓ Cambiar status a NOTIFIED (notificar a staff)
✓ Mantener campos originales (name, partySize, zone)
✓ Registrar timestamp de confirmación
```

---

## Próximas Mejoras Requeridas

### 1. **Filtración de Mesas por Tamaño**
```typescript
// Por implementar en handleCreateReservation
private filterTablesByPartySize(tableTypes: TableType[], partySize: number): TableType[] {
  return tableTypes.filter(table => 
    partySize >= table.capacity_min && 
    partySize <= table.capacity_max
  );
}
```

### 2. **Notificaciones WebSocket**
```typescript
// Agregar después de cada updateReservationStatus
this.io.to(`business-${businessId}`).emit('reservation:updated', {
  displayCode: reservation.display_code,
  newStatus: 'NOTIFIED',
  customerName: customer.name
});
```

### 3. **Estimación de Tiempo**
```typescript
// En handleCheckStatus
const estimatedWait = position * 20; // 20 min por persona
response.estimatedWait = `${estimatedWait} minutos`;
```

---

## Testing Manual

### Test 1: Criar Reserva
```bash
curl -X POST http://localhost:4000/api/agents/waitlist/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "message": "Quiero reservar",
    "conversationId": "user-001",
    "context": {
      "businessId": "business-123",
      "phone": "+56912345678"
    }
  }'

# Respuesta esperada:
# "Hola! 👋 Bienvenido a Don Pepe. ¿Cuál es tu nombre?"
# "action": "CREATE_RESERVATION"
```

### Test 2: Consultar Estado
```bash
curl -X POST http://localhost:4000/api/agents/waitlist/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "message": "Cuál es mi posición?",
    "conversationId": "user-001"
  }'

# Respuesta esperada:
# "Estás en posición 3 de 8 en Don Pepe"
# "action": "CHECK_STATUS"
```

### Test 3: Cancelar
```bash
curl -X POST http://localhost:4000/api/agents/waitlist/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "message": "Cancela mi reserva",
    "conversationId": "user-001"
  }'

# Respuesta esperada:
# "Tu reserva en Don Pepe ha sido cancelada"
# "action": "CANCEL"
```

---

**Última actualización:** 2024  
**Versión:** 1.0.0  
**Estado:** ✅ Producción
