---
description: "Use when creating or modifying controllers in src/controllers/ or services in src/services/. Covers handler naming, service class patterns, try-catch, performance tracking, and typed responses."
applyTo: "src/{controllers,services}/**"
---
# Convenciones de Controllers y Services

## Controllers

Cada handler sigue este patrón:

```typescript
import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { myService } from '../services/my.service';

export async function myEntityHandler(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  const { phone, businessId } = req.body as MySchema;

  try {
    const result = await myService.doSomething(phone, businessId);

    logger.info('myEntity completado', {
      phone,
      businessId,
      duration: `${Date.now() - start}ms`,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('myEntity falló', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      phone,
      businessId,
    });
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process request',
    });
  }
}
```

**Reglas:**
- Nombre siempre `<entidad>Handler`.
- Medir duración en toda operación que llame a servicios externos.
- Nunca poner lógica de negocio en el controller; delegar al service.
- Siempre retornar explícitamente (`res.json(...)` o `res.status(...).json(...)`).

## Services

```typescript
import { logger } from '../utils/logger';

export class MyService {
  async doSomething(phone: string, businessId: string): Promise<MyResult> {
    // lógica de negocio pura
    return result;
  }
}

// Singleton al final del archivo
export const myService = new MyService();
```

**Reglas:**
- Sin imports de `express` en services.
- Todos los métodos `async`, tipos de retorno explícitos.
- Degradación silenciosa para dependencias externas (Redis, caché).
- Logger con objeto estructurado, nunca template strings.

## Respuestas HTTP

| Caso | Status | Body |
|------|--------|------|
| Éxito | 200 | `{ success: true, data: ... }` |
| Creado | 201 | `{ success: true, data: ... }` |
| Validación | 400 | `{ error: string, message: string, details?: ... }` |
| No autorizado | 401 | `{ error: 'Unauthorized' }` |
| No encontrado | 404 | `{ error: 'Not Found', message: string }` |
| Error servidor | 500 | `{ error: 'Internal Server Error', message: string }` |
