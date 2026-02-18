# 🔧 Generación de Tipos desde Supabase

Este proyecto ofrece **dos métodos** para generar tipos de TypeScript desde tu esquema de Supabase.

## 📋 Tabla de Contenidos

- [Método 1: Script Automático (Recomendado)](#método-1-script-automático-recomendado)
- [Método 2: Supabase CLI](#método-2-supabase-cli)
- [Comparación](#comparación)
- [Solución de Problemas](#solución-de-problemas)

---

## Método 1: Script Automático (Recomendado) 🚀

**Ventajas:**
- ✅ No requiere Access Token
- ✅ Usa tu Service Role Key existente
- ✅ Funciona inmediatamente
- ✅ Infiere tipos directamente de los datos

**Requisitos:**
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-key
```

**Uso:**
```bash
npm run types:generate
```

**¿Cómo funciona?**

El script [scripts/generate-types.ts](scripts/generate-types.ts):
1. Se conecta a Supabase usando tu Service Role Key
2. Lee una fila de muestra de cada tabla
3. Infiere los tipos de TypeScript desde los datos
4. Genera el archivo [src/types/supabase.ts](src/types/supabase.ts)

**Limitaciones:**
- Los tipos se infieren desde los datos existentes
- Tablas vacías pueden no generarse correctamente
- Campos nullable pueden requerir ajuste manual

---

## Método 2: Supabase CLI 🛠️

**Ventajas:**
- ✅ Tipos más precisos (lee el schema real)
- ✅ Soporta enums, views y functions
- ✅ Método oficial de Supabase

**Requisitos:**

1. **Instalar Supabase CLI:**
   ```bash
   # Ya está instalado en /usr/local/bin/supabase
   supabase --version
   ```

2. **Obtener Access Token:**
   
   a. Ve a: https://app.supabase.com/account/tokens
   
   b. Haz clic en "Generate new token"
   
   c. Dale un nombre (ej: "CLI Token - Server")
   
   d. Copia el token (se muestra solo una vez)
   
   e. Agrégalo a tu `.env`:
   ```env
   SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxxxxxxx...
   SUPABASE_PROJECT_ID=your-project-id
   ```

3. **Autenticar CLI:**
   ```bash
   supabase login
   ```

**Uso:**
```bash
npm run supabase:gen
```

O manualmente:
```bash
supabase gen types typescript \
  --project-id $SUPABASE_PROJECT_ID \
  --schema public > src/types/supabase.ts
```

---

## 📊 Comparación

| Característica | Script Automático | Supabase CLI |
|----------------|------------------|--------------|
| **Requiere Access Token** | ❌ No | ✅ Sí |
| **Precisión de tipos** | 🟡 Buena | 🟢 Excelente |
| **Facilidad de setup** | 🟢 Inmediato | 🟡 Requiere config |
| **Soporta enums** | ❌ No | ✅ Sí |
| **Soporta views** | ❌ No | ✅ Sí |
| **Soporta functions** | ❌ No | ✅ Sí |
| **CI/CD friendly** | 🟢 Sí (con Service Key) | 🟡 Sí (con Access Token) |

---

## 🔄 Workflow Recomendado

### Desarrollo Local
```bash
# Usa el script automático para desarrollo rápido
npm run types:generate
```

### Producción / CI/CD
```bash
# Si tienes Access Token configurado
npm run supabase:gen

# Si solo tienes Service Role Key
npm run types:generate
```

---

## 🐛 Solución de Problemas

### Error: "Access token not provided"

**Solución:** Usa el script automático en su lugar:
```bash
npm run types:generate
```

O configura el Access Token como se explicó arriba.

### Error: "Table is empty"

El script automático requiere al menos una fila en cada tabla para inferir tipos.

**Solución:**
1. Inserta datos de prueba en las tablas vacías
2. Ejecuta `npm run types:generate`
3. Elimina los datos de prueba si es necesario

### Error: "Cannot connect to Supabase"

Verifica que:
- `SUPABASE_URL` esté configurado correctamente
- `SUPABASE_KEY` sea tu **Service Role Key** (no Anon Key)
- Las RLS policies permitan acceso al service role

### Tipos incorrectos generados

Si el script automático genera tipos incorrectos:

**Opción 1:** Edita manualmente [src/types/supabase.ts](src/types/supabase.ts)

**Opción 2:** Configura el Access Token y usa Supabase CLI:
```bash
npm run supabase:gen
```

---

## 📝 Nota sobre Service Role vs Access Token

| Concepto | Propósito | Ubicación |
|----------|-----------|-----------|
| **Service Role Key** | Autenticar tu **aplicación** con la API de Supabase | Project Settings → API → `service_role` |
| **Access Token** | Autenticar la **CLI** con tu **cuenta** de Supabase | Account Settings → Access Tokens |

Son dos cosas completamente diferentes. El Service Role Key NO puede usarse para autenticar la CLI.

---

## 🎯 Recomendación Final

**Para la mayoría de casos:**
```bash
npm run types:generate
```

Es suficiente, rápido y no requiere configuración adicional.

**Solo usa Supabase CLI si:**
- Necesitas soportar enums, views o functions
- Quieres los tipos más precisos posibles
- Ya tienes el Access Token configurado

---

Para más información, consulta:
- [Supabase CLI Documentation](https://supabase.com/docs/guides/cli)
- [TypeScript Support](https://supabase.com/docs/guides/api/generating-types)
- [Comparación de Enfoques de Validación](docs/SUPABASE_TYPES_COMPARISON.md) - Mejor práctica para usar tipos en operaciones
