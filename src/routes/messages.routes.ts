import { Router } from 'express';
import * as messagesController from '../controllers/messages.controller.js';

const router: Router = Router();

// authMiddleware y generalRateLimiter NO se montan acá — ver sessions.routes.ts:
// index.ts ya los aplica sobre todo `/api`, y el doble montaje contaba doble.

/**
 * Messages Routes
 */

// Get messages for a business
router.get('/:businessId', messagesController.getMessages);

// Send a message
router.post('/:businessId/send', messagesController.sendMessage);

// Get message statistics
router.get('/:businessId/stats', messagesController.getMessageStats);

// Clear messages cache
router.delete('/:businessId', messagesController.clearMessages);

export default router;