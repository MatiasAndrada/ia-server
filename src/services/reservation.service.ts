import { RedisConfig } from '../config/redis';
import { SupabaseService } from './supabase.service';
import {
  ReservationDraft,
  CreateReservationRequest,
  CreateReservationResponse
} from '../types';
import { logger } from '../utils/logger';
import { formatName } from '../utils/formatters';
import { ParsedDay, formatBaDateKey } from '../utils/reservation-datetime';

export class ReservationService {
  private static readonly DRAFT_TTL = 3600; // 1 hour
  private static readonly DRAFT_KEY_PREFIX = 'reservation_draft:';
  private static readonly CREATE_LOCK_KEY_PREFIX = 'reservation_create_lock:';
  private static readonly CREATE_LOCK_TTL_SECONDS = Number(
    process.env.RESERVATION_CREATE_LOCK_TTL_SECONDS || 20
  );

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
   * Move the draft into the schedule_choice step after party size is confirmed.
   */
  static async moveToScheduleChoice(conversationId: string): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.warn('Draft not found for moveToScheduleChoice', { conversationId });
      return null;
    }

    draft.step = 'schedule_choice';
    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Customer chose the instant/current-turn reservation — clears any scheduling fields.
   */
  static async setInstantSchedule(conversationId: string): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.warn('Draft not found for setInstantSchedule', { conversationId });
      return null;
    }

    draft.scheduledDate = undefined;
    draft.scheduledTime = undefined;
    draft.scheduledAt = undefined;
    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Move the draft into the date step (asking which day within the next 7 days).
   */
  /**
   * Saves a pre-computed proposed slot into the draft and transitions to the
   * `confirm_slot` step, where the user must confirm "yes" or "no".
   */
  static async moveToConfirmSlot(
    conversationId: string,
    scheduledDate: string,
    scheduledTime: string,
    scheduledAt: string,
    origin: 'schedule_choice' | 'time'
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.warn('Draft not found for moveToConfirmSlot', { conversationId });
      return null;
    }

    draft.scheduledDate = scheduledDate;
    draft.scheduledTime = scheduledTime;
    draft.scheduledAt = scheduledAt;
    draft.confirmSlotOrigin = origin;
    draft.step = 'confirm_slot';
    await this.saveDraft(draft);
    return draft;
  }

  static async moveToDateStep(conversationId: string): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.warn('Draft not found for moveToDateStep', { conversationId });
      return null;
    }

    draft.step = 'date';
    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Update draft with the chosen day (within the next 7 days) and advance to the time step.
   */
  static async setScheduledDate(
    conversationId: string,
    parsedDay: ParsedDay
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.warn('Draft not found for setting scheduled date', { conversationId });
      return null;
    }

    draft.scheduledDate = formatBaDateKey(parsedDay.baDate);
    draft.step = 'time';
    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Update draft with the final scheduled instant (UTC ISO) combining the chosen day + time.
   */
  static async setScheduledTime(
    conversationId: string,
    scheduledTime: string,
    scheduledAt: string
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.warn('Draft not found for setting scheduled time', { conversationId });
      return null;
    }

    draft.scheduledTime = scheduledTime;
    draft.scheduledAt = scheduledAt;
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
    let acquiredLock: { key: string; token: string } | null = null;

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
        scheduledAt: draft.scheduledAt ?? null,
      };

      logger.info('📤 Sending reservation to Supabase', {
        conversationId,
        request,
      });

      acquiredLock = await this.acquireReservationCreateLock(
        request.businessId,
        customerPhone,
        conversationId
      );

      if (!acquiredLock) {
        const existingReservation = await this.waitForExistingActiveReservation(
          request.businessId,
          customerPhone
        );

        if (existingReservation) {
          logger.warn('Reservation create lock contention resolved as existing reservation', {
            conversationId,
            businessId: request.businessId,
            customerPhone,
            entryId: existingReservation.id,
          });
          return {
            success: true,
            waitlistEntry: existingReservation,
            alreadyExists: true,
          };
        }

        logger.warn('Reservation creation skipped due to active lock and no visible entry yet', {
          conversationId,
          businessId: request.businessId,
          customerPhone,
        });
        return {
          success: false,
          error: 'Reservation creation in progress, please retry in a few seconds',
        };
      }

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
    } finally {
      if (acquiredLock) {
        await this.releaseReservationCreateLock(acquiredLock.key, acquiredLock.token, conversationId);
      }
    }
  }

  private static getCreateLockTtlSeconds(): number {
    const configured = this.CREATE_LOCK_TTL_SECONDS;
    if (!Number.isFinite(configured) || configured < 5) {
      return 20;
    }
    return Math.floor(configured);
  }

  private static async acquireReservationCreateLock(
    businessId: string,
    customerPhone: string,
    conversationId: string
  ): Promise<{ key: string; token: string } | null> {
    try {
      if (!RedisConfig.isReady()) {
        logger.warn('Redis not connected, reservation create lock skipped', {
          businessId,
          conversationId,
          customerPhone,
        });
        return { key: '', token: '' };
      }

      const client = RedisConfig.getClient();
      const lockKey = `${this.CREATE_LOCK_KEY_PREFIX}${businessId}:${customerPhone}`;
      const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const wasSet = await client.set(lockKey, lockToken, {
        NX: true,
        EX: this.getCreateLockTtlSeconds(),
      });

      if (!wasSet) {
        return null;
      }

      return { key: lockKey, token: lockToken };
    } catch (error) {
      logger.error('Error acquiring reservation create lock', {
        error,
        businessId,
        conversationId,
        customerPhone,
      });
      return null;
    }
  }

  private static async releaseReservationCreateLock(
    lockKey: string,
    token: string,
    conversationId: string
  ): Promise<void> {
    try {
      if (!lockKey) {
        return;
      }

      if (!RedisConfig.isReady()) {
        return;
      }

      const client = RedisConfig.getClient();
      const currentValue = await client.get(lockKey);
      if (currentValue === token) {
        await client.del(lockKey);
      }
    } catch (error) {
      logger.error('Error releasing reservation create lock', {
        error,
        lockKey,
        conversationId,
      });
    }
  }

  private static async waitForExistingActiveReservation(
    businessId: string,
    customerPhone: string
  ): Promise<CreateReservationResponse['waitlistEntry'] | null> {
    const attempts = 5;
    const delayMs = 300;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const existingReservation = await SupabaseService.getActiveReservationByPhone(
        customerPhone,
        businessId
      );

      if (existingReservation) {
        return existingReservation;
      }

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return null;
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
   * Start an edit-mode draft to modify the day/time of an existing reservation.
   * Reuses the same schedule_choice → date → time steps as creation; the only
   * difference is that completing the flow updates the existing entry instead
   * of creating a new one (see editMode/editingField === 'schedule' handling
   * in WhatsAppHandler).
   */
  static async startEditSchedule(
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
      step: 'schedule_choice',
      editMode: true,
      editingField: 'schedule',
      existingReservationId: reservationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.info('Edit schedule draft started', {
      conversationId,
      reservationId,
      step: 'schedule_choice',
    });
    return draft;
  }

  /**
   * Start an edit-menu draft so the user can pick what to edit.
   * `existingData.scheduledAt` (the reservation's current UTC instant, if any)
   * is stashed on the draft so date-only / time-only edits can keep the other half.
   */
  static async startEditMenu(
    conversationId: string,
    businessId: string,
    reservationId: string,
    existingData: { customerName?: string; partySize?: number; scheduledAt?: string | null }
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      customerName: existingData.customerName,
      partySize: existingData.partySize,
      scheduledAt: existingData.scheduledAt ?? undefined,
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
   * Start an edit-mode draft to change ONLY the day of an existing scheduled
   * reservation, keeping its current time (pre-loaded from `scheduledAt`).
   */
  static async startEditDate(
    conversationId: string,
    businessId: string,
    reservationId: string,
    existingData: { customerName?: string; partySize?: number },
    existingTime: { dateKey: string; hour: number; minute: number }
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      customerName: existingData.customerName,
      partySize: existingData.partySize,
      scheduledTime: `${String(existingTime.hour).padStart(2, '0')}:${String(existingTime.minute).padStart(2, '0')}`,
      step: 'date',
      editMode: true,
      editingField: 'date',
      existingReservationId: reservationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.info('Edit date draft started', { conversationId, reservationId });
    return draft;
  }

  /**
   * Start an edit-mode draft to change ONLY the time of an existing
   * reservation, keeping its current day (pre-loaded; today for instant ones).
   */
  static async startEditTime(
    conversationId: string,
    businessId: string,
    reservationId: string,
    existingData: { customerName?: string; partySize?: number },
    existingDateKey: string
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      customerName: existingData.customerName,
      partySize: existingData.partySize,
      scheduledDate: existingDateKey,
      step: 'time',
      editMode: true,
      editingField: 'time',
      existingReservationId: reservationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.info('Edit time draft started', { conversationId, reservationId });
    return draft;
  }

  /**
   * Start the M3 cancellation menu (reprogramar / cancelar definitivamente)
   * for an existing active reservation.
   */
  static async startCancelMenu(
    conversationId: string,
    businessId: string,
    reservationId: string,
    existingData: { customerName?: string; partySize?: number; scheduledAt?: string | null }
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      customerName: existingData.customerName,
      partySize: existingData.partySize,
      scheduledAt: existingData.scheduledAt ?? undefined,
      step: 'cancel_menu',
      editMode: true,
      existingReservationId: reservationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.info('Cancel menu draft started', { conversationId, reservationId });
    return draft;
  }

  /**
   * Move a normal-mode draft to the pre-creation summary step (M1 "Resumen y confirmación").
   */
  static async moveToConfirmSummary(conversationId: string): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.warn('Draft not found for moveToConfirmSummary', { conversationId });
      return null;
    }

    draft.step = 'confirm_summary';
    draft.returnToSummary = false;
    draft.invalidAttempts = 0;
    await this.saveDraft(draft);
    return draft;
  }

  // ========================
  // Business Cache Methods
  // ========================

  private static readonly BUSINESS_CACHE_KEY_PREFIX = 'business:';
  private static readonly BUSINESS_CACHE_TTL = 3600; // 1 hour cache
  private static readonly BUSINESSES_LIST_CACHE_KEY = 'businesses:all';

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
}
