import { RedisConfig } from '../config/redis';
import { BusinessContext, CachedBusinessContext } from '../types';
import { logger } from '../utils/logger';

export class CacheService {
  private readonly businessKeyPrefix = 'business:';
  private readonly businessCacheTTL = 5 * 60; // 5 minutes in seconds

  /**
   * Get cached business context
   */
  async getBusinessContext(businessId: string): Promise<BusinessContext | null> {
    try {
      const client = RedisConfig.getClient();
      const key = this.getBusinessKey(businessId);

      const data = await client.get(key);

      if (!data) {
        logger.debug('Business context cache miss', { businessId });
        return null;
      }

      const cached: CachedBusinessContext = JSON.parse(data);

      // Check if expired (extra safety check)
      if (cached.expiresAt < Date.now()) {
        logger.debug('Business context cache expired', { businessId });
        await client.del(key);
        return null;
      }

      logger.debug('Business context cache hit', { businessId });

      // Return without cache metadata
      const { cachedAt, expiresAt, ...context } = cached;
      return context;
    } catch (error) {
      logger.error('Failed to get cached business context', {
        businessId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Set business context in cache
   */
  async setBusinessContext(
    businessId: string,
    context: BusinessContext
  ): Promise<void> {
    try {
      const client = RedisConfig.getClient();
      const key = this.getBusinessKey(businessId);

      const now = Date.now();
      const cached: CachedBusinessContext = {
        ...context,
        cachedAt: now,
        expiresAt: now + this.businessCacheTTL * 1000,
      };

      await client.setEx(key, this.businessCacheTTL, JSON.stringify(cached));

      logger.debug('Business context cached', { businessId });
    } catch (error) {
      logger.error('Failed to cache business context', {
        businessId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - caching failure shouldn't break the request
    }
  }

  /**
   * Invalidate business context cache
   */
  async invalidateBusinessContext(businessId: string): Promise<void> {
    try {
      const client = RedisConfig.getClient();
      const key = this.getBusinessKey(businessId);

      await client.del(key);

      logger.info('Business context cache invalidated', { businessId });
    } catch (error) {
      logger.error('Failed to invalidate business context', {
        businessId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get or set business context (cache-aside pattern)
   */
  async getOrSetBusinessContext(
    businessId: string,
    fetchFn: () => Promise<BusinessContext>
  ): Promise<BusinessContext> {
    // Try to get from cache first
    const cached = await this.getBusinessContext(businessId);
    
    if (cached) {
      return cached;
    }

    // Cache miss - fetch fresh data
    logger.debug('Fetching fresh business context', { businessId });
    const context = await fetchFn();

    // Store in cache for next time
    await this.setBusinessContext(businessId, context);

    return context;
  }

  /**
   * Clear all business caches
   */
  async clearAllBusinessCaches(): Promise<number> {
    try {
      const client = RedisConfig.getClient();
      const pattern = `${this.businessKeyPrefix}*`;

      const keys = await client.keys(pattern);
      
      if (keys.length === 0) {
        return 0;
      }

      const deleted = await client.del(keys);

      logger.info('Cleared all business caches', { count: deleted });

      return deleted;
    } catch (error) {
      logger.error('Failed to clear business caches', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return 0;
    }
  }

  /**
   * Generate Redis key for business context
   */
  private getBusinessKey(businessId: string): string {
    return `${this.businessKeyPrefix}${businessId}`;
  }
}

// Export singleton instance
export const cacheService = new CacheService();
