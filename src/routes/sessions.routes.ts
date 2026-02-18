import { Router } from 'express';
import * as sessionController from '../controllers/session.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { generalRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

// Apply middleware
router.use(authMiddleware);
router.use(generalRateLimiter);

/**
 * Session Management Routes
 */

// Get all sessions
router.get('/', sessionController.getAllSessions);

// Get session status and QR
router.get('/:businessId/status', sessionController.getSessionStatus);

// Get QR code for session
router.get('/:businessId/qr', sessionController.getSessionQR);

// Start session
router.post('/:businessId/start', sessionController.startSession);

// Stop session
router.post('/:businessId/stop', sessionController.stopSession);

export default router;