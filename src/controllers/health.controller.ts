import { Request, Response } from 'express';
import { HealthResponse } from '../types/index.js';
import { openRouterService } from '../services/openrouter.service.js';
import { RedisConfig } from '../config/redis.js';
import { OpenRouterConfig } from '../config/openrouter.js';
import { logger } from '../utils/logger.js';

const startTime = Date.now();

/**
 * GET /health
 * Health check endpoint
 */
export async function healthHandler(_req: Request, res: Response) {
  try {
    logger.debug('Health check requested');

    // Check LLM provider (OpenRouter)
    const llmHealth = await openRouterService.healthCheck();
    const llmAvailable = llmHealth.available;

    // Check Redis
    const redisAvailable = await RedisConfig.healthCheck();

    // Calculate uptime
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy';

    if (llmAvailable && redisAvailable) {
      status = 'healthy';
    } else if (llmAvailable || redisAvailable) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    const response: HealthResponse = {
      status,
      llm: llmAvailable,
      redis: redisAvailable,
      model: OpenRouterConfig.getModel(),
      uptime,
      timestamp: new Date().toISOString(),
    };

    // Return appropriate status code
    const statusCode = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

    logger.info('Health check completed', {
      status,
      llm: llmAvailable,
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
      llm: false,
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
      const { conversationService } = await import('../services/conversation.service.js');
      conversationStats = await conversationService.getStats();
    }

    // Reservation NLU (LLM extraction) counters — how often the model
    // successfully read a message vs. the caller fell back to regex.
    const { reservationNluMetrics } = await import('../services/reservation-nlu.service.js');
    const nluTotal =
      reservationNluMetrics.extracted +
      reservationNluMetrics.empty +
      reservationNluMetrics.error;

    res.json({
      uptime,
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
      },
      conversations: conversationStats,
      reservationNlu: {
        ...reservationNluMetrics,
        total: nluTotal,
        // Share of extraction attempts that produced usable slots (0..1).
        extractionRate: nluTotal > 0 ? reservationNluMetrics.extracted / nluTotal : null,
      },
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
