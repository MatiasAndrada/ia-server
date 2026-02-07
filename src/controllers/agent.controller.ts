import { Request, Response } from 'express';
import { agentRegistry } from '../agents';
import { agentService } from '../services/agent.service';
import { logger } from '../utils/logger';

/**
 * GET /api/agents
 * Lista todos los agentes disponibles
 */
export async function listAgentsHandler(_req: Request, res: Response) {
  try {
    const agents = agentRegistry.list();
    
    res.json({
      success: true,
      count: agents.length,
      agents
    });
  } catch (error) {
    logger.error('Error listing agents', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to list agents',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * GET /api/agents/:agentId
 * Obtiene detalles de un agente específico
 */
export async function getAgentHandler(req: Request, res: Response) {
  try {
    const { agentId } = req.params;
    
    const agent = agentRegistry.get(agentId);
    
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found',
        message: `Agent with ID '${agentId}' not found or disabled`,
        availableAgents: agentRegistry.list().map(a => a.id)
      });
    }

    return res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        model: agent.model,
        enabled: agent.enabled,
        actions: agent.actions?.map(a => ({
          type: a.type,
          description: a.description,
          keywords: a.keywords
        }))
      }
    });
  } catch (error) {
    logger.error('Error getting agent', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    
    return res.status(500).json({
      success: false,
      error: 'Failed to get agent',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * POST /api/agents/:agentId/chat
 * Genera una respuesta usando el agente especificado
 */
export async function agentChatHandler(req: Request, res: Response) {
  const startTime = Date.now();
  
  try {
    const { agentId } = req.params;
    const { message, conversationId, context } = req.body;

    // Validar mensaje
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        message: 'Message is required and must be a non-empty string'
      });
    }

    // Obtener agente
    const agent = agentRegistry.get(agentId);
    
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found',
        message: `Agent with ID '${agentId}' not found or disabled`,
        availableAgents: agentRegistry.list().map(a => a.id)
      });
    }

    logger.info('Processing agent chat request', {
      agentId,
      conversationId,
      messageLength: message.length
    });

    // Generar respuesta
    const response = await agentService.generateResponse(
      message,
      agent,
      conversationId,
      context
    );

    const totalTime = Date.now() - startTime;

    logger.info('Agent chat completed', {
      agentId,
      conversationId,
      action: response.action,
      totalTime
    });

    return res.json({
      success: true,
      data: response,
      timing: {
        total: totalTime,
        processing: response.processingTime
      }
    });

  } catch (error) {
    logger.error('Error in agent chat', {
      agentId: req.params.agentId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return res.status(500).json({
      success: false,
      error: 'Failed to generate response',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * DELETE /api/agents/:agentId/conversations/:conversationId
 * Limpia el historial de una conversación
 */
export async function clearConversationHandler(req: Request, res: Response) {
  try {
    const { agentId, conversationId } = req.params;

    // Verificar que el agente existe
    const agent = agentRegistry.get(agentId);
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found',
        message: `Agent with ID '${agentId}' not found or disabled`
      });
    }

    await agentService.clearConversationHistory(conversationId);

    logger.info('Conversation cleared', { agentId, conversationId });

    return res.json({
      success: true,
      message: 'Conversation history cleared successfully',
      conversationId
    });

  } catch (error) {
    logger.error('Error clearing conversation', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    
    return res.status(500).json({
      success: false,
      error: 'Failed to clear conversation',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
