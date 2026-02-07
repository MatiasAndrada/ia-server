import { Request, Response } from 'express';
import { HealthResponse } from '../types';
import { ollamaService } from '../services/ollama.service';
import { RedisConfig } from '../config/redis';
import { OllamaConfig } from '../config/ollama';
import { logger } from '../utils/logger';

const startTime = Date.now();

/**
 * GET /health
 * Health check endpoint
 */
export async function healthHandler(_req: Request, res: Response) {
  try {
    logger.debug('Health check requested');

    // Check Ollama
    const ollamaHealth = await ollamaService.healthCheck();
    const ollamaAvailable = ollamaHealth.available;

    // Check Redis
    const redisAvailable = await RedisConfig.healthCheck();

    // Calculate uptime
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy';
    
    if (ollamaAvailable && redisAvailable) {
      status = 'healthy';
    } else if (ollamaAvailable || redisAvailable) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    const response: HealthResponse = {
      status,
      ollama: ollamaAvailable,
      redis: redisAvailable,
      model: OllamaConfig.getModel(),
      uptime,
      timestamp: new Date().toISOString(),
    };

    // Return appropriate status code
    const statusCode = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

    logger.info('Health check completed', {
      status,
      ollama: ollamaAvailable,
      redis: redisAvailable,
      uptime,
    });

    res.status(statusCode).json(response);
  } catch (error) {
    logger.error('Health check failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(503).json({
      status: 'unhealthy',
      ollama: false,
      redis: false,
      model: 'unknown',
      uptime: 0,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Health check failed',
    });
  }
}

/**
 * GET /stats (optional debug endpoint)
 * Get server statistics
 */
export async function statsHandler(_req: Request, res: Response) {
  try {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const memoryUsage = process.memoryUsage();

    // Get conversation stats if Redis is available
    let conversationStats = {
      totalConversations: 0,
      avgMessagesPerConversation: 0,
    };

    if (RedisConfig.isReady()) {
      const { conversationService } = await import('../services/conversation.service');
      conversationStats = await conversationService.getStats();
    }

    res.json({
      uptime,
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
      },
      conversations: conversationStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Stats request failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get server statistics',
    });
  }
}
