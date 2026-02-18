# 🎯 Implementación: Sistema de Auto-Aceptación de Reservas

## 📋 Resumen

Se implementó exitosamente un sistema condicional de aprobación de reservas basado en el campo `auto_accept_reservations` de la tabla `businesses`.

### ✨ Características Implementadas

#### 1. **Aprobación Condicional de Reservas**
- Si `auto_accept_reservations = true`: Reserva se crea con estado **NOTIFIED** (confirmada automáticamente)
- Si `auto_accept_reservations = false`: Reserva se crea con estado **WAITING** (requiere aprobación manual)

#### 2. **Mensajes Dinámicos**
- Mensajes personalizados según tipo de negocio (restaurante, salón, bar, etc.)
- Contenido diferente según el estado de aprobación:
  - **Auto-aceptada**: "¡Reserva CONFIRMADA! Tu [tipo] te espera!"
  - **Pendiente**: "Reserva RECIBIDA. Le notificaremos cuando confirmen."

#### 3. **Notificaciones Automáticas por WhatsApp**
- Listener de Supabase Realtime escucha cambios en `waitlist_entries`
- Cuando status cambia de **WAITING → NOTIFIED**, envía automáticamente:
  - Mensaje de confirmación al cliente
  - Información de código, posición y zona
  - Se activa desde el frontend cuando el negocio aprueba la reserva

---

## 🗂️ Archivos Modificados

### 1. `/src/types/supabase.ts`
**Cambio:** Agregado campo `auto_accept_reservations` al tipo `businesses`

```typescript
businesses: {
  Row: {
    // ... campos existentes
    auto_accept_reservations: boolean | null
  }
}
```

### 2. `/src/services/supabase.service.ts`
**Cambios en:** `createReservation()`

- Obtiene configuración del negocio antes de crear la reserva
- Establece `status` condicional: `'NOTIFIED'` o `'WAITING'`
- Establece `notified_at` si `auto_accept = true`

**Código clave:**
```typescript
const business = await this.getBusinessById(request.businessId);
const autoAccept = business?.auto_accept_reservations ?? false;

const initialStatus: WaitlistStatus = autoAccept ? 'NOTIFIED' : 'WAITING';
const notifiedAt = autoAccept ? new Date().toISOString() : null;
```

### 3. `/src/services/whatsapp-handler.service.ts`
**Cambios en:** `createAndNotifyReservation()`

- Obtiene configuración del negocio (`auto_accept_reservations` y `type`)
- Genera mensaje condicional basado en `autoAccept`
- Usa `businessType` para mensajes dinámicos

**Mensajes:**
- **Auto-aceptada:** "✅ ¡Reserva CONFIRMADA! ... ✨ Tu [tipo] te espera!"
- **Pendiente:** "⏳ Reserva RECIBIDA ... ⏰ Le notificaremos cuando confirmen"

### 4. `/src/services/realtime-sync.service.ts`
**Nuevos métodos:**

#### `subscribeToWaitlistEntries()`
- Subscripción a eventos UPDATE en tabla `waitlist_entries`
- Se activa automáticamente al iniciar el servidor

#### `handleWaitlistStatusChange()`
- Detecta cambios de estado WAITING → NOTIFIED
- Obtiene datos del cliente y negocio
- Construye mensaje de confirmación dinámico
- Envía notificación por WhatsApp automáticamente

**Flujo:**
```
Frontend cambia status → Supabase Realtime → Handler → WhatsApp al cliente
```

### 5. `/src/agents/waitlist.agent.ts`
**Cambio:** Documentación actualizada

Agregada nota en PASO 4 (confirmation):
> "El sistema determinará automáticamente si la reserva se confirma de inmediato o requiere aprobación manual, basándose en la configuración del negocio"

---

## 🔧 Migración de Base de Datos

### Ejecutar Migración

```bash
# Opción 1: Desde Supabase Dashboard
# Ir a SQL Editor y ejecutar:
/root/ia-server/migrations/add-auto-accept-reservations.sql

# Opción 2: Desde CLI (si tienes Supabase CLI instalado)
supabase db push
```

### Configurar Negocios

```sql
-- Activar auto-aceptación para un negocio específico
UPDATE businesses 
SET auto_accept_reservations = true 
WHERE id = 'tu-business-id';

-- Activar para todos los restaurantes
UPDATE businesses 
SET auto_accept_reservations = true 
WHERE type = 'restaurant';

-- Ver estado actual
SELECT id, name, type, auto_accept_reservations FROM businesses;
```

---

## 🧪 Pruebas

### Test 1: Reserva Auto-Aceptada

```sql
-- Configurar negocio con auto-aceptación
UPDATE businesses SET auto_accept_reservations = true WHERE id = 'test-business-id';
```

**Pasos:**
1. Enviar mensaje WhatsApp: "Quiero reservar"
2. Completar flujo: nombre, cantidad de personas, zona
3. **Verificar:**
   - ✅ Reserva creada con `status = 'NOTIFIED'`
   - ✅ Campo `notified_at` tiene timestamp
   - ✅ Mensaje recibido: "¡Reserva CONFIRMADA! ... Tu restaurante te espera!"

### Test 2: Reserva con Aprobación Manual

```sql
-- Configurar negocio sin auto-aceptación
UPDATE businesses SET auto_accept_reservations = false WHERE id = 'test-business-id';
```

**Pasos:**
1. Enviar mensaje WhatsApp: "Quiero hacer una reserva"
2. Completar flujo: nombre, cantidad de personas, zona
3. **Verificar:**
   - ✅ Reserva creada con `status = 'WAITING'`
   - ✅ Campo `notified_at` es `null`
   - ✅ Mensaje recibido: "Reserva RECIBIDA ... Le notificaremos cuando confirmen"

### Test 3: Notificación Automática desde Frontend

**Pasos:**
1. Crear reserva con `auto_accept = false` (quedará en WAITING)
2. Desde Supabase Dashboard o Frontend, cambiar status a NOTIFIED:
   ```sql
   UPDATE waitlist_entries 
   SET status = 'NOTIFIED', notified_at = NOW() 
   WHERE id = 'entry-id';
   ```
3. **Verificar:**
   - ✅ Cliente recibe mensaje automático por WhatsApp
   - ✅ Mensaje: "¡Tu reserva está CONFIRMADA! ... Tu [tipo] te espera!"
   - ✅ Logs del servidor muestran: "Waitlist status changed to NOTIFIED"

### Test 4: Tipos de Negocio Dinámicos

**Pasos:**
1. Crear negocios con diferentes tipos: `restaurant`, `salon`, `bar`, `cafe`
2. Crear reservas en cada uno
3. **Verificar que los mensajes usan:**
   - "Tu restaurante te espera"
   - "Tu salón te espera"
   - "Tu bar te espera"
   - "Tu cafe te espera"

---

## 📊 Monitoreo

### Logs Importantes

El sistema genera logs detallados para debugging:

```typescript
// Al crear reserva
logger.info('⚙️ Getting business configuration...', { 
  businessId, 
  autoAcceptReservations 
});

// Al enviar mensaje
logger.info('Building confirmation message', {
  businessId,
  autoAccept,
  businessType,
  status
});

// Al detectar cambio de estado
logger.info('🔔 Waitlist status changed to NOTIFIED', {
  entryId,
  businessId,
  customerId,
  displayCode,
  oldStatus,
  newStatus
});
```

### Verificar Listener Activo

Al iniciar el servidor, deberías ver:

```
[INFO] 🔄 Initializing realtime synchronization...
[INFO] ✅ Subscribed to businesses realtime changes
[INFO] ✅ Subscribed to zones realtime changes
[INFO] ✅ Subscribed to tables realtime changes
[INFO] ✅ Subscribed to waitlist_entries realtime changes for auto-notifications
[INFO] ✅ Realtime sync initialized successfully
```

---

## 🛡️ Manejo de Errores

### Fallbacks Implementados

1. **Si `auto_accept_reservations` es `null` o `undefined`:**
   - Usa `false` (requiere aprobación manual)
   - `const autoAccept = business?.auto_accept_reservations ?? false;`

2. **Si `type` del negocio es `null`:**
   - Usa "negocio" como texto genérico
   - `const businessType = business?.type || 'negocio';`

3. **Si falla envío de WhatsApp:**
   - Se registra en logs pero no bloquea la creación de reserva
   - Se guarda notificación en Redis para que frontend la vea

4. **Si falla listener de Realtime:**
   - Try-catch envuelve todo el handler
   - Log detallado del error pero no afecta otros listeners

---

## 🔄 Flujo Completo

### Escenario 1: Auto-Aceptación Activada

```
Usuario WhatsApp
    ↓
"Quiero reservar" → Agente detecta CREATE_RESERVATION
    ↓
Flujo multi-paso: nombre → personas → zona
    ↓
createReservation() → autoAccept = true
    ↓
INSERT waitlist_entry { status: 'NOTIFIED', notified_at: NOW() }
    ↓
Mensaje: "✅ Reserva CONFIRMADA! Tu restaurante te espera!"
    ↓
Usuario puede ir directamente
```

### Escenario 2: Aprobación Manual

```
Usuario WhatsApp
    ↓
"Quiero reservar" → Agente detecta CREATE_RESERVATION
    ↓
Flujo multi-paso: nombre → personas → zona
    ↓
createReservation() → autoAccept = false
    ↓
INSERT waitlist_entry { status: 'WAITING', notified_at: null }
    ↓
Mensaje: "⏳ Reserva RECIBIDA. Le notificaremos cuando confirmen"
    ↓
Usuario espera confirmación
    ↓
[ Frontend aprueba: UPDATE status = 'NOTIFIED' ]
    ↓
Supabase Realtime → handleWaitlistStatusChange()
    ↓
Mensaje automático: "✅ Tu reserva está CONFIRMADA! Tu restaurante te espera!"
    ↓
Usuario puede ir
```

---

## ✅ Checklist de Implementación

- [x] Tipos TypeScript actualizados con `auto_accept_reservations`
- [x] Lógica condicional en `createReservation()`
- [x] Mensajes dinámicos en `createAndNotifyReservation()`
- [x] Listener de Realtime para `waitlist_entries`
- [x] Handler de cambio de estado WAITING → NOTIFIED
- [x] Invalidación de cache al cambiar configuración
- [x] Manejo de errores robusto con fallbacks
- [x] Compilación exitosa sin errores TypeScript
- [x] Migración SQL creada
- [x] Documentación actualizada

---

## 🚀 Próximos Pasos

1. **Ejecutar migración SQL:**
   ```bash
   # En Supabase Dashboard > SQL Editor
   # Ejecutar: /root/ia-server/migrations/add-auto-accept-reservations.sql
   ```

2. **Reiniciar servidor:**
   ```bash
   npm run build
   npm start
   # o con PM2:
   pm2 restart ia-server
   ```

3. **Configurar negocios:**
   - Actualizar `auto_accept_reservations` según necesidad de cada negocio

4. **Probar flujos:**
   - Test con auto-aceptación activada
   - Test con aprobación manual
   - Test de notificación automática desde frontend

5. **Monitorear logs:**
   - Verificar que listener esté activo
   - Revisar mensajes enviados correctamente

---

## 📞 Soporte

Para cualquier issue o duda:
1. Revisar logs del servidor: `pm2 logs ia-server`
2. Verificar estado de subscripciones: buscar "Subscribed to waitlist_entries"
3. Probar con Supabase Dashboard para simular cambios de estado

---

**Implementación completada exitosamente! 🎉**
