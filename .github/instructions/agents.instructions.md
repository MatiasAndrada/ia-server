---
description: "Use when creating or modifying agents in src/agents/. Covers AgentConfig structure, action definitions, system prompt conventions, temperature settings, and agent registry patterns."
applyTo: "src/agents/**"
---
# Convenciones de Agentes IA

## Estructura de AgentConfig

Todo agente debe implementar la interfaz `AgentConfig` completa:

```typescript
export const myAgent: AgentConfig = {
  id: 'my-agent',            // kebab-case, único
  name: 'Nombre Legible',
  description: 'Descripción de una línea',
  model: 'llama3.2',         // modelo por defecto
  temperature: 0.2,          // ≤0.3 para flujos deterministas
  maxTokens: 250,
  enabled: true,
  systemPrompt: `...`,
  actions: [...],
};
```

## Temperatura

- **≤0.3** para flujos de reservas, extracción de datos, formularios.
- **0.5–0.7** para conversación general o respuestas creativas.
- Nunca superar 0.8 en agentes de producción.

## Actions

Cada acción debe tener `type`, `priority`, `keywords` y `description`:

```typescript
actions: [
  {
    type: 'CREATE_RESERVATION',   // SCREAMING_SNAKE_CASE
    priority: 1,                  // 1 = más alta prioridad
    keywords: ['reserv', 'mesa'], // stemmed/partial match ok
    description: 'Crear nueva reserva',
  },
]
```

- Ordenar por `priority` ascendente (1 = primera).
- Keywords: palabras parciales en minúsculas para matching flexible.

## System Prompts

- Incluir siempre el nombre del negocio via placeholder `{businessName}`.
- Definir flujo explícito numerado cuando el agente sigue pasos.
- Limitar tokens del prompt; preferir instrucciones concisas.

## Registro Central

Exportar el agente e importarlo en `src/agents/index.ts`:

```typescript
// agents/index.ts
import { myAgent } from './my.agent';
export const agentRegistry = new AgentRegistry([waitlistAgent, myAgent]);
```
