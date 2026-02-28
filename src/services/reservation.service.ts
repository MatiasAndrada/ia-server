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
  private static readonly ZONES_CACHE_KEY_PREFIX = 'business:zones:';
  private static readonly ZONES_CACHE_TTL = 3600; // 1 hour cache

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
   * Zones/tables are now cached in Redis independently (not in draft)
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
    draft.step = 'zone_selection';
    
    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Load and cache zones/tables data in Redis for a business
   * This makes zones available for the entire conversation
   */
  static async loadAndCacheZones(businessId: string): Promise<void> {
    try {
      logger.info('Loading zones/tables into Redis cache', { businessId });
      
      const zones = await SupabaseService.getZonesByBusiness(businessId);
      const tables = await SupabaseService.getActiveTablesByBusiness(businessId);
      
      // Filter out invalid tables
      const validTables = tables.filter(t => 
        t.zone_id && 
        t.capacity !== null && 
        t.table_number !== null
      );
      
      const cacheData = {
        zones: zones.map(z => ({ id: z.id, name: z.name, priority: z.priority || 0 })),
        tables: validTables.map(t => ({
          id: t.id,
          zone_id: t.zone_id!,
          capacity: t.capacity!,
          table_number: t.table_number!,
          is_active: t.is_active !== false,
          is_occupied: t.is_occupied === true
        }))
      };
      
      const client = RedisConfig.getClient();
      const key = `${this.ZONES_CACHE_KEY_PREFIX}${businessId}`;
      await client.setEx(key, this.ZONES_CACHE_TTL, JSON.stringify(cacheData));
      
      
      logger.info('Zones data cached in Redis', {
        businessId,
        zonesCount: zones.length,
        tablesCount: validTables.length,
      });
    } catch (error) {
      logger.error('Error caching zones data', { error, businessId });
    }
  }

  /**
   * Get cached zones/tables data from Redis
   */
  static async getCachedZones(businessId: string): Promise<{
    zones: Array<{ id: string; name: string; priority: number }>;
    tables: Array<{ id: string; zone_id: string; capacity: number; table_number: string; is_active: boolean; is_occupied: boolean }>;
  } | null> {
    try {
      const client = RedisConfig.getClient();
      const key = `${this.ZONES_CACHE_KEY_PREFIX}${businessId}`;
      const cached = await client.get(key);
      
      if (!cached) {
        logger.warn('Zones cache miss', { businessId, key });
        await this.loadAndCacheZones(businessId);
        
        // Retry after loading
        const retryCache = await client.get(key);
        if (!retryCache) {
          logger.error('Zones cache still empty after reload', { businessId, key });
          return null;
        }
        const parsed = JSON.parse(retryCache);
        logger.info('Zones cache loaded after reload', {
          businessId,
          zonesCount: parsed?.zones?.length || 0,
          tablesCount: parsed?.tables?.length || 0,
        });
        return parsed;
      }
      
      const parsed = JSON.parse(cached);
      logger.info('Zones cache hit', {
        businessId,
        zonesCount: parsed?.zones?.length || 0,
        tablesCount: parsed?.tables?.length || 0,
      });
      return parsed;
    } catch (error) {
      logger.error('Error getting cached zones', { error, businessId });
      return null;
    }
  }

  /**
   * Filter cached zones by party size
   */
  static filterCachedZonesByPartySize(
    zonesData: {
      zones: Array<{ id: string; name: string; priority: number }>;
      tables: Array<{ id: string; zone_id: string; capacity: number; table_number: string; is_active: boolean; is_occupied: boolean }>;
    },
    partySize: number
  ): Map<string, { zoneId: string; tables: any[] }> {
    
    const { zones, tables } = zonesData;
    const zoneMap = new Map<string, { zoneId: string; tables: any[] }>();
    
    zones.forEach(zone => {
      // Filter active tables with capacity >= partySize
      const availableTables = tables.filter(
        table =>
          table.zone_id === zone.id &&
          table.is_active &&
          !table.is_occupied &&
          table.capacity >= partySize
      );
      
      
      if (availableTables.length > 0) {
        zoneMap.set(zone.name, {
          zoneId: zone.id,
          tables: availableTables,
        });
      }
    });
    
    
    return zoneMap;
  }

  /**
   * Get available zones and tables for a given party size
   * (Legacy method - still used for backward compatibility)
   */
  static async getAvailableZonesWithTables(
    businessId: string,
    partySize: number
  ): Promise<Map<string, { zoneId: string; tables: any[] }>> {
    try {
      
      const zones = await SupabaseService.getZonesByBusiness(businessId);
      const tables = await SupabaseService.getTablesByBusiness(businessId);


      // Filter tables by party size and group by zone
      const zoneMap = new Map<string, { zoneId: string; tables: any[] }>();

      zones.forEach(zone => {
        // FIXED: Proper parentheses for filter logic
        const availableTables = tables.filter(
          table =>
            table.zone_id === zone.id &&
            table.is_active !== false &&
            table.is_occupied !== true &&
            (!table.capacity || table.capacity >= partySize)
        );

        // Filter tables for this zone
        // const allTablesInZone = tables.filter(t => t.zone_id === zone.id);
        

        if (availableTables.length > 0) {
          zoneMap.set(zone.name, {
            zoneId: zone.id,
            tables: availableTables,
          });
        }
      });


      logger.info('Available zones with tables fetched', {
        businessId,
        partySize,
        zoneCount: zoneMap.size,
      });

      return zoneMap;
    } catch (error) {
      logger.error('Error getting available zones with tables', {
        error,
        businessId,
        partySize,
      });
      return new Map();
    }
  }

  /**
   * Get available zones for the business
   */
  static async getAvailableZones(businessId: string): Promise<string[]> {
    try {
      const zones = await SupabaseService.getZonesByBusiness(businessId);
      const tables = await SupabaseService.getTablesByBusiness(businessId);

      const availableZoneIds = new Set(
        tables
          .filter(table => table.zone_id && table.is_active !== false && table.is_occupied !== true)
          .map(table => table.zone_id as string)
      );

      return zones
        .filter(zone => availableZoneIds.has(zone.id))
        .map(zone => zone.name);
    } catch (error) {
      logger.error('Error getting available zones', { error, businessId });
      return [];
    }
  }

  /**
   * Select a zone
   */
  static async selectZone(
    conversationId: string,
    zone: string
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    
    if (!draft) {
      logger.warn('Draft not found for selecting zone', { conversationId });
      return null;
    }

    // Verify zone exists
    const zones = await this.getAvailableZones(draft.businessId);
    if (!zones.includes(zone)) {
      throw new Error('Selected zone is not available');
    }

    draft.selectedZoneId = zone;
    draft.step = 'confirmation';
    
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
        selectedZone: draft?.selectedZoneId,
      });

      if (!draft) {
        return {
          success: false,
          error: 'No reservation draft found',
        };
      }

      // Validate all required fields
      if (!draft.customerName || !draft.partySize || !draft.selectedZoneId) {
        logger.warn('❌ Incomplete reservation data', {
          conversationId,
          hasCustomerName: !!draft.customerName,
          hasPartySize: !!draft.partySize,
          hasSelectedZone: !!draft.selectedZoneId,
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
        zone: draft.selectedZoneId,
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
    field: 'party_size' | 'zone',
    existingData: { customerName?: string; partySize?: number; selectedZoneId?: string }
  ): Promise<ReservationDraft> {
    const step = field === 'party_size' ? 'party_size' : 'zone_selection';

    const draft: ReservationDraft = {
      conversationId,
      businessId,
      customerName: existingData.customerName,
      partySize: existingData.partySize,
      selectedZoneId: existingData.selectedZoneId,
      step,
      editMode: true,
      editingField: field,
      existingReservationId: reservationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.info('Edit reservation draft started', {
      conversationId,
      reservationId,
      field,
      step,
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
    existingData: { customerName?: string; partySize?: number; selectedZoneId?: string }
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      customerName: existingData.customerName,
      partySize: existingData.partySize,
      selectedZoneId: existingData.selectedZoneId,
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
