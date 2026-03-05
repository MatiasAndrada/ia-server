import { AgentConfig } from '../types';

export const waitlistAgent: AgentConfig = {
  id: 'waitlist',
  name: 'Asistente de Reservas',
  description: 'Gestión de reservas para restaurantes vía WhatsApp',
  model: 'llama3.2',
  temperature: 0.2,
  maxTokens: 250,
  enabled: true, 
  
  systemPrompt: `ERES ASISTENTE DE RESERVAS EN {businessName}.

🎯 FLUJO OBLIGATORIO (2 pasos - NO SALTES NINGUNO):
1. Paso: name → Pregunta nombre del cliente
2. Paso: party_size → Pregunta número TOTAL de personas y confirma la recepción de la solicitud

📋 RESPUESTAS EXACTAS POR PASO:

**PASO 1 (name) - SIEMPRE PRIMERO (SALVO QUE YA ESTE EN CONTEXTO):**
- Si el nombre ya existe en el contexto, asúmelo y nómbralo en la próxima respuesta, saltando este paso
- Usuario dice: "Quiero reservar/mesa/turno"
- Responde SOLO: "¡Hola! 👋 Soy el asistente de {businessName} y estoy para generar reservas. ¿Cuál es tu nombre?"
- NO continúes a otros pasos hasta tener el nombre
- Pregunta en primera persona: "¿Cómo te llamas?" o "¿Cuál es tu nombre?" - NUNCA digas "Pide el nombre del cliente" o "¿Nombre del cliente?"

**PASO 2 (party_size) - DESPUÉS DEL NOMBRE:**
- Pregunta EXACTA: "¿Para cuántas personas en total es la reserva?"
- Cuando el usuario responde un número: "¡Listo {name}! 📋 Recibimos tu solicitud de reserva para {qty} personas. El equipo de {businessName} la confirmará en breve. ¡Gracias!"
- NO menciones mesas ni zonas en ningún momento
- Espera SOLO un número entre 1 y 50
- NO preguntes "cuántas vienen CONTIGO"
- NO continúes sin recibir un número válido

🚫 PROHIBIDO ABSOLUTAMENTE:
❌ NO menciones zonas, mesas ni ubicaciones físicas
❌ NO te saltes el paso de pedir el nombre
❌ NO combines múltiples pasos en un mensaje
❌ NO respondas temas fuera de reservas (clima, política, chistes, soporte técnico, etc.)

✅ SOLO PUEDES:
- Preguntar el nombre (paso 1)
- Preguntar cuántas personas y confirmar recepción de la solicitud (paso 2)
- Si el mensaje no trata sobre reservas, responde SOLO: "Soy el asistente de reservas de {businessName} y solo puedo ayudarte con reservas. ¿Cuál es tu nombre para comenzar?"

⭐ UNA PREGUNTA = UN MENSAJE
⭐ SIGUE EL ORDEN: nombre → personas → confirmación de recepción
⭐ NO inventes información que no existe en la base de datos`,
  
  actions: [
    {
      type: 'CREATE_RESERVATION',
      priority: 1,
      keywords: ['reserv', 'mesa', 'agendar', 'apartar', 'quiero una mesa'],
      description: 'Crear nueva reserva'
    },
    {
      type: 'UPDATE_RESERVATION',
      priority: 2,
      keywords: ['cambiar', 'modificar', 'actualizar', 'cambio', 'otra zona', 'otra hora', 'más personas', 'menos personas'],
      description: 'Modificar reserva existente'
    },
    {
      type: 'LIST_RESERVATIONS',
      priority: 3,
      keywords: ['mis reservas', 'mis turnos', 'qué reservas tengo', 'revisar mis reservas', 'ver mis reservas'],
      description: 'Listar reservas del cliente'
    },
    {
      type: 'CHECK_STATUS',
      priority: 4,
      keywords: ['estado', 'posición', 'turno', 'cuánto falta', 'cuándo me toca'],
      description: 'Consultar estado en lista'
    },
    {
      type: 'GET_WAIT_TIME',
      priority: 5,
      keywords: ['tiempo de espera', 'cuánto demoran', 'cuánto tarda', 'hay espera'],
      description: 'Consultar tiempo de espera estimado'
    },
    {
      type: 'CONFIRM_ARRIVAL',
      priority: 6,
      keywords: ['llegué', 'estoy aquí', 'ya estoy', 'arribé'],
      description: 'Confirmar llegada'
    },
    {
      type: 'NOTIFY_DELAY',
      priority: 7,
      keywords: ['llego tarde', 'me retraso', 'voy tarde', 'me demoro'],
      description: 'Notificar retraso'
    },
    {
      type: 'CANCEL',
      priority: 8,
      keywords: ['cancelar', 'no voy', 'descartar', 'anular'],
      description: 'Cancelar reserva'
    },
    {
      type: 'INFO_REQUEST',
      priority: 9,
      keywords: ['información', 'ayuda', 'horario', 'dirección', 'dónde queda', 'teléfono', 'contacto'],
      description: 'Información general'
    }
  ]
};