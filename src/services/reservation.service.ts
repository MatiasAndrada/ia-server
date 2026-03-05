import { RedisConfig } from '../config/redis';
import { SupabaseService } from './supabase.service';
import { 
  ReservationDraft, 
  CreateReservationRequest,
  CreateReservationResponse 
} from '../types';
import { logger } from '../utils/logger';
import { formatName } from '../utils/formatters';

export class ReservationService {
  private static readonly DRAFT_TTL = 3600; // 1 hour
  private static readonly DRAFT_KEY_PREFIX = 'reservation_draft:';

  /**
   * Get or create a reservation draft
   */
  static async getDraft(conversationId: string): Promise<ReservationDraft | null> {
    try {
      if (!RedisConfig.isReady()) {
        logger.warn('Redis not connected');
        return null;
      }

      const client = RedisConfig.getClient();
      const key = `${this.DRAFT_KEY_PREFIX}${conversationId}`;
      const data = await client.get(key);

      if (!data) {
        return null;
      }

      return JSON.parse(data) as ReservationDraft;
    } catch (error) {
      logger.error('Error getting reservation draft', { error, conversationId });
      return null;
    }
  }

  /**
   * Save or update reservation draft
   */
  static async saveDraft(draft: ReservationDraft): Promise<boolean> {
    try {
      if (!RedisConfig.isReady()) {
        logger.warn('Redis not connected');
        return false;
      }

      const client = RedisConfig.getClient();
      const key = `${this.DRAFT_KEY_PREFIX}${draft.conversationId}`;
      
      draft.updatedAt = Date.now();

      await client.setEx(
        key,
        this.DRAFT_TTL,
        JSON.stringify(draft)
      );

      logger.info('Reservation draft saved', { 
        conversationId: draft.conversationId,
        step: draft.step,
      });

      return true;
    } catch (error) {
      logger.error('Error saving reservation draft', { error, draft });
      return false;
    }
  }

  /**
   * Delete reservation draft
   */
  static async deleteDraft(conversationId: string): Promise<boolean> {
    try {
      if (!RedisConfig.isReady()) {
        return false;
      }

      const client = RedisConfig.getClient();
      const key = `${this.DRAFT_KEY_PREFIX}${conversationId}`;
      await client.del(key);

      logger.info('Reservation draft deleted', { conversationId });
      return true;
    } catch (error) {
      logger.error('Error deleting reservation draft', { error, conversationId });
      return false;
    }
  }

  /**
   * Start a new reservation flow
   */
  static async startReservation(
    conversationId: string,
    businessId: string
  ): Promise<ReservationDraft> {
      logger.info('Starting reservation flow', { businessId, conversationId });
    
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      step: 'name',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.info('Reservation flow started', { 
      conversationId, 
      businessId
    });
    
    return draft;
  }

  /**
   * Update draft with customer name
   */
  static async setCustomerName(
    conversationId: string,
    name: string
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    
    if (!draft) {
      logger.warn('Draft not found for setting name', { conversationId });
      return null;
    }

    // Format name with capitalized first letter of each word
    draft.customerName = formatName(name);
    draft.step = 'party_size';
    
    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Update only the name in the draft without advancing the step.
   * Used when the user corrects their name while already at party_size step.
   */
  static async setNameOnly(
    conversationId: string,
    name: string
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);

    if (!draft) {
      logger.warn('Draft not found for setNameOnly', { conversationId });
      return null;
    }

    draft.customerName = formatName(name);
    // step intentionally NOT changed — stays at party_size
    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Update draft with party size
   */
  static async setPartySize(
    conversationId: string,
    partySize: number
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    
    if (!draft) {
      logger.warn('Draft not found for setting party size', { conversationId });
      return null;
    }

    if (partySize < 1 || partySize > 50) {
      throw new Error('Party size must be between 1 and 50');
    }

    draft.partySize = partySize;
    // Step stays at 'party_size' — createAndNotifyReservation is called immediately after
    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Create the reservation in Supabase
   */
  static async createReservation(
    conversationId: string,
    customerPhone: string
  ): Promise<CreateReservationResponse> {
    try {
      logger.info('💾 ReservationService.createReservation called', {
        conversationId,
        customerPhone,
      });

      const draft = await this.getDraft(conversationId);

      logger.info('📋 Draft retrieved', {
        conversationId,
        hasDraft: !!draft,
        draftStep: draft?.step,
        customerName: draft?.customerName,
        partySize: draft?.partySize,
      });

      if (!draft) {
        return {
          success: false,
          error: 'No reservation draft found',
        };
      }

      // Validate all required fields
      if (!draft.customerName || !draft.partySize) {
        logger.warn('❌ Incomplete reservation data', {
          conversationId,
          hasCustomerName: !!draft.customerName,
          hasPartySize: !!draft.partySize,
        });
        return {
          success: false,
          error: 'Incomplete reservation data',
        };
      }

      // Create reservation request
      const request: CreateReservationRequest = {
        businessId: draft.businessId,
        customerName: draft.customerName,
        customerPhone,
        partySize: draft.partySize,
      };

      logger.info('📤 Sending reservation to Supabase', {
        conversationId,
        request,
      });

      // Create reservation in Supabase
      const result = await SupabaseService.createReservation(request);

      logger.info('📥 Supabase response', {
        conversationId,
        success: result.success,
        error: result.error,
        waitlistEntryId: result.waitlistEntry?.id,
      });

      if (result.success) {
        // Mark draft as completed
        draft.step = 'completed';
        await this.saveDraft(draft);

        // Delete draft after a short delay
        setTimeout(() => {
          this.deleteDraft(conversationId).catch((err) => {
            logger.error('Error deleting completed draft', { err, conversationId });
          });
        }, 5000);

        logger.info('Reservation created successfully', {
          conversationId,
          entryId: result.waitlistEntry?.id,
        });
      }

      return result;
    } catch (error) {
      logger.error('Error creating reservation', { error, conversationId });
      return {
        success: false,
        error: 'Error creating reservation',
      };
    }
  }

  /**
   * Start an edit-mode draft to modify a specific field of an existing reservation.
   */
  static async startEditReservation(
    conversationId: string,
    businessId: string,
    reservationId: string,
    existingData: { customerName?: string; partySize?: number }
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      customerName: existingData.customerName,
      partySize: existingData.partySize,
      step: 'party_size',
      editMode: true,
      editingField: 'party_size',
      existingReservationId: reservationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.info('Edit reservation draft started', {
      conversationId,
      reservationId,
      step: 'party_size',
    });
    return draft;
  }

  /**
   * Start an edit-menu draft so the user can pick what to edit.
   */
  static async startEditMenu(
    conversationId: string,
    businessId: string,
    reservationId: string,
    existingData: { customerName?: string; partySize?: number }
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      customerName: existingData.customerName,
      partySize: existingData.partySize,
      step: 'edit_menu',
      editMode: true,
      existingReservationId: reservationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.info('Edit menu draft started', { conversationId, reservationId });
    return draft;
  }

  /**
   * Check if a conversation has an active reservation draft
   */
  static async hasActiveDraft(conversationId: string): Promise<boolean> {
    const draft = await this.getDraft(conversationId);
    return draft !== null && draft.step !== 'completed';
  }

  /**
   * Get current step of reservation
   */
  static async getCurrentStep(conversationId: string): Promise<string | null> {
    const draft = await this.getDraft(conversationId);
    return draft?.step || null;
  }

  // ========================
  // Business Cache Methods
  // ========================

  private static readonly BUSINESS_CACHE_KEY_PREFIX = 'business:';
  private static readonly BUSINESS_CACHE_TTL = 3600; // 1 hour cache
  private static readonly BUSINESSES_LIST_CACHE_KEY = 'businesses:all';

  /**
   * Load and cache a single business in Redis
   */
  static async loadAndCacheBusiness(businessId: string): Promise<void> {
    try {
      logger.info('💾 Loading and caching business...', { businessId });

      const business = await SupabaseService.getBusinessById(businessId);

      if (!business) {
        logger.warn('Business not found in Supabase', { businessId });
        return;
      }

      const client = RedisConfig.getClient();
      const key = `${this.BUSINESS_CACHE_KEY_PREFIX}${businessId}`;

      await client.setEx(
        key,
        this.BUSINESS_CACHE_TTL,
        JSON.stringify(business)
      );

      logger.info('✅ Business cached in Redis', {
        businessId,
        businessName: business.name,
      });
    } catch (error) {
      logger.error('Error caching business', { error, businessId });
    }
  }

  /**
   * Load and cache all businesses in Redis
   */
  static async loadAndCacheAllBusinesses(): Promise<void> {
    try {
      logger.info('💾 Loading and caching all businesses...');

      const businesses = await SupabaseService.getAllBusinesses();

      if (!businesses || businesses.length === 0) {
        logger.warn('No businesses found in Supabase');
        return;
      }

      const client = RedisConfig.getClient();

      // Cache each business individually
      for (const business of businesses) {
        const key = `${this.BUSINESS_CACHE_KEY_PREFIX}${business.id}`;
        await client.setEx(
          key,
          this.BUSINESS_CACHE_TTL,
          JSON.stringify(business)
        );
      }

      // Also cache the list of all business IDs
      const businessIds = businesses.map((b) => b.id);
      await client.setEx(
        this.BUSINESSES_LIST_CACHE_KEY,
        this.BUSINESS_CACHE_TTL,
        JSON.stringify(businessIds)
      );

      logger.info('✅ All businesses cached in Redis', {
        count: businesses.length,
      });
    } catch (error) {
      logger.error('Error caching all businesses', { error });
    }
  }

  /**
   * Get cached business from Redis
   */
  static async getCachedBusiness(businessId: string): Promise<any | null> {
    try {
      const client = RedisConfig.getClient();
      const key = `${this.BUSINESS_CACHE_KEY_PREFIX}${businessId}`;
      const cached = await client.get(key);

      if (!cached) {
        await this.loadAndCacheBusiness(businessId);

        // Retry after loading
        const retryCache = await client.get(key);
        if (!retryCache) return null;
        return JSON.parse(retryCache);
      }

      return JSON.parse(cached);
    } catch (error) {
      logger.error('Error getting cached business', { error, businessId });
      return null;
    }
  }

  /**
   * Get cached list of all business IDs
   */
  static async getCachedBusinessIds(): Promise<string[]> {
    try {
      const client = RedisConfig.getClient();
      const cached = await client.get(this.BUSINESSES_LIST_CACHE_KEY);

      if (!cached) {
        await this.loadAndCacheAllBusinesses();

        // Retry after loading
        const retryCache = await client.get(this.BUSINESSES_LIST_CACHE_KEY);
        if (!retryCache) return [];
        return JSON.parse(retryCache);
      }

      return JSON.parse(cached);
    } catch (error) {
      logger.error('Error getting cached business IDs', { error });
      return [];
    }
  }

  /**
   * Invalidate business cache
   */
  static async invalidateBusinessCache(businessId: string): Promise<void> {
    try {
      const client = RedisConfig.getClient();
      const key = `${this.BUSINESS_CACHE_KEY_PREFIX}${businessId}`;

      await client.del(key);

      // Also invalidate the business list
      await client.del(this.BUSINESSES_LIST_CACHE_KEY);

      logger.info('🔄 Business cache invalidated', { businessId });
    } catch (error) {
      logger.error('Error invalidating business cache', { error, businessId });
    }
  }

  /**
   * Invalidate all business caches
   */
  static async invalidateAllBusinessCaches(): Promise<void> {
    try {
      const client = RedisConfig.getClient();

      // Get all cached business IDs
      const businessIds = await this.getCachedBusinessIds();

      // Delete each business cache
      for (const businessId of businessIds) {
        const key = `${this.BUSINESS_CACHE_KEY_PREFIX}${businessId}`;
        await client.del(key);
      }

      // Delete the business list cache
      await client.del(this.BUSINESSES_LIST_CACHE_KEY);

      logger.info('🔄 All business caches invalidated', { count: businessIds.length });
    } catch (error) {
      logger.error('Error invalidating all business caches', { error });
    }
  }
}
