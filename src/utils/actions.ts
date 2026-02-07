import { Action, ActionType } from '../types';
import { logger } from './logger';

/**
 * Parses actions from AI response text
 * Format: [ACTION:type:{"key": "value"}]
 */
export function parseActions(responseText: string): Action[] {
  const actions: Action[] = [];
  
  // Regex to match [ACTION:type:json]
  const actionRegex = /\[ACTION:(\w+):(.*?)\]/g;
  let match;

  while ((match = actionRegex.exec(responseText)) !== null) {
    try {
      const type = match[1] as ActionType;
      const dataStr = match[2];
      
      // Parse JSON data
      const data = JSON.parse(dataStr);
      
      actions.push({
        type,
        data,
        confidence: 0.9, // High confidence for explicitly formatted actions
      });
    } catch (error) {
      logger.warn('Failed to parse action from response', { 
        match: match[0],
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // If no explicit actions found, try to infer from content
  if (actions.length === 0) {
    const inferredAction = inferActionFromText(responseText);
    if (inferredAction) {
      actions.push(inferredAction);
    }
  }

  return actions;
}

/**
 * Infers action type from response text when not explicitly formatted
 */
function inferActionFromText(text: string): Action | null {
  const lowerText = text.toLowerCase();

  // Check for status query first (more specific)
  if (
    lowerText.includes('posición') ||
    lowerText.includes('posicion') ||
    lowerText.includes('cuánto falta') ||
    lowerText.includes('cuanto falta') ||
    lowerText.includes('tiempo de espera')
  ) {
    return {
      type: 'CHECK_STATUS',
      data: { inferred: true },
      confidence: 0.7,
    };
  }

  // Check for registration intent
  if (
    lowerText.includes('anot') ||
    lowerText.includes('registr') ||
    (lowerText.includes('lista de espera') && !lowerText.includes('posición')) ||
    (lowerText.includes('nombre') && lowerText.includes('personas'))
  ) {
    return {
      type: 'REGISTER',
      data: { inferred: true },
      confidence: 0.6,
    };
  }

  // Check for arrival confirmation
  if (
    lowerText.includes('ya llegué') ||
    lowerText.includes('ya llegue') ||
    lowerText.includes('estoy aquí') ||
    lowerText.includes('estoy aqui') ||
    lowerText.includes('llegada')
  ) {
    return {
      type: 'CONFIRM_ARRIVAL',
      data: { inferred: true },
      confidence: 0.75,
    };
  }

  // Check for cancellation
  if (
    lowerText.includes('cancelar') ||
    lowerText.includes('no voy') ||
    lowerText.includes('no podré') ||
    lowerText.includes('no podre')
  ) {
    return {
      type: 'CANCEL',
      data: { inferred: true },
      confidence: 0.8,
    };
  }

  // Check for info request
  if (
    lowerText.includes('dirección') ||
    lowerText.includes('direccion') ||
    lowerText.includes('ubicación') ||
    lowerText.includes('ubicacion') ||
    lowerText.includes('horario') ||
    lowerText.includes('dónde') ||
    lowerText.includes('donde')
  ) {
    return {
      type: 'INFO_REQUEST',
      data: { inferred: true },
      confidence: 0.65,
    };
  }

  return null;
}

/**
 * Calculates confidence score based on response characteristics
 */
export function calculateConfidence(responseText: string, actions: Action[]): number {
  let confidence = 0.5; // Base confidence

  // Higher confidence if explicit actions are present
  if (actions.length > 0 && actions.some((a) => !a.data.inferred)) {
    confidence = 0.9;
  } else if (actions.length > 0) {
    // Actions were inferred
    const avgActionConfidence =
      actions.reduce((sum, a) => sum + (a.confidence || 0), 0) / actions.length;
    confidence = avgActionConfidence;
  }

  // Adjust based on response length and structure
  if (responseText.length > 50 && responseText.length < 500) {
    confidence += 0.05; // Good length
  }

  // Check for professional markers
  const professionalMarkers = [
    'con gusto',
    'por favor',
    'disculpa',
    'gracias',
    'claro',
  ];
  const hasMarkers = professionalMarkers.some((marker) =>
    responseText.toLowerCase().includes(marker)
  );
  if (hasMarkers) {
    confidence += 0.05;
  }

  // Cap at 1.0
  return Math.min(confidence, 1.0);
}

/**
 * Extracts entities from text (name, party size, etc.)
 */
export function extractEntities(text: string): Record<string, any> {
  const entities: Record<string, any> = {};

  // Extract party size
  const partySizeMatch = text.match(/(\d+)\s*(persona|people|pax)/i);
  if (partySizeMatch) {
    entities.partySize = parseInt(partySizeMatch[1], 10);
  }

  // Extract name (simple pattern - capitalized words)
  const nameMatch = text.match(/me llamo ([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
  if (nameMatch) {
    entities.name = nameMatch[1];
  } else {
    // Try "soy [Name]"
    const nameMatch2 = text.match(/soy ([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
    if (nameMatch2) {
      entities.name = nameMatch2[1];
    }
  }

  // Extract preferences
  const preferenceKeywords = ['ventana', 'terraza', 'interior', 'tranquil', 'silencio'];
  for (const keyword of preferenceKeywords) {
    if (text.toLowerCase().includes(keyword)) {
      entities.preferences = entities.preferences || [];
      entities.preferences.push(keyword);
    }
  }

  return entities;
}

/**
 * Cleans AI response text by removing action markers
 */
export function cleanResponseText(text: string): string {
  // Remove [ACTION:...] markers
  return text.replace(/\[ACTION:\w+:.*?\]/g, '').trim();
}

/**
 * Validates if an action has required data
 */
export function validateAction(action: Action): boolean {
  switch (action.type) {
    case 'REGISTER':
      // At minimum needs partySize or name
      return !!(action.data.partySize || action.data.name);
    
    case 'CHECK_STATUS':
    case 'CONFIRM_ARRIVAL':
    case 'CANCEL':
      // These might work with just phone from context
      return true;
    
    case 'INFO_REQUEST':
      return true;
    
    default:
      return false;
  }
}
