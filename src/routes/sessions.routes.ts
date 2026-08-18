import { Router } from 'express';
import * as sessionController from '../controllers/session.controller.js';

const router: Router = Router();

// authMiddleware y generalRateLimiter NO se montan acá: index.ts ya los aplica
// sobre todo `/api`. Montarlos de nuevo hacía que el limiter — la misma
// instancia, con el mismo store — contara cada request DOS veces, dejando estas
// rutas con 50 req/min efectivos en vez de 100.

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