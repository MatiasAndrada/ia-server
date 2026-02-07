import { AgentConfig } from '../types';

export const waitlistAgent: AgentConfig = {
  id: 'waitlist',
  name: 'Asistente de Lista de Espera',
  description: 'Gestión de listas de espera para restaurantes vía WhatsApp',
  model: 'llama3.2',
  temperature: 0.7,
  maxTokens: 500,
  enabled: true,
  
  systemPrompt: `Eres un asistente virtual amable para un sistema de gestión de listas de espera de restaurantes vía WhatsApp.

Tu trabajo es:
1. Ayudar a los clientes a registrarse en la lista de espera
2. Consultar el estado de su posición en la fila
3. Proporcionar información sobre tiempo de espera estimado
4. Confirmar llegada de clientes
5. Gestionar cancelaciones
6. Ser amable, empático y profesional

IMPORTANTE:
- Siempre pide el nombre completo del cliente
- Pregunta por el número de personas en su grupo
- Confirma los datos antes de registrar
- Sé claro sobre los tiempos de espera
- Mantén un tono cordial y profesional
- Si el cliente pregunta por su turno, ofrece información precisa
- Usa emojis ocasionalmente para ser más amigable 😊

Cuando necesites ejecutar una acción específica, indica la acción en tu respuesta pero de forma natural.

Ejemplos de respuestas:
- "¡Perfecto! Con gusto te anoto en la lista de espera. ¿Cuántas personas son?"
- "Tu turno está próximo, eres el número 3 en la lista. Tiempo estimado: 15 minutos ⏱️"
- "¡Entendido! He cancelado tu reserva. Esperamos verte pronto 👋"`,
  
  actions: [
    {
      type: 'CHECK_STATUS',
      priority: 1,
      keywords: ['estado', 'posición', 'posicion', 'turno', 'lugar', 'cuánto falta', 'cuanto falta', 'cuándo me toca', 'cuando me toca', 'fila'],
      description: 'Consultar estado en la lista de espera'
    },
    {
      type: 'REGISTER',
      priority: 2,
      keywords: ['registr', 'anot', 'agreg', 'unir', 'enter', 'lista de espera', 'agendar', 'reserv', 'poner en fila'],
      description: 'Registrarse en la lista de espera'
    },
    {
      type: 'CONFIRM_ARRIVAL',
      priority: 3,
      keywords: ['llegué', 'llegue', 'llegamos', 'estoy aquí', 'estoy aqui', 'ya estoy', 'llegada', 'arribé', 'arribamos'],
      description: 'Confirmar llegada al restaurante'
    },
    {
      type: 'CANCEL',
      priority: 4,
      keywords: ['cancelar', 'eliminar', 'borrar', 'salir', 'quitar', 'no voy', 'no podré', 'no podre', 'descartar'],
      description: 'Cancelar registro en la lista'
    },
    {
      type: 'INFO_REQUEST',
      priority: 5,
      keywords: ['información', 'informacion', 'ayuda', 'cómo funciona', 'como funciona', 'qué puedo hacer', 'que puedo hacer', 'horario', 'dirección', 'direccion', 'ubicación', 'ubicacion'],
      description: 'Solicitar información general del servicio'
    }
  ]
};
