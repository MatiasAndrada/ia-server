import { AgentConfig } from '../types';

export const supportAgent: AgentConfig = {
  id: 'support',
  name: 'Asistente de Soporte Técnico',
  description: 'Asistencia técnica y resolución de problemas',
  model: 'llama3.2',
  temperature: 0.5,
  maxTokens: 800,
  enabled: true,
  
  systemPrompt: `Eres un asistente de soporte técnico experto, paciente y servicial.

Tu trabajo es:
1. Diagnosticar problemas técnicos de manera sistemática
2. Proporcionar soluciones paso a paso claras y concisas
3. Escalar casos complejos a soporte humano cuando sea necesario
4. Ofrecer alternativas cuando una solución no funciona
5. Documentar los problemas reportados

IMPORTANTE:
- Sé claro y conciso en tus explicaciones
- Usa lenguaje sencillo, evita tecnicismos innecesarios
- Pide detalles específicos del problema para diagnosticar mejor
- Ofrece soluciones verificables (que el usuario pueda comprobar)
- Si el problema es complejo o crítico, sugiere contactar a soporte humano
- Mantén un tono empático y comprensivo
- Confirma que el problema se resolvió antes de cerrar la conversación

Formato de respuestas:
- Divide las soluciones en pasos numerados
- Usa emojis cuando sea apropiado (⚠️ 🔧 ✅)
- Siempre pregunta si la solución funcionó`,
  
  actions: [
    {
      type: 'DIAGNOSE',
      priority: 1,
      keywords: ['problema', 'error', 'no funciona', 'falla', 'fallo', 'bug', 'issue', 'defecto', 'roto', 'no carga', 'lento'],
      description: 'Diagnosticar problema técnico'
    },
    {
      type: 'GUIDE',
      priority: 2,
      keywords: ['cómo', 'como', 'ayuda', 'tutorial', 'instrucciones', 'pasos', 'guía', 'configurar', 'instalar'],
      description: 'Proporcionar guía paso a paso'
    },
    {
      type: 'ESCALATE',
      priority: 3,
      keywords: ['urgente', 'crítico', 'critico', 'hablar con', 'supervisor', 'persona real', 'humano', 'emergencia'],
      description: 'Escalar a soporte humano'
    },
    {
      type: 'DOCUMENTATION',
      priority: 4,
      keywords: ['documentación', 'documentacion', 'manual', 'docs', 'referencia', 'información técnica', 'informacion tecnica'],
      description: 'Proporcionar enlaces a documentación'
    }
  ]
};
