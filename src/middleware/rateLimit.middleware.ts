import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger';

/**
 * General rate limiter: 100 requests per minute per IP
 */
export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per windowMs
  message: {
    error: 'Too Many Requests',
    message: 'You have exceeded the 100 requests per minute limit.',
    retryAfter: 60,
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'You have exceeded the 100 requests per minute limit.',
      retryAfter: 60,
    });
  },
});

/**
 * Strict rate limiter for batch endpoint: 10 requests per minute per IP
 */
export const batchRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per windowMs
  message: {
    error: 'Too Many Requests',
    message: 'You have exceeded the 10 batch requests per minute limit.',
    retryAfter: 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: (req, res) => {
    logger.warn('Batch rate limit exceeded', {
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'You have exceeded the 10 batch requests per minute limit.',
      retryAfter: 60,
    });
  },
});

/**
 * Health check rate limiter: More permissive
 */
export const healthCheckRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
});
