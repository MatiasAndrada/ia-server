import { AgentConfig, AgentResponse, ConversationMessage, OllamaMessage } from '../types';
import { ollamaService } from './ollama.service';
import { RedisConfig } from '../config/redis';
import { logger } from '../utils/logger';

/**
 * Servicio para manejar interacciones con agentes de IA
 */
class AgentService {
  private readonly HISTORY_KEY_PREFIX = 'agent_conversation:';
  private readonly MAX_HISTORY_MESSAGES = 10;
  private readonly HISTORY_TTL = 3600; // 1 hora

  /**
   * Genera una respuesta usando un agente específico
   */
  async generateResponse(
    message: string,
    agent: AgentConfig,
    conversationId?: string,
    context?: any
  ): Promise<AgentResponse> {
    const startTime = Date.now();

    try {
      logger.info('Generating response with agent', {
        agentId: agent.id,
        conversationId,
        messageLength: message.length
      });

      // Obtener historial de conversación si existe
      const history = conversationId 
        ? await this.getConversationHistory(conversationId)
        : [];

      // Construir mensajes para Ollama
      const messages: OllamaMessage[] = [
        // Historial previo
        ...history.map(msg => ({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content
        })),
        // Mensaje actual
        {
          role: 'user' as const,
          content: message
        }
      ];

      // Agregar contexto adicional al sistema si existe
      let systemPrompt = agent.systemPrompt;
      if (context) {
        // Interpolar contexto en el prompt (reemplazar placeholders)
        systemPrompt = this.interpolateContext(systemPrompt, context);
        
        // Agregar contexto estructurado para referencia
        if (context.businessName || context.currentStep || context.draftData || context.availableZones) {
          const contextInfo = [];
          if (context.businessName) contextInfo.push(`Negocio: ${context.businessName}`);
          if (context.currentStep) contextInfo.push(`Paso: ${context.currentStep}`);
          if (context.draftData?.customerName) contextInfo.push(`Cliente: ${context.draftData.customerName}`);
          if (context.draftData?.partySize) contextInfo.push(`Personas: ${context.draftData.partySize}`);
          if (context.availableZones && context.availableZones.length > 0) {
            contextInfo.push(`Zonas disponibles: ${context.availableZones.join(', ')}`);
          }
          
          if (contextInfo.length > 0) {
            systemPrompt += `\n\n## Estado Actual:\n${contextInfo.join(' | ')}`;
          }
        }
      }

      // Generar respuesta con Ollama
      const aiResponse = await ollamaService.chat(messages, systemPrompt);

      // Inferir acción basada en las keywords del agente
      const inferredAction = agent.actions && agent.actions.length > 0
        ? this.inferAction(message, agent.actions)
        : null;

      // Actualizar historial si existe conversationId
      if (conversationId) {
        await this.updateConversationHistory(conversationId, message, aiResponse);
      }

      const processingTime = Date.now() - startTime;

      logger.info('Response generated successfully', {
        agentId: agent.id,
        conversationId,
        action: inferredAction,
        processingTime
      });

      return {
        response: aiResponse,
        action: inferredAction,
        conversationId,
        agent: {
          id: agent.id,
          name: agent.name
        },
        processingTime
      };

    } catch (error) {
      logger.error('Error generating response with agent', {
        agentId: agent.id,
        conversationId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Infiere la acción basándose en las keywords definidas en el agente
   */
  private inferAction(message: string, actions: any[]): string | null {
    const lowerMessage = message.toLowerCase();
    
    // Ordenar acciones por prioridad
    const sortedActions = [...actions].sort((a, b) => 
      (a.priority || 999) - (b.priority || 999)
    );

    // Buscar coincidencias con keywords
    for (const action of sortedActions) {
      const matches = action.keywords.some((keyword: string) =>
        lowerMessage.includes(keyword.toLowerCase())
      );
      
      if (matches) {
        logger.debug('Action inferred', {
          action: action.type,
          keyword: action.keywords.find((k: string) => 
            lowerMessage.includes(k.toLowerCase())
          )
        });
        return action.type;
      }
    }

    return null;
  }

  /**
   * Obtiene el historial de conversación desde el cache
   */
  public async getConversationHistory(conversationId: string): Promise<ConversationMessage[]> {
    try {
      const client = RedisConfig.getClient();
      const key = `${this.HISTORY_KEY_PREFIX}${conversationId}`;
      const cached = await client.get(key);
      
      if (!cached) {
        return [];
      }

      const history = JSON.parse(cached) as ConversationMessage[];
      
      logger.debug('Conversation history retrieved', {
        conversationId,
        messageCount: history.length
      });

      return history;
    } catch (error) {
      logger.error('Error retrieving conversation history', {
        conversationId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  /**
   * Actualiza el historial de conversación en el cache
   */
  private async updateConversationHistory(
    conversationId: string,
    userMessage: string,
    assistantResponse: string
  ): Promise<void> {
    try {
      const history = await this.getConversationHistory(conversationId);
      
      // Agregar nuevos mensajes
      const timestamp = Date.now();
      history.push(
        {
          role: 'user',
          content: userMessage,
          timestamp
        },
        {
          role: 'assistant',
          content: assistantResponse,
          timestamp
        }
      );

      // Limitar historial a los últimos N mensajes
      const limitedHistory = history.slice(-this.MAX_HISTORY_MESSAGES);

      // Guardar en cache
      const client = RedisConfig.getClient();
      const key = `${this.HISTORY_KEY_PREFIX}${conversationId}`;
      await client.setEx(
        key,
        this.HISTORY_TTL,
        JSON.stringify(limitedHistory)
      );

      logger.debug('Conversation history updated', {
        conversationId,
        messageCount: limitedHistory.length
      });

    } catch (error) {
      logger.error('Error updating conversation history', {
        conversationId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      // No lanzar error, el historial no es crítico
    }
  }

  /**
   * Limpia el historial de una conversación
   */
  async clearConversationHistory(conversationId: string): Promise<void> {
    try {
      const client = RedisConfig.getClient();
      const key = `${this.HISTORY_KEY_PREFIX}${conversationId}`;
      await client.del(key);
      
      logger.info('Conversation history cleared', { conversationId });
    } catch (error) {
      logger.error('Error clearing conversation history', {
        conversationId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Interpola el contexto en el prompt del agente
   * Reemplaza placeholders como {businessName}, {name}, etc.
   */
  private interpolateContext(prompt: string, context: any): string {
    let interpolatedPrompt = prompt;

    // Mapeo de placeholders antiguos al contexto nuevo
    const replacements: { [key: string]: string } = {
      '{businessName}': context.businessName || 'Restaurante',
      '[NOMBRE_NEGOCIO]': context.businessName || 'Restaurante',
      '{name}': context.draftData?.customerName || '{name}',
      '[NOMBRE]': context.draftData?.customerName || '[NOMBRE]',
      '{qty}': String(context.draftData?.partySize || '{qty}'),
      '[CANTIDAD]': String(context.draftData?.partySize || '[CANTIDAD]'),
      '{zone}': context.draftData?.selectedZoneId || '{zone}',
      '[ZONA]': context.draftData?.selectedZoneId || '[ZONA]',
      '{position}': context.position || '{position}',
      '[POSICIÓN]': context.position || '[POSICIÓN]',
      '{zones}': context.availableZonesFormatted || '[NO HAY DATOS - NO menciones zonas específicas]',
      '[ZONAS]': context.availableZonesFormatted || '[NO HAY DATOS - NO menciones zonas específicas]',
      'Zona A': '', // Remove generic placeholders
      'Zona B': '',
      'Zona C': '',
      'VIP': '', // Will be replaced by actual zone names
    };

    // Realizar reemplazos
    for (const [placeholder, value] of Object.entries(replacements)) {
      const regex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      interpolatedPrompt = interpolatedPrompt.replace(regex, value);
    }

    return interpolatedPrompt;
  }
}

export const agentService = new AgentService();
