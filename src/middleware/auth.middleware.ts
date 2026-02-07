import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Middleware to validate API key from Authorization header
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Get authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logger.warn('Request without authorization header', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header is required',
    });
  }

  // Check if it's Bearer token format
  const parts = authHeader.split(' ');
  
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    logger.warn('Invalid authorization header format', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header must be in format: Bearer <token>',
    });
  }

  const token = parts[1];
  const validApiKey = process.env.API_KEY;

  if (!validApiKey) {
    logger.error('API_KEY environment variable not set');
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Server configuration error',
    });
  }

  // Validate token
  if (token !== validApiKey) {
    logger.warn('Invalid API key attempt', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
  }

  // Token is valid, continue
  return next();
}

/**
 * Optional middleware for public endpoints that don't require auth
 */
export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  // If auth header present, validate it
  if (authHeader) {
    return authMiddleware(req, res, next);
  }

  // No auth header, continue anyway
  return next();
}
