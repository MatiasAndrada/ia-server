import { Router } from 'express';
import * as messagesController from '../controllers/messages.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { generalRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

// Apply middleware
router.use(authMiddleware);
router.use(generalRateLimiter);

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