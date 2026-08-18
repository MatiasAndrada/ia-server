import { Request, Response } from 'express';
import { SupabaseService } from '../services/supabase.service.js';
import { logger } from '../utils/logger.js';

/**
 * Create a business blocked date (e.g. holiday, closure, grieving day).
 * When `reason` is provided, an AI-generated `reason_message` is produced
 * and stored automatically.
 * POST /api/blocked-dates
 */
export async function createBlockedDateHandler(req: Request, res: Response) {
  try {
    const { businessId, date, reason } = req.body;

    if (!businessId || !date) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: businessId, date',
      });
    }

    const blockedDate = await SupabaseService.createBlockedDate(businessId, date, reason ?? null);

    if (!blockedDate) {
      return res.status(400).json({
        success: false,
        error: 'Failed to create blocked date',
      });
    }

    logger.info('Blocked date created from API', { businessId, date });

    return res.status(201).json({
      success: true,
      data: blockedDate,
    });
  } catch (error) {
    logger.error('Error in createBlockedDateHandler', { error });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}
