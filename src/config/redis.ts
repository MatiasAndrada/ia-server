import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export class RedisConfig {
  private static client: RedisClientType;
  private static isConnected = false;

  static async initialize(redisUrl: string): Promise<void> {
    try {
      this.client = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logger.error('Redis: Too many reconnection attempts, giving up');
              return new Error('Too many retries');
            }
            const delay = Math.min(retries * 100, 3000);
            logger.warn(`Redis: Reconnecting in ${delay}ms (attempt ${retries})`);
            return delay;
          },
        },
      });

      this.client.on('error', (err) => {
        logger.error('Redis Client Error:', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis: Connecting...');
      });

      this.client.on('ready', () => {
        logger.info('Redis: Connected and ready');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        logger.warn('Redis: Reconnecting...');
        this.isConnected = false;
      });

      this.client.on('end', () => {
        logger.info('Redis: Connection closed');
        this.isConnected = false;
      });

      await this.client.connect();
    } catch (error) {
      logger.error('Redis: Failed to initialize:', error);
      throw error;
    }
  }

  static getClient(): RedisClientType {
    if (!this.client) {
      throw new Error('Redis client not initialized. Call initialize() first.');
    }
    return this.client;
  }

  static isReady(): boolean {
    return this.isConnected && this.client?.isOpen;
  }

  static async healthCheck(): Promise<boolean> {
    try {
      if (!this.isReady()) {
        return false;
      }
      await this.client.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  static async disconnect(): Promise<void> {
    if (this.client && this.client.isOpen) {
      await this.client.quit();
      this.isConnected = false;
    }
  }
}
