# ia-server — Instrucciones de Workspace

Servidor REST de IA para WhatsApp construido con **Express + TypeScript + Ollama + Supabase + Redis**.
Arquitectura en capas: `routes → middleware → controllers → services → config`.

---

## Arquitectura & Capas

- **`src/controllers/`** — Handlers HTTP. Reciben `Request/Response`, delegan lógica a services.
- **`src/services/`** — Lógica de negocio. Clases con métodos async. Sin dependencias de Express.
- **`src/routes/`** — Definición de rutas Express. Solo registran middleware + controller.
- **`src/middleware/`** — Auth, validación Zod, rate limiting.
- **`src/agents/`** — Configuraciones de agentes IA (`AgentConfig`). Registro central en `agents/index.ts`.
- **`src/types/`** — Interfaces TypeScript en `types/index.ts`. Tipos Supabase auto-generados en `types/supabase.ts`.
- **`src/config/`** — Singletons de clientes (Redis, Supabase, Ollama axios).
- **`src/utils/`** — Logger Winston, prompt builders, formatters.

---

## Convenciones TypeScript

- **Strict mode activo**. Nunca usar `any` implícito. Tipar todos los parámetros y retornos.
- Preferir `interface` sobre `type` para objetos reutilizables.
- Centralizar interfaces en `src/types/index.ts`.
- Nunca dejar variables o parámetros sin uso (`noUnusedLocals`, `noUnusedParameters`).
- `noImplicitReturns`: todas las ramas de control deben retornar explícitamente.

---

## Nomenclatura

- **Controllers**: funciones exportadas named `async function <nombre>Handler(req: Request, res: Response)`.
- **Services**: clases con métodos `async`. Instanciadas como singletons al final del archivo (`export const myService = new MyService()`).
- **Rutas**: archivos `<dominio>.routes.ts`. Exportan `Router`.
- **Schemas Zod**: `const <nombre>Schema = z.object({...})` en `middleware/validation.middleware.ts`.
- **Keys de Redis**: prefijo `<dominio>:<identificador>` (ej. `conversation:phone`).

---

## Manejo de Errores

Siempre usar el patrón **try-catch con typed error**:

```typescript
try {
  // lógica
} catch (error) {
  logger.error('Descripción del fallo', {
    error: error instanceof Error ? error.message : 'Unknown error',
    stack: error instanceof Error ? error.stack : undefined,
  });
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'Descripción clara del fallo',
  });
}
```

- Nunca lanzar strings; usar `error instanceof Error` para type-guarding.
- Errores 4xx: responder con `{ error: string, message: string, details?: ... }`.
- Errores 5xx: loguear stack, responder genérico al cliente.

---

## Logging (Winston)

- **Siempre usar logging estructurado** — objeto de contexto, nunca interpolación de strings.
- Incluir `duration` en operaciones relevantes usando `Date.now()`.

```typescript
// ✅ Correcto
logger.info('Chat procesado', { phone, businessId, duration: `${Date.now() - start}ms` });

// ❌ Incorrecto
logger.info(`Chat procesado para ${phone} en ${businessId}`);
```

- Niveles: `error` para fallos, `warn` para reintentos/degradación, `info` para flujo normal, `debug` para desarrollo.

---

## Validación de Entradas (Zod)

- **Toda entrada de usuario se valida con Zod** antes de llegar al controller.
- Schemas definidos en `middleware/validation.middleware.ts`.
- Usar la factory `validate(schema)` como middleware en las rutas.
- Formato de teléfono: siempre E.164 (`/^\+?[1-9]\d{1,14}$/`).
- `businessId`: siempre UUID (`z.string().uuid()`).

---

## Servicios Externos

### Ollama
- Usar `OllamaService.chat()` — ya maneja reintentos con backoff exponencial.
- Modelo por defecto: `llama3.2`. Cada agente puede tener su propio modelo.
- Temperatura baja (≤0.3) para respuestas deterministas en flujos de reservas.

### Redis
- Acceder vía `RedisConfig.getClient()`.
- Siempre definir TTL explícito en `setEx`.
- Manejar fallos de Redis con degradación silenciosa (retornar `[]` o `null`).

### Supabase
- Usar `supabaseService` para operaciones de BD.
- Los tipos de tablas están en `src/types/supabase.ts` (auto-generados — no editar manualmente).
- Para regenerar tipos: `npm run generate-types`.

---

## Seguridad

- Autenticación via Bearer token en `middleware/auth.middleware.ts` — toda ruta API requiere auth.
- Helmet y CORS configurados en `src/index.ts` — no desactivar.
- Rate limiting configurado en `middleware/rateLimit.middleware.ts`.
- Nunca loguear tokens, credenciales o datos sensibles.

---

## Tests

- Framework: Jest + ts-jest. Archivos en `src/__tests__/`.
- Siempre mockear servicios externos (Redis, Supabase, Ollama) en tests unitarios.
- Ejecutar: `npm test`.
