import { Request, Response } from 'express';
import { BaileysService } from '../services/baileys.service';
import { logger } from '../utils/logger';

const baileysService = BaileysService.getInstance();

/**
 * Start a WhatsApp session for a business
 */
export const startSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.params.businessId;

    if (!businessId) {
      res.status(400).json({
        success: false,
        error: 'Business ID is required',
      });
      return;
    }

    logger.info('Starting WhatsApp session via HTTP', { businessId });
    
    // Check if session already exists
    if (baileysService.hasSession(businessId)) {
      res.status(200).json({
        success: true,
        message: 'Session already active',
        data: {
          businessId,
          isConnected: baileysService.isSessionConnected(businessId),
        },
      });
      return;
    }

    // Start the session
    await baileysService.startSession(businessId);

    res.status(200).json({
      success: true,
      message: 'Session start requested',
      data: {
        businessId,
        status: 'starting',
      },
    });
  } catch (error) {
    logger.error('Error starting session via HTTP', { error, businessId: req.params.businessId });
    res.status(500).json({
      success: false,
      error: 'Failed to start session',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Stop a WhatsApp session for a business
 */
export const stopSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.params.businessId;

    if (!businessId) {
      res.status(400).json({
        success: false,
        error: 'Business ID is required',
      });
      return;
    }

    logger.info('Stopping WhatsApp session via HTTP', { businessId });
    
    // Check if session exists
    if (!baileysService.hasSession(businessId)) {
      res.status(404).json({
        success: false,
        error: 'Session not found',
      });
      return;
    }

    // Stop the session
    await baileysService.stopSession(businessId);

    res.status(200).json({
      success: true,
      message: 'Session stopped',
      data: {
        businessId,
        status: 'stopped',
      },
    });
  } catch (error) {
    logger.error('Error stopping session via HTTP', { error, businessId: req.params.businessId });
    res.status(500).json({
      success: false,
      error: 'Failed to stop session',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get session status and QR code if available
 */
export const getSessionStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.params.businessId;

    if (!businessId) {
      res.status(400).json({
        success: false,
        error: 'Business ID is required',
      });
      return;
    }

    const sessionState = baileysService.getSessionState(businessId);
    const hasSession = baileysService.hasSession(businessId);
    const isConnected = baileysService.isSessionConnected(businessId);

    res.status(200).json({
      success: true,
      data: {
        businessId,
        hasSession,
        isConnected,
        qrCode: sessionState?.qrCode || null,
        lastActivity: sessionState?.lastActivity || null,
        sessionPath: sessionState?.sessionPath || null,
      },
    });
  } catch (error) {
    logger.error('Error getting session status via HTTP', { error, businessId: req.params.businessId });
    res.status(500).json({
      success: false,
      error: 'Failed to get session status',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get QR code for a business session
 */
export const getSessionQR = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.params.businessId;

    if (!businessId) {
      res.status(400).json({
        success: false,
        error: 'Business ID is required',
      });
      return;
    }

    const sessionState = baileysService.getSessionState(businessId);

    if (!sessionState) {
      res.status(404).json({
        success: false,
        error: 'Session not found',
      });
      return;
    }

    if (!sessionState.qrCode) {
      res.status(404).json({
        success: false,
        error: 'QR code not available',
        message: 'Session may be connected or QR not generated yet',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        businessId,
        qrCode: sessionState.qrCode,
        isConnected: sessionState.isConnected,
      },
    });
  } catch (error) {
    logger.error('Error getting QR code via HTTP', { error, businessId: req.params.businessId });
    res.status(500).json({
      success: false,
      error: 'Failed to get QR code',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get all sessions status
 */
export const getAllSessions = async (_req: Request, res: Response): Promise<void> => {
  try {
    const sessions = baileysService.getAllSessions();

    res.status(200).json({
      success: true,
      data: {
        count: sessions.length,
        sessions: sessions.map(session => ({
          businessId: session.businessId,
          isConnected: session.isConnected,
          hasQrCode: !!session.qrCode,
          lastActivity: session.lastActivity,
        })),
      },
    });
  } catch (error) {
    logger.error('Error getting all sessions via HTTP', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get sessions',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};