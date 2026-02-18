import { Request, Response } from 'express';
import { ReservationService } from '../services/reservation.service';
import { SupabaseService } from '../services/supabase.service';
import { logger } from '../utils/logger';

/**
 * Get available zones for a business
 * GET /api/reservations/zones/:businessId
 */
export async function getAvailableZonesHandler(req: Request, res: Response) {
  try {
    const { businessId } = req.params;

    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: 'businessId is required',
      });
    }

    const zones = await ReservationService.getAvailableZones(businessId);

    return res.json({
      success: true,
      data: {
        zones,
        count: zones.length,
      },
    });
  } catch (error) {
    logger.error('Error in getAvailableZonesHandler', { error });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}

/**
 * Get reservation draft status
 * GET /api/reservations/draft/:conversationId
 */
export async function getDraftStatusHandler(req: Request, res: Response) {
  try {
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: 'conversationId is required',
      });
    }

    const draft = await ReservationService.getDraft(conversationId);

    if (!draft) {
      return res.json({
        success: true,
        data: {
          hasActiveDraft: false,
          draft: null,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        hasActiveDraft: true,
        draft: {
          step: draft.step,
          customerName: draft.customerName,
          partySize: draft.partySize,
          selectedZoneId: draft.selectedZoneId,
        },
      },
    });
  } catch (error) {
    logger.error('Error in getDraftStatusHandler', { error });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}

/**
 * Create a reservation manually (from frontend)
 * POST /api/reservations
 */
export async function createReservationHandler(req: Request, res: Response) {
  try {
    const { businessId, customerName, customerPhone, partySize, tableId, zone } = req.body;

    // Validate required fields
    if (!businessId || !customerName || !customerPhone || !partySize) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: businessId, customerName, customerPhone, partySize',
      });
    }

    // Create reservation
    const result = await SupabaseService.createReservation({
      businessId,
      customerName,
      customerPhone,
      partySize,
      tableId,
      zone,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    logger.info('Reservation created from frontend', {
      businessId,
      entryId: result.waitlistEntry?.id,
    });

    return res.status(201).json(result);
  } catch (error) {
    logger.error('Error in createReservationHandler', { error });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}

/**
 * Update reservation status
 * PATCH /api/reservations/:reservationId/status
 */
export async function updateReservationStatusHandler(req: Request, res: Response) {
  try {
    const { reservationId } = req.params;
    const { status } = req.body;

    if (!reservationId || !status) {
      return res.status(400).json({
        success: false,
        error: 'reservationId and status are required',
      });
    }

    const validStatuses = ['WAITING', 'NOTIFIED', 'SEATED', 'CANCELLED', 'NO_SHOW'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const success = await SupabaseService.updateReservationStatus(reservationId, status);

    if (!success) {
      return res.status(400).json({
        success: false,
        error: 'Failed to update reservation status',
      });
    }

    logger.info('Reservation status updated', { reservationId, status });

    return res.json({
      success: true,
      message: 'Reservation status updated',
    });
  } catch (error) {
    logger.error('Error in updateReservationStatusHandler', { error });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}

/**
 * Delete/Cancel a reservation draft
 * DELETE /api/reservations/draft/:conversationId
 */
export async function deleteDraftHandler(req: Request, res: Response) {
  try {
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: 'conversationId is required',
      });
    }

    const success = await ReservationService.deleteDraft(conversationId);

    return res.json({
      success,
      message: success ? 'Draft deleted' : 'Draft not found or already deleted',
    });
  } catch (error) {
    logger.error('Error in deleteDraftHandler', { error });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}
