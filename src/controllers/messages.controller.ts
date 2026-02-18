import { Request, Response } from 'express';
import { BaileysService } from '../services/baileys.service';
import { RedisConfig } from '../config/redis';
import { logger } from '../utils/logger';

const baileysService = BaileysService.getInstance();

/**
 * Get recent messages for a business
 */
export const getMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.params.businessId;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    if (!businessId) {
      res.status(400).json({
        success: false,
        error: 'Business ID is required',
      });
      return;
    }

    // Get messages from Redis cache
    const redis = RedisConfig.getClient();
    const cacheKey = `messages:${businessId}`;
    
    let messages: any[] = [];
    
    try {
      const cachedMessages = await redis.lRange(cacheKey, offset, offset + limit - 1);
      messages = cachedMessages.map((msg: string) => JSON.parse(msg));
    } catch (error) {
      logger.warn('Failed to get messages from cache', { businessId, error });
      messages = [];
    }

    res.status(200).json({
      success: true,
      data: {
        businessId,
        messages,
        pagination: {
          limit,
          offset,
          count: messages.length,
        },
      },
    });
  } catch (error) {
    logger.error('Error getting messages via HTTP', { error, businessId: req.params.businessId });
    res.status(500).json({
      success: false,
      error: 'Failed to get messages',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Send a message via WhatsApp
 */
export const sendMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.params.businessId;
    const { to, message } = req.body;

    if (!businessId) {
      res.status(400).json({
        success: false,
        error: 'Business ID is required',
      });
      return;
    }

    if (!to || !message) {
      res.status(400).json({
        success: false,
        error: 'Both "to" and "message" fields are required',
      });
      return;
    }

    // Check if session exists and is connected
    if (!baileysService.hasSession(businessId)) {
      res.status(404).json({
        success: false,
        error: 'WhatsApp session not found',
        message: 'Start a session first',
      });
      return;
    }

    if (!baileysService.isSessionConnected(businessId)) {
      res.status(400).json({
        success: false,
        error: 'WhatsApp session not connected',
        message: 'Session exists but is not connected to WhatsApp',
      });
      return;
    }

    logger.info('Sending message via HTTP', { businessId, to, messageLength: message.length });

    // Send the message
    const success = await baileysService.sendMessage(businessId, to, message);

    if (!success) {
      res.status(500).json({
        success: false,
        error: 'Failed to send message',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        businessId,
        to,
        message,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Error sending message via HTTP', { error, businessId: req.params.businessId });
    res.status(500).json({
      success: false,
      error: 'Failed to send message',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Clear message cache for a business
 */
export const clearMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.params.businessId;

    if (!businessId) {
      res.status(400).json({
        success: false,
        error: 'Business ID is required',
      });
      return;
    }

    const redis = RedisConfig.getClient();
    const cacheKey = `messages:${businessId}`;
    
    await redis.del(cacheKey);

    res.status(200).json({
      success: true,
      message: 'Messages cleared',
      data: { businessId },
    });
  } catch (error) {
    logger.error('Error clearing messages via HTTP', { error, businessId: req.params.businessId });
    res.status(500).json({
      success: false,
      error: 'Failed to clear messages',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get message statistics for a business
 */
export const getMessageStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.params.businessId;

    if (!businessId) {
      res.status(400).json({
        success: false,
        error: 'Business ID is required',
      });
      return;
    }

    const redis = RedisConfig.getClient();
    const cacheKey = `messages:${businessId}`;
    
    const totalMessages = await redis.lLen(cacheKey);
    
    // Get recent messages to analyze
    const recentMessages = await redis.lRange(cacheKey, 0, 99);
    const parsedMessages = recentMessages.map((msg: string) => {
      try {
        return JSON.parse(msg);
      } catch {
        return null;
      }
    }).filter((msg: any) => msg !== null);

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const messagesLastHour = parsedMessages.filter((msg: any) => 
      msg.timestamp && new Date(msg.timestamp).getTime() > oneHourAgo
    ).length;

    const messagesLastDay = parsedMessages.filter((msg: any) => 
      msg.timestamp && new Date(msg.timestamp).getTime() > oneDayAgo
    ).length;

    res.status(200).json({
      success: true,
      data: {
        businessId,
        stats: {
          totalMessages,
          messagesLastHour,
          messagesLastDay,
          recentMessagesSample: parsedMessages.slice(0, 5),
        },
      },
    });
  } catch (error) {
    logger.error('Error getting message stats via HTTP', { error, businessId: req.params.businessId });
    res.status(500).json({
      success: false,
      error: 'Failed to get message statistics',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};