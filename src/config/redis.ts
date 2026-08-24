import { createClient, RedisClientType } from 'redis';
import { logger, logEvent } from '../utils/logger.js';

export class RedisConfig {
  private static client: RedisClientType;
  private static isConnected = false;
  /**
   * La primera conexión ya la reporta `dep.ready` desde el bootstrap; sólo las
   * siguientes son una recuperación real y merecen su propio evento.
   */
  private static hasConnectedOnce = false;

  static async initialize(redisUrl: string): Promise<void> {
    try {
      this.client = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logEvent('error', 'dep.degraded', {
                dependency: 'redis',
                reason: 'too many reconnection attempts, giving up',
                retries,
              });
              return new Error('Too many retries');
            }
            const delay = Math.min(retries * 100, 3000);
            logger.debug('Redis reconnect scheduled', { delayMs: delay, attempt: retries });
            return delay;
          },
        },
      });

      this.client.on('error', (err) => {
        logger.debug('Redis client error', { error: err });
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.debug('Redis connecting');
      });

      this.client.on('ready', () => {
        if (this.hasConnectedOnce) {
          logEvent('info', 'dep.recovered', { dependency: 'redis' });
        }
        this.hasConnectedOnce = true;
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        if (this.isConnected) {
          // Sólo la transición conectado → caído es noticia. Sin este guard, un
          // Redis apagado emitía un `warn` por cada intento del backoff.
          logEvent('warn', 'dep.degraded', { dependency: 'redis', reason: 'reconnecting' });
        }
        this.isConnected = false;
      });

      this.client.on('end', () => {
        logger.debug('Redis connection closed');
        this.isConnected = false;
      });

      await this.client.connect();
    } catch (error) {
      logEvent('error', 'dep.degraded', { dependency: 'redis', reason: 'initialization failed', error });
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
