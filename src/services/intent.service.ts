import { ollamaService } from './ollama.service';
import { IntentType, IntentResponse, BusinessContext } from '../types';
import { buildIntentPrompt } from '../utils/prompts';
import { logger } from '../utils/logger';

export class IntentService {
  /**
   * Analyze message intent using Ollama
   */
  async analyzeIntent(
    message: string,
    context?: Partial<BusinessContext>
  ): Promise<IntentResponse> {
    try {
      logger.debug('Analyzing intent', { message, hasContext: !!context });

      const systemPrompt = buildIntentPrompt();
      
      // Build user message with context if provided
      let userMessage = `Mensaje del usuario: "${message}"`;
      
      if (context) {
        userMessage += `\n\nContexto adicional:\n`;
        if (context.businessName) {
          userMessage += `- Negocio: ${context.businessName}\n`;
        }
        if (context.currentWaitlist !== undefined) {
          userMessage += `- Lista de espera actual: ${context.currentWaitlist} personas\n`;
        }
      }

      const response = await ollamaService.chat(
        [{ role: 'user', content: userMessage }],
        systemPrompt
      );

      // Parse JSON response
      const result = this.parseIntentResponse(response);

      logger.info('Intent analyzed', {
        intent: result.intent,
        confidence: result.confidence,
        entitiesCount: Object.keys(result.entities).length,
      });

      return result;
    } catch (error) {
      logger.error('Failed to analyze intent', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Return fallback intent
      return {
        intent: 'unknown',
        entities: {},
        confidence: 0.0,
      };
    }
  }

  /**
   * Parse intent response from Ollama
   */
  private parseIntentResponse(response: string): IntentResponse {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate intent
      const validIntents: IntentType[] = [
        'register',
        'query_status',
        'confirm_arrival',
        'cancel',
        'request_info',
        'general_question',
        'greeting',
        'unknown',
      ];

      const intent: IntentType = validIntents.includes(parsed.intent)
        ? parsed.intent
        : 'unknown';

      return {
        intent,
        entities: parsed.entities || {},
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
      };
    } catch (error) {
      logger.warn('Failed to parse intent response, using fallback', {
        error: error instanceof Error ? error.message : 'Unknown error',
        response: response.substring(0, 200),
      });

      // Fallback: try to infer from message
      return this.inferIntent(response);
    }
  }

  /**
   * Fallback intent inference from text
   */
  private inferIntent(text: string): IntentResponse {
    const lowerText = text.toLowerCase();

    if (
      lowerText.includes('hola') ||
      lowerText.includes('buenos') ||
      lowerText.includes('buenas')
    ) {
      return { intent: 'greeting', entities: {}, confidence: 0.7 };
    }

    if (
      lowerText.includes('registr') ||
      lowerText.includes('anot') ||
      lowerText.includes('reserv')
    ) {
      return { intent: 'register', entities: {}, confidence: 0.6 };
    }

    if (
      lowerText.includes('posición') ||
      lowerText.includes('cuánto') ||
      lowerText.includes('espera')
    ) {
      return { intent: 'query_status', entities: {}, confidence: 0.6 };
    }

    if (lowerText.includes('cancelar') || lowerText.includes('no voy')) {
      return { intent: 'cancel', entities: {}, confidence: 0.7 };
    }

    if (
      lowerText.includes('llegué') ||
      lowerText.includes('estoy aquí') ||
      lowerText.includes('llegada')
    ) {
      return { intent: 'confirm_arrival', entities: {}, confidence: 0.7 };
    }

    if (
      lowerText.includes('dirección') ||
      lowerText.includes('ubicación') ||
      lowerText.includes('horario')
    ) {
      return { intent: 'request_info', entities: {}, confidence: 0.6 };
    }

    return { intent: 'unknown', entities: {}, confidence: 0.3 };
  }

  /**
   * Batch analyze multiple messages
   */
  async batchAnalyze(
    messages: Array<{ text: string; context?: Partial<BusinessContext> }>
  ): Promise<IntentResponse[]> {
    logger.info('Batch analyzing intents', { count: messages.length });

    const results = await Promise.all(
      messages.map(({ text, context }) => this.analyzeIntent(text, context))
    );

    return results;
  }
}

// Export singleton instance
export const intentService = new IntentService();
