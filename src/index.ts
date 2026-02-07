import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { OllamaConfig } from './config/ollama';
import { RedisConfig } from './config/redis';
import { EnvConfig } from './types';
import { logger, logRequest } from './utils/logger';
import { authMiddleware } from './middleware/auth.middleware';
import {
  generalRateLimiter,
  batchRateLimiter,
  healthCheckRateLimiter,
} from './middleware/rateLimit.middleware';
import {
  validate,
  chatSchema,
  intentSchema,
  batchSchema,
  validatePhoneParam,
} from './middleware/validation.middleware';
import {
  chatHandler,
  analyzeIntentHandler,
  clearConversationHandler,
  batchHandler,
} from './controllers/chat.controller';
import { healthHandler, statsHandler } from './controllers/health.controller';

// Load and validate environment variables
function getEnvConfig(): EnvConfig {
  const config: EnvConfig = {
    port: parseInt(process.env.PORT || '4000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
    ollamaTimeout: parseInt(process.env.OLLAMA_TIMEOUT || '30000', 10),
    apiKey: process.env.API_KEY || '',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim()),
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    logLevel: process.env.LOG_LEVEL || 'info',
  };

  // Validate required variables
  if (!config.apiKey) {
    throw new Error('API_KEY environment variable is required');
  }

  return config;
}

// Initialize app
async function initializeApp() {
  try {
    logger.info('Starting IA Server...');

    // Load configuration
    const config = getEnvConfig();

    logger.info('Configuration loaded', {
      port: config.port,
      nodeEnv: config.nodeEnv,
      ollamaBaseUrl: config.ollamaBaseUrl,
      ollamaModel: config.ollamaModel,
      allowedOrigins: config.allowedOrigins,
    });

    // Initialize Ollama
    OllamaConfig.initialize(config);
    logger.info('Ollama client initialized');

    // Verify Ollama connection
    const ollamaHealthy = await OllamaConfig.healthCheck();
    if (!ollamaHealthy) {
      logger.warn('Ollama is not responding. Make sure Ollama is running and the model is downloaded.');
    } else {
      logger.info('Ollama connection verified');
    }

    // Initialize Redis
    await RedisConfig.initialize(config.redisUrl);
    logger.info('Redis client initialized');

    // Create Express app
    const app = express();

    // Apply security middleware
    app.use(helmet());

    // Configure CORS
    app.use(
      cors({
        origin: (origin, callback) => {
          // Allow requests with no origin (like mobile apps or curl)
          if (!origin) return callback(null, true);

          if (config.allowedOrigins.includes(origin)) {
            return callback(null, true);
          }

          logger.warn('CORS blocked request', { origin });
          callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
      })
    );

    // Enable gzip compression
    app.use(compression() as any);

    // Parse JSON bodies
    app.use(express.json({ limit: '1mb' }));

    // Request logging middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - startTime;
        logRequest(req.method, req.path, res.statusCode, duration);
      });

      next();
    });

    // Health check endpoint (no auth required)
    app.get('/health', healthCheckRateLimiter, healthHandler);

    // Optional stats endpoint (with auth)
    app.get('/stats', authMiddleware, generalRateLimiter, statsHandler);

    // Apply auth middleware to all API routes
    app.use('/api', authMiddleware);

    // Apply general rate limiter to all API routes
    app.use('/api', generalRateLimiter);

    // API Routes
    app.post('/api/chat', validate(chatSchema), chatHandler);

    app.post('/api/analyze-intent', validate(intentSchema), analyzeIntentHandler);

    app.delete('/api/conversations/:phone', validatePhoneParam, clearConversationHandler);

    app.post('/api/batch', batchRateLimiter, validate(batchSchema), batchHandler);

    // 404 handler
    app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} not found`,
      });
    });

    // Error handler
    app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
      });

      res.status(500).json({
        error: 'Internal Server Error',
        message: config.nodeEnv === 'development' ? err.message : 'An unexpected error occurred',
      });
    });

    // Start server
    const server = app.listen(config.port, () => {
      logger.info(`🚀 IA Server running on port ${config.port}`);
      logger.info(`📡 Environment: ${config.nodeEnv}`);
      logger.info(`🤖 Ollama model: ${config.ollamaModel}`);
      logger.info(`✅ Server ready to accept requests`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown...`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          await RedisConfig.disconnect();
          logger.info('Redis connection closed');
        } catch (error) {
          logger.error('Error closing Redis connection', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        logger.info('Graceful shutdown completed');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error: Error) => {
      logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack,
      });
      process.exit(1);
    });

    process.on('unhandledRejection', (reason: any) => {
      logger.error('Unhandled rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
      });
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to initialize app', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Start the application
initializeApp();
