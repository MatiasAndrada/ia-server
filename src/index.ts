import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { createServer as createHTTPServer } from 'http';
import { createServer as createHTTPSServer } from 'https';
import * as fs from 'fs';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { OllamaConfig } from './config/ollama';
import { RedisConfig } from './config/redis';
import { SupabaseConfig } from './config/supabase';
import { BaileysService } from './services/baileys.service';
import { RealtimeSyncService } from './services/realtime-sync.service';
import { ReservationService } from './services/reservation.service';
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
import {
  listAgentsHandler,
  getAgentHandler,
  agentChatHandler,
  clearConversationHandler as agentClearConversationHandler,
} from './controllers/agent.controller';
import {
  getAvailableZonesHandler,
  getDraftStatusHandler,
  createReservationHandler,
  updateReservationStatusHandler,
  deleteDraftHandler,
} from './controllers/reservation.controller';

// Import new HTTP-only routes
import sessionsRoutes from './routes/sessions.routes';
import messagesRoutes from './routes/messages.routes';

// Load and validate environment variables
function getEnvConfig(): EnvConfig {
  const config: EnvConfig = {
    port: parseInt(process.env.PORT || '4000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
    ollamaTimeout: parseInt(process.env.OLLAMA_TIMEOUT || '30000', 10),
    apiKey: process.env.API_KEY || '',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '*')
      .split(',')
      .map((o: string) => o.trim()),
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    logLevel: process.env.LOG_LEVEL || 'info',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    useHttps: process.env.USE_HTTPS === 'true',
    sslKeyPath: process.env.SSL_KEY_PATH,
    sslCertPath: process.env.SSL_CERT_PATH,
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

    // Initialize Supabase (optional)
    if (config.supabaseUrl && config.supabaseKey) {
      SupabaseConfig.initialize(config.supabaseUrl, config.supabaseKey);
      logger.info('Supabase client initialized');

      // Load initial cache for businesses
      logger.info('📦 Loading initial business cache...');
      await ReservationService.loadAndCacheAllBusinesses();

      // Initialize realtime synchronization
      logger.info('🔄 Initializing realtime data synchronization...');
      await RealtimeSyncService.initializeRealtimeSync();
    } else {
      logger.warn('Supabase credentials not provided, skipping initialization');
    }

    // Create Express app
    const app = express();

    // Trust proxy - Required for X-Forwarded-For header when behind a proxy
    // This prevents 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR' error from express-rate-limit
    app.set('trust proxy', true);

    // Create server (HTTP or HTTPS)
    let server: any;
    if (config.useHttps && config.sslKeyPath && config.sslCertPath) {
      // HTTPS server
      if (!fs.existsSync(config.sslKeyPath) || !fs.existsSync(config.sslCertPath)) {
        throw new Error('SSL certificate files not found');
      }
      
      const httpsOptions = {
        key: fs.readFileSync(config.sslKeyPath),
        cert: fs.readFileSync(config.sslCertPath),
      };
      
      server = createHTTPSServer(httpsOptions, app);
      logger.info('HTTPS server created', { keyPath: config.sslKeyPath, certPath: config.sslCertPath });
    } else {
      // HTTP server (fallback)
      server = createHTTPServer(app);
      logger.info('HTTP server created (fallback - consider using HTTPS for production)');
    }

    // Initialize BaileysService
    const baileysService = BaileysService.getInstance();

    // Apply security middleware
    app.use(helmet());

    // Configure CORS
    app.use(
      cors({
        origin: (
          origin: string | undefined,
          callback: (err: Error | null, allow?: boolean) => void
        ) => {
          // Allow requests with no origin (like mobile apps or curl)
          if (!origin) return callback(null, true);

          // If allowedOrigins includes "*", allow all origins
          if (config.allowedOrigins.includes('*')) {
            return callback(null, true);
          }

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

    // API Routes - Legacy (para compatibilidad)
    app.post('/api/chat', validate(chatSchema), chatHandler);

    app.post('/api/analyze-intent', validate(intentSchema), analyzeIntentHandler);

    app.delete('/api/conversations/:phone', validatePhoneParam, clearConversationHandler);

    app.post('/api/batch', batchRateLimiter, validate(batchSchema), batchHandler);

    // API Routes - Agentes (nuevo sistema multi-agente)
    app.get('/api/agents', listAgentsHandler);
    
    app.get('/api/agents/:agentId', getAgentHandler);
    
    app.post('/api/agents/:agentId/chat', agentChatHandler);
    
    app.delete('/api/agents/:agentId/conversations/:conversationId', agentClearConversationHandler);

    // API Routes - Reservaciones
    app.get('/api/reservations/zones/:businessId', getAvailableZonesHandler);
    
    app.get('/api/reservations/draft/:conversationId', getDraftStatusHandler);
    
    app.post('/api/reservations', createReservationHandler);
    
    app.patch('/api/reservations/:reservationId/status', updateReservationStatusHandler);
    
    app.delete('/api/reservations/draft/:conversationId', deleteDraftHandler);

    // API Routes - WhatsApp Sessions (replaces WebSocket functionality)
    app.use('/api/sessions', sessionsRoutes);

    // API Routes - WhatsApp Messages (replaces WebSocket functionality)
    app.use('/api/messages', messagesRoutes);

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

    // Recover existing Baileys sessions
    logger.info('Recovering WhatsApp sessions...');
    await baileysService.recoverSessions();

    // Start server
    const serverInstance = server.listen(config.port, () => {
      const protocol = config.useHttps ? 'https' : 'http';
      logger.info(`🚀 IA Server running on port ${config.port}`, { protocol });
      logger.info(`📡 Environment: ${config.nodeEnv}`);
      logger.info(`🤖 Ollama model: ${config.ollamaModel}`);
      logger.info(`💬 WebSocket server ready`, { secure: config.useHttps });
      logger.info(`✅ Server ready to accept requests`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown...`);

      serverInstance.close(async () => {
        logger.info('HTTP server closed');

        try {
          // Clean up realtime sync
          await RealtimeSyncService.cleanup();
          logger.info('Realtime sync cleaned up');
        } catch (error) {
          logger.error('Error cleaning up realtime sync', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        try {
          await RedisConfig.disconnect();
          logger.info('Redis connection closed');
        } catch (error) {
          logger.error('Error during shutdown', {
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
