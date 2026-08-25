import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';
import { createServer as createHTTPServer } from 'http';
import { createServer as createHTTPSServer } from 'https';
import * as fs from 'fs';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { OpenRouterConfig } from './config/openrouter.js';
import { RedisConfig } from './config/redis.js';
import { SupabaseConfig } from './config/supabase.js';
import { BaileysService } from './services/baileys.service.js';
import { RealtimeSyncService } from './services/realtime-sync.service.js';
import { ReservationService } from './services/reservation.service.js';
import { PostVisitService } from './services/post-visit.service.js';
import { ReservationReminderService } from './services/reservation-reminder.service.js';
import { EnvConfig } from './types/index.js';
import { logger, logEvent } from './utils/logger.js';
import { withLogContext } from './utils/log-context.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import {
  generalRateLimiter,
  batchRateLimiter,
  healthCheckRateLimiter,
} from './middleware/rateLimit.middleware.js';
import {
  validate,
  chatSchema,
  intentSchema,
  batchSchema,
  validatePhoneParam,
} from './middleware/validation.middleware.js';
import {
  chatHandler,
  analyzeIntentHandler,
  clearConversationHandler,
  batchHandler,
} from './controllers/chat.controller.js';
import { healthHandler, statsHandler } from './controllers/health.controller.js';
import {
  listAgentsHandler,
  getAgentHandler,
  agentChatHandler,
  clearConversationHandler as agentClearConversationHandler,
} from './controllers/agent.controller.js';
import {
  getDraftStatusHandler,
  createReservationHandler,
  updateReservationStatusHandler,
  deleteDraftHandler,
} from './controllers/reservation.controller.js';
import { createBlockedDateHandler } from './controllers/blocked-date.controller.js';

// Import new HTTP-only routes
import sessionsRoutes from './routes/sessions.routes.js';
import messagesRoutes from './routes/messages.routes.js';

/** Por encima de esto una request se considera lenta y sube a `warn`. */
const SLOW_REQUEST_MS = 1000;

// Load and validate environment variables
function getEnvConfig(): EnvConfig {
  const config: EnvConfig = {
    port: parseInt(process.env.PORT || '4000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openRouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',
    openRouterFallbackModels: (process.env.OPENROUTER_FALLBACK_MODELS || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    openRouterTimeout: parseInt(process.env.OPENROUTER_TIMEOUT || '30000', 10),
    openRouterSiteUrl: process.env.OPENROUTER_SITE_URL,
    openRouterSiteName: process.env.OPENROUTER_SITE_NAME,
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
  if (!config.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is required');
  }

  return config;
}

// Initialize app
async function initializeApp() {
  try {
    logEvent('info', 'server.starting', { nodeEnv: process.env.NODE_ENV || 'development' });

    // Load configuration
    const config = getEnvConfig();

    logger.debug('Configuration loaded', {
      allowedOrigins: config.allowedOrigins,
      openRouterTimeout: config.openRouterTimeout,
    });

    // Initialize OpenRouter
    OpenRouterConfig.initialize(config);

    // Verify OpenRouter connection
    const openRouterHealthy = await OpenRouterConfig.healthCheck();
    if (!openRouterHealthy) {
      logEvent('warn', 'dep.degraded', {
        dependency: 'openrouter',
        reason: 'health check failed — check OPENROUTER_API_KEY and connectivity',
      });
    } else {
      logEvent('info', 'dep.ready', { dependency: 'openrouter', model: config.openRouterModel });
    }

    // Initialize Redis
    await RedisConfig.initialize(config.redisUrl);
    logEvent('info', 'dep.ready', { dependency: 'redis' });

    // Initialize Supabase (optional)
    if (config.supabaseUrl && config.supabaseKey) {
      SupabaseConfig.initialize(config.supabaseUrl, config.supabaseKey);
      logEvent('info', 'dep.ready', { dependency: 'supabase' });

      // Load initial cache for businesses
      logger.debug('Loading initial business cache');
      await ReservationService.loadAndCacheAllBusinesses();

      // Initialize realtime synchronization
      logger.debug('Initializing realtime data synchronization');
      await RealtimeSyncService.initializeRealtimeSync();

      // Start the post-visit (M12) scanner
      PostVisitService.start();

      // Start the pre-reservation reminder (M10) scanner
      ReservationReminderService.start();
    } else {
      logEvent('warn', 'dep.degraded', {
        dependency: 'supabase',
        reason: 'credentials not provided, skipping initialization',
      });
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
      logger.debug('HTTPS server created', { keyPath: config.sslKeyPath, certPath: config.sslCertPath });
    } else {
      // HTTP server (fallback)
      server = createHTTPServer(app);
      logger.debug('HTTP server created (fallback - consider using HTTPS for production)');
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

          logEvent('warn', 'auth.rejected', { reason: 'cors', origin });
          callback(new Error('Not allowed by CORS'));
        },
      })
    );

    // Enable gzip compression
    app.use(compression() as any);

    // Parse JSON bodies
    app.use(express.json({ limit: '1mb' }));

    // Request logging + correlation.
    //
    // Antes se emitía un `info` por request, lo que convertía a `/health`
    // (pollado cada pocos segundos) en la línea más frecuente del sistema:
    // 3310 ocurrencias en una muestra de 20 MB. Ahora `/health` no se loguea y
    // el resto sólo sube a `info` cuando falla o cuando tarda demasiado.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();
      const requestId = randomUUID();
      res.setHeader('X-Request-Id', requestId);

      withLogContext({ requestId }, () => {
        res.on('finish', () => {
          if (req.path === '/health') return;

          const duration = Date.now() - startTime;
          const meta = {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: duration,
          };

          if (res.statusCode >= 400) {
            logEvent(res.statusCode >= 500 ? 'error' : 'warn', 'http.error', meta);
          } else if (duration > SLOW_REQUEST_MS) {
            logEvent('warn', 'http.error', { ...meta, reason: 'slow' });
          } else {
            logger.debug('HTTP request', meta);
          }
        });

        next();
      });
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
    app.get('/api/reservations/draft/:conversationId', getDraftStatusHandler);
    
    app.post('/api/reservations', createReservationHandler);
    
    app.patch('/api/reservations/:reservationId/status', updateReservationStatusHandler);
    
    app.delete('/api/reservations/draft/:conversationId', deleteDraftHandler);

    // API Routes - Fechas bloqueadas
    app.post('/api/blocked-dates', createBlockedDateHandler);

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
      logEvent('error', 'http.error', {
        error: err,
        method: req.method,
        path: req.path,
        status: 500,
      });

      res.status(500).json({
        error: 'Internal Server Error',
        message: config.nodeEnv === 'development' ? err.message : 'An unexpected error occurred',
      });
    });

    // Recover existing Baileys sessions
    logger.debug('Recovering WhatsApp sessions');
    await baileysService.recoverSessions();

    // Start server.
    //
    // Una sola línea de arranque en vez de las seis que había: todo lo que
    // hacía falta saber (puerto, protocolo, entorno, modelo, nivel de log,
    // sesiones recuperadas) entra en un único evento correlacionable.
    const serverInstance = server.listen(config.port, () => {
      logEvent('info', 'server.ready', {
        port: config.port,
        protocol: config.useHttps ? 'https' : 'http',
        nodeEnv: config.nodeEnv,
        logLevel: config.logLevel,
        model: config.openRouterModel,
        fallbackModels: config.openRouterFallbackModels,
        recoveredSessions: baileysService.getAllSessions().length,
      });
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logEvent('info', 'server.shutdown', { signal });

      serverInstance.close(async () => {
        logger.debug('HTTP server closed');

        try {
          // Stop the background scanners
          PostVisitService.stop();
          ReservationReminderService.stop();

          // Clean up realtime sync
          await RealtimeSyncService.cleanup();
          logger.debug('Realtime sync cleaned up');
        } catch (error) {
          logger.error('Error cleaning up realtime sync', { error });
        }

        try {
          await RedisConfig.disconnect();
          logger.debug('Redis connection closed');
        } catch (error) {
          logger.error('Error closing Redis connection', { error });
        }

        logEvent('info', 'server.shutdown', { signal, phase: 'completed' });
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logEvent('error', 'server.fatal', { reason: 'forced shutdown after timeout', signal });
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error: Error) => {
      logEvent('error', 'server.fatal', { reason: 'uncaughtException', error });
      process.exit(1);
    });

    process.on('unhandledRejection', (reason: unknown) => {
      logEvent('error', 'server.fatal', { reason: 'unhandledRejection', error: reason });
      process.exit(1);
    });
  } catch (error) {
    logEvent('error', 'server.fatal', { reason: 'bootstrap failed', error });
    process.exit(1);
  }
}

// Start the application
initializeApp();
