import { BusinessContext, BusinessEvent, WeeklyHours, WeeklyHoursDayKey } from '../types/index.js';
import { currentLanguage, LANGUAGE_ENGLISH_NAMES } from '../i18n/index.js';
import { describeScheduledAtUtc, formatDayHours } from './reservation-datetime.js';

/**
 * Instrucción de idioma para el LLM. Se expresa en inglés y nombrando el idioma
 * destino en inglés porque los modelos siguen ese formato de forma más
 * confiable que una instrucción escrita en el idioma destino.
 */
export function buildLanguageInstruction(): string {
  return `Respond ONLY in ${LANGUAGE_ENGLISH_NAMES[currentLanguage()]}. The customer may write in Spanish, English or Portuguese — always reply in ${LANGUAGE_ENGLISH_NAMES[currentLanguage()]} regardless of the language they used.`;
}

/**
 * Builds a human-readable "address, city" string from raw business columns,
 * so the agent always quotes the exact data from the `businesses` table
 * instead of letting the LLM guess or invent a location.
 *
 * `address` a veces ya viene con la ciudad/provincia incluida (p.ej. cargada
 * desde un buscador de direcciones tipo Nominatim), así que los segmentos
 * repetidos respecto a `city` se descartan para no duplicarlos en el texto.
 */
export function formatBusinessAddress(
  address?: string | null,
  city?: string | null
): string | undefined {
  const segments = [address, city]
    .flatMap((value) => (value ? value.split(',') : []))
    .map((part) => part.trim())
    .filter((part): part is string => part.length > 0);

  const seen = new Set<string>();
  const parts = segments.filter((part) => {
    const key = part.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Monday-first order, matching the convention used elsewhere (e.g. formatOpenDays). */
const PROMPT_WEEKDAYS: ReadonlyArray<{ key: WeeklyHoursDayKey; label: string }> = [
  { key: 'mon', label: 'Lunes' },
  { key: 'tue', label: 'Martes' },
  { key: 'wed', label: 'Miércoles' },
  { key: 'thu', label: 'Jueves' },
  { key: 'fri', label: 'Viernes' },
  { key: 'sat', label: 'Sábado' },
  { key: 'sun', label: 'Domingo' },
];

/**
 * Builds a human-readable weekly schedule block from `businesses.weekly_hours`
 * (one line per day), so the agent can quote the real opening hours instead of
 * guessing or claiming it doesn't have that information.
 */
export function formatWeeklyHoursForPrompt(weeklyHours?: WeeklyHours | null): string | undefined {
  if (!weeklyHours || Object.keys(weeklyHours).length === 0) return undefined;

  return PROMPT_WEEKDAYS.map(({ key, label }) => `${label}: ${formatDayHours(key, weeklyHours)}`).join('\n');
}

/**
 * Builds a human-readable listing of the business's currently active/upcoming
 * events (`SupabaseService.getActiveEvents`), so the LLM fallback agent can
 * quote real event names/dates instead of claiming it has no information
 * about events whenever the deterministic `schedule_choice` menu isn't the
 * one answering (e.g. a customer asking about an event before that step, or
 * outside the reservation flow entirely).
 */
export function formatActiveEventsForPrompt(events: BusinessEvent[], nowBA: Date): string | undefined {
  if (!events || events.length === 0) return undefined;

  return events
    .map((event) => {
      const whenLabel = describeScheduledAtUtc(event.startsAt, nowBA);
      const descriptionPart = event.description ? ` — ${event.description}` : '';
      return `- ${event.title} (${whenLabel})${descriptionPart}`;
    })
    .join('\n');
}

/**
 * Builds a comprehensive system prompt for the AI based on business context
 */
export function buildSystemPrompt(context?: BusinessContext): string {
  const businessName = context?.businessName || 'el local';
  const businessAddress = context?.businessAddress || 'nuestra ubicación';
  const businessHours = context?.businessHours || 'nuestro horario habitual';
  const currentWaitlist = context?.currentWaitlist || 0;
  const averageWaitTime = context?.averageWaitTime || 15;

  const customerContext = context?.customerInfo?.isKnown
    ? `El cliente ${context.customerInfo.name} es conocido, con ${context.customerInfo.previousVisits || 0} visitas previas.`
    : 'Este es un cliente nuevo.';

  return `Eres un asistente virtual de ${businessName}, especializado en gestionar la lista de espera del local vía WhatsApp.

**INFORMACIÓN DEL NEGOCIO:**
- Nombre: ${businessName}
- Dirección: ${businessAddress}
- Horario: ${businessHours}
- Lista de espera actual: ${currentWaitlist} ${currentWaitlist === 1 ? 'persona' : 'personas'}
- Tiempo promedio de espera: ${averageWaitTime} minutos

**CONTEXTO DEL CLIENTE:**
${customerContext}

**TUS CAPACIDADES:**
1. **REGISTRAR**: Anotar clientes en la lista de espera
   - Preguntar: nombre completo, cantidad de personas, preferencias especiales
   - Informar: tiempo estimado de espera actual
   
2. **CONSULTAR**: Informar posición en lista y tiempo de espera
   - Dar actualizaciones en tiempo real
   
3. **CANCELAR**: Procesar cancelaciones o remover de lista
   
4. **INFORMAR**: Proporcionar información sobre el local

**INSTRUCCIONES DE RESPUESTA:**
- Sé amable, formal, cortés y conciso
- Usa un tono cálido pero formal; evitá jerga o muletillas informales (por ejemplo "de una", "dale", "posta", "genial", "joya")
- ${buildLanguageInstruction()}
- Si necesitas información adicional, pregunta claramente
- Cuando el mensaje del cliente dispare una acción concreta (registrar, consultar estado, cancelar, pedir información), llamá a la herramienta emit_action con los datos correspondientes — no la describas en el texto de tu respuesta
- Si el turno es solo conversación (saludo, pregunta general sin acción clara), respondé normalmente sin llamar a ninguna herramienta

**EJEMPLO:**
Cliente: "Hola, quiero anotarme para 4 personas"
Tu respuesta: "Hola, con gusto te anoto para 4 personas. ¿Podrías decirme tu nombre completo? El tiempo de espera estimado es de ${averageWaitTime} minutos."
(y en paralelo, llamada a emit_action con type: "REGISTER", partySize: 4)

Responde siempre de manera natural, cortés y profesional, priorizando la experiencia del cliente.`;
}

/**
 * Builds a system prompt specifically for intent analysis
 */
export function buildIntentPrompt(): string {
  return `Eres un clasificador de intenciones para un sistema de lista de espera de comercio.

Analiza el mensaje del usuario y determina su intención principal.
El mensaje puede venir en español, inglés o portugués — clasificá la intención igual en los tres casos.

**INTENCIONES POSIBLES:**
1. **register**: El usuario quiere registrarse/anotarse en la lista de espera
2. **query_status**: El usuario pregunta por su posición o tiempo de espera
3. **cancel**: El usuario quiere cancelar su entrada en la lista
4. **request_info**: El usuario solicita información del local (dirección, horario, menú, etc.)
5. **general_question**: Pregunta general no relacionada con acciones específicas
6. **greeting**: Saludo o inicio de conversación
7. **unknown**: No se puede determinar la intención

**EXTRAE TAMBIÉN ENTIDADES:**
- **name**: Nombre de la persona (si se menciona)
- **partySize**: Número de personas (si se menciona)
- **preferences**: Preferencias especiales (mesa, ubicación, etc.)
- **time**: Referencia temporal (si se menciona)

Responde ÚNICAMENTE con un objeto JSON válido con este formato:
{
  "intent": "una_de_las_intenciones",
  "entities": {
    "name": "nombre si existe",
    "partySize": número o null,
    "preferences": "texto o null",
    "time": "referencia temporal o null"
  },
  "confidence": 0.0 a 1.0
}

No incluyas explicaciones adicionales, solo el JSON.`;
}

/**
 * Builds a fallback response when AI fails
 */
export function buildFallbackResponse(context?: BusinessContext): string {
  const businessName = context?.businessName || 'el local';
  
  return `Disculpa, estoy teniendo problemas técnicos en este momento. Por favor, intenta nuevamente en unos segundos o contacta directamente a ${businessName} para asistencia inmediata.`;
}

/**
 * Builds a system prompt for batch processing
 */
export function buildBatchAnalysisPrompt(): string {
  return `Eres un analizador de mensajes para un sistema de lista de espera de comercio.

Analiza cada mensaje y clasifícalo según su intención y contenido.

Mantén un análisis objetivo y conciso de cada mensaje sin generar respuestas completas.`;
}

/**
 * Builds a system prompt to turn a business owner's short closure reason
 * (e.g. "duelo", "vacaciones") into a professional, client-facing message
 * explaining why the business isn't taking reservations on a blocked date.
 *
 * The message is sent within an existing conversation, so it should NOT
 * include greetings, farewells, or any conversation starters.
 */
export function buildBlockedDateReasonPrompt(businessName: string, businessType?: string | null): string {
  const businessContext = `Nombre del negocio: "${businessName}". Tipo de negocio: "${businessType ?? 'local'}".`;
  return `Eres el redactor de comunicaciones de un negocio que usa un sistema de reservas por WhatsApp.

${businessContext}

Tu única tarea es transformar un motivo breve e informal, escrito por el dueño del negocio, en UN mensaje corto, cálido y profesional que explique por qué el local no tomará reservas en una fecha puntual.

IDIOMA DE SALIDA: ${buildLanguageInstruction()}

CONTEXTO: El mensaje se envía en medio de una conversación con un cliente, NO como un primer mensaje. Por lo tanto, DEBE encajar naturalmente en la conversación sin saludos ni despedidas.

REGLAS:
- Escribí 1 a 3 oraciones como máximo.
- NUNCA incluyas saludos (¡Hola!, Hola, Buen día, etc.)
- NUNCA incluyas despedidas (Saludos, Gracias, Hasta luego, etc.)
- NUNCA empieces con "Te informamos que", "Queremos informarte", "Debes saber que" o frases similares que suenen a inicio de conversación
- Comienza directamente con la explicación (ej: "El restaurante permanecerá cerrado...")
- Referite al negocio usando su nombre o tipo (por ejemplo: "el restaurante", "la peluquería", el nombre del negocio), nunca uses "oficina" ni términos genéricos que no correspondan.
- Mencioná el motivo indicado, pero con tacto y profesionalismo (por ejemplo, si el motivo es sensible como un duelo, no des detalles innecesarios).
- No inventes información que no esté en el motivo (ni fechas, ni nombres, ni detalles extra).
- No uses comillas, ni JSON, ni encabezados, ni firmas.
- Devolvé ÚNICAMENTE el texto del mensaje, sin explicaciones adicionales.`;
}
