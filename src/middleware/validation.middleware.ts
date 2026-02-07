import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { logger } from '../utils/logger';

/**
 * Phone number schema (E.164 format)
 */
const phoneSchema = z.string().regex(
  /^\+?[1-9]\d{1,14}$/,
  'Phone must be in E.164 format (e.g., +5491112345678)'
);

/**
 * UUID schema
 */
const uuidSchema = z.string().uuid('Invalid UUID format');

/**
 * Business context schema
 */
const businessContextSchema = z.object({
  businessName: z.string().min(1, 'Business name is required'),
  businessAddress: z.string().optional(),
  businessHours: z.string().optional(),
  currentWaitlist: z.number().int().min(0, 'Waitlist must be non-negative').default(0),
  averageWaitTime: z.number().int().min(0, 'Average wait time must be non-negative').default(15),
  customerInfo: z.object({
    isKnown: z.boolean().default(false),
    name: z.string().optional(),
    previousVisits: z.number().int().min(0).optional(),
    lastVisit: z.string().optional(),
    preferences: z.array(z.string()).optional(),
  }).optional(),
  additionalInfo: z.record(z.any()).optional(),
}).partial();

/**
 * Chat request schema
 */
export const chatSchema = z.object({
  phone: phoneSchema,
  message: z.string().min(1, 'Message cannot be empty').max(1000, 'Message too long'),
  businessId: uuidSchema,
  context: businessContextSchema.optional(),
});

/**
 * Intent request schema
 */
export const intentSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty').max(1000, 'Message too long'),
  context: businessContextSchema.optional(),
});

/**
 * Batch request schema
 */
export const batchSchema = z.object({
  messages: z.array(
    z.object({
      phone: phoneSchema,
      message: z.string().min(1).max(1000),
      businessId: uuidSchema,
      context: businessContextSchema.optional(),
    })
  ).min(1, 'At least one message is required').max(50, 'Maximum 50 messages per batch'),
});

/**
 * Generic validation middleware factory
 */
export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      schema.parse(req.body);
      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        logger.warn('Validation error', {
          path: req.path,
          errors: error.errors,
        });

        return res.status(400).json({
          error: 'Validation Error',
          message: 'Request validation failed',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
      }

      // Unknown error
      logger.error('Unexpected validation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred during validation',
      });
    }
  };
}

/**
 * Validate phone param in URL
 */
export function validatePhoneParam(req: Request, res: Response, next: NextFunction) {
  try {
    const { phone } = req.params;
    phoneSchema.parse(phone);
    return next();
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid phone number format',
        details: error.errors,
      });
    }
    next(error);
  }
}
