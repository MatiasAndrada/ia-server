import { RedisConfig } from '../config/redis';
import { ConversationMessage, ConversationHistory } from '../types';
import { logger } from '../utils/logger';

export class ConversationService {
  private readonly keyPrefix = 'conversation:';
  private readonly maxMessages = 10;
  private readonly ttl = 24 * 60 * 60; // 24 hours in seconds

  /**
   * Get conversation history for a phone number
   */
  async getHistory(phone: string): Promise<ConversationMessage[]> {
    try {
      const client = RedisConfig.getClient();
      const key = this.getKey(phone);

      const data = await client.get(key);

      if (!data) {
        logger.debug('No conversation history found', { phone });
        return [];
      }

      const history: ConversationHistory = JSON.parse(data);
      logger.debug('Retrieved conversation history', {
        phone,
        messageCount: history.messages.length,
      });

      return history.messages;
    } catch (error) {
      logger.error('Failed to get conversation history', {
        phone,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return []; // Return empty on error to allow continuation
    }
  }

  /**
   * Add a message to conversation history
   */
  async addMessage(
    phone: string,
    role: 'user' | 'assistant',
    content: string
  ): Promise<void> {
    try {
      const client = RedisConfig.getClient();
      const key = this.getKey(phone);

      // Get existing history
      const messages = await this.getHistory(phone);

      // Add new message
      const newMessage: ConversationMessage = {
        role,
        content,
        timestamp: Date.now(),
      };

      messages.push(newMessage);

      // Keep only last N messages
      const trimmedMessages = messages.slice(-this.maxMessages);

      // Save back to Redis
      const history: ConversationHistory = {
        phone,
        messages: trimmedMessages,
        lastUpdated: Date.now(),
      };

      await client.setEx(key, this.ttl, JSON.stringify(history));

      logger.debug('Added message to conversation', {
        phone,
        role,
        totalMessages: trimmedMessages.length,
      });
    } catch (error) {
      logger.error('Failed to add message to conversation', {
        phone,
        role,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - we don't want to fail the request if Redis fails
    }
  }

  /**
   * Clear conversation history for a phone number
   */
  async clearHistory(phone: string): Promise<boolean> {
    try {
      const client = RedisConfig.getClient();
      const key = this.getKey(phone);

      const result = await client.del(key);

      logger.info('Cleared conversation history', {
        phone,
        existed: result > 0,
      });

      return result > 0;
    } catch (error) {
      logger.error('Failed to clear conversation history', {
        phone,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Get all active conversations (for monitoring/debugging)
   */
  async getActiveConversations(): Promise<string[]> {
    try {
      const client = RedisConfig.getClient();
      const pattern = `${this.keyPrefix}*`;

      const keys = await client.keys(pattern);
      
      // Extract phone numbers from keys
      const phones = keys.map((key) => key.replace(this.keyPrefix, ''));

      logger.debug('Retrieved active conversations', {
        count: phones.length,
      });

      return phones;
    } catch (error) {
      logger.error('Failed to get active conversations', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  /**
   * Get conversation statistics
   */
  async getStats(): Promise<{
    totalConversations: number;
    avgMessagesPerConversation: number;
  }> {
    try {
      const phones = await this.getActiveConversations();
      let totalMessages = 0;

      for (const phone of phones) {
        const history = await this.getHistory(phone);
        totalMessages += history.length;
      }

      return {
        totalConversations: phones.length,
        avgMessagesPerConversation:
          phones.length > 0 ? totalMessages / phones.length : 0,
      };
    } catch (error) {
      logger.error('Failed to get conversation stats', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return {
        totalConversations: 0,
        avgMessagesPerConversation: 0,
      };
    }
  }

  /**
   * Generate Redis key for a phone number
   */
  private getKey(phone: string): string {
    return `${this.keyPrefix}${phone}`;
  }
}

// Export singleton instance
export const conversationService = new ConversationService();
