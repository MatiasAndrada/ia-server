import { RedisConfig } from '../config/redis.js';
import { SupabaseService } from './supabase.service.js';
import {
  ReservationDraft,
  CreateReservationRequest,
  CreateReservationResponse,
  WeeklyHours
} from '../types/index.js';
import { logger, logEvent } from '../utils/logger.js';
import { formatName } from '../utils/formatters.js';
import * as templates from '../utils/message-templates.js';
import {
  ParsedDay,
  formatBaDateKey,
  nowInBuenosAires,
  utcIsoToBaParts,
  describeBaDateKey,
  isDateBlocked,
  getBlockedDateReasonMessage,
  isFutureReservationBlockedToday,
} from '../utils/reservation-datetime.js';

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
        logger.debug('Redis not connected');
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
        logger.debug('Redis not connected');
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

      logger.debug('Reservation draft saved', { 
        conversationId: draft.conversationId,
        step: draft.step,
      });

      return true;
    } catch (error) {
      logger.error('Error saving reservation draft', {
        error,
        conversationId: draft.conversationId,
        step: draft.step,
      });
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

      logger.debug('Reservation draft deleted', { conversationId });
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
    businessId: string,
    awaitingLanguageChoice: boolean = false
  ): Promise<ReservationDraft> {
      logger.debug('Starting reservation flow', { businessId, conversationId });

    const draft: ReservationDraft = {
      conversationId,
      businessId,
      step: 'name',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (awaitingLanguageChoice) {
      draft.awaitingLanguageChoice = true;
    }

    await this.saveDraft(draft);
    logEvent('info', 'reservation.draft_started', {
      conversationId,
      businessId,
      awaitingLanguageChoice,
    });

    return draft;
  }

  /**
   * Clears the transient language-menu flag once the customer either picked a
   * language or answered with something else entirely (the non-blocking path).
   */
  static async clearLanguageChoicePending(conversationId: string): Promise<void> {
    const draft = await this.getDraft(conversationId);
    if (!draft?.awaitingLanguageChoice) return;

    delete draft.awaitingLanguageChoice;
    await this.saveDraft(draft);
  }

  /**
   * Start a reservation flow for a customer already known by phone (name +
   * apellido already on file): skips the `name`/`last_name` steps entirely
   * and drops the customer straight into `party_size`.
   */
  static async startReservationForKnownCustomer(
    conversationId: string,
    businessId: string,
    customerName: string,
    customerLastName?: string | null
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      step: 'party_size',
      customerName: formatName(customerName),
      customerLastName:
        customerLastName && customerLastName.trim().length > 0
          ? formatName(customerLastName)
          : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.debug('Reservation flow started for known customer (name step skipped)', {
      conversationId,
      businessId,
    });

    return draft;
  }

  static async startReservationSelection(
    conversationId: string,
    businessId: string,
    availableReservationIds: string[],
    pendingSelectionAction: 'edit' | 'cancel' = 'edit'
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      step: 'reservation_selection',
      availableReservationIds,
      pendingSelectionAction,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.debug('Reservation selection flow started', {
      conversationId,
      businessId,
      availableReservationIds,
      pendingSelectionAction,
    });
    return draft;
  }

  /**
   * Update draft with customer name only. The apellido is optional and is
   * never asked for separately — when the customer's reply didn't include
   * one, `customerLastName` is simply left unset and the flow advances
   * straight to `party_size`, same as {@link setCustomerNameParts}.
   */
  static async setCustomerName(
    conversationId: string,
    name: string
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);

    if (!draft) {
      logger.debug('Draft not found for setting name', { conversationId });
      return null;
    }

    // Format name with capitalized first letter of each word
    draft.customerName = formatName(name);
    draft.step = 'party_size';

    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Set both the first name and the apellido at once (e.g. the customer wrote
   * "Juan Pérez" in one message) and advance straight to the party_size step,
   * skipping the dedicated apellido question.
   */
  static async setCustomerNameParts(
    conversationId: string,
    name: string,
    lastName: string
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.debug('Draft not found for setting name parts', { conversationId });
      return null;
    }

    draft.customerName = formatName(name);
    draft.customerLastName = formatName(lastName);
    draft.step = 'party_size';

    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Set the apellido after it was asked in the `last_name` step and advance to
   * the party_size step. The `name` step no longer transitions into
   * `last_name` (the apellido is optional and is never asked separately) —
   * this only remains reachable for drafts already sitting at `last_name`
   * when this behavior shipped, so in-flight conversations don't break.
   */
  static async setCustomerLastName(
    conversationId: string,
    lastName: string
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.debug('Draft not found for setting last name', { conversationId });
      return null;
    }

    draft.customerLastName = formatName(lastName);
    draft.step = 'party_size';

    await this.saveDraft(draft);
    return draft;
  }

  /**
   * Update only the apellido without advancing the step (used when the customer
   * corrects it, mirroring {@link setNameOnly}).
   */
  static async setLastNameOnly(
    conversationId: string,
    lastName: string
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.debug('Draft not found for setLastNameOnly', { conversationId });
      return null;
    }

    draft.customerLastName = formatName(lastName);
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
      logger.debug('Draft not found for setNameOnly', { conversationId });
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
      logger.debug('Draft not found for setting party size', { conversationId });
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
      logger.debug('Draft not found for moveToScheduleChoice', { conversationId });
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
      logger.debug('Draft not found for setInstantSchedule', { conversationId });
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
    origin: 'schedule_choice' | 'time' | 'date'
  ): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.debug('Draft not found for moveToConfirmSlot', { conversationId });
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
      logger.debug('Draft not found for moveToDateStep', { conversationId });
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
      logger.debug('Draft not found for setting scheduled date', { conversationId });
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
      logger.debug('Draft not found for setting scheduled time', { conversationId });
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
      logger.debug('ReservationService.createReservation called', {
        conversationId,
        customerPhone,
      });

      const draft = await this.getDraft(conversationId);

      logger.debug('Draft retrieved', {
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
        logEvent('warn', 'reservation.rejected', {
          conversationId,
          reason: 'incomplete_data',
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
        customerLastName: draft.customerLastName ?? null,
        customerPhone,
        partySize: draft.partySize,
        scheduledAt: draft.scheduledAt ?? null,
        eventId: draft.eventId ?? null,
      };

      // Safety net: re-validate business-configured date blocks right before
      // creating, in case something slipped past the earlier conversational
      // checks (e.g. a date got blocked mid-conversation, or a future code
      // path sets scheduledAt without going through those checks).
      //
      // Las reservas de evento quedan fuera a propósito: la fecha la eligió el
      // comercio al publicar el evento, así que vale aunque ese día esté
      // bloqueado o el local no abra. Sin esta excepción, un evento en un día
      // cerrado se rechazaría acá, recién al final del flujo.
      if (request.scheduledAt && !request.eventId) {
        const { dateKey, hour, minute } = utcIsoToBaParts(request.scheduledAt);
        const [business, blockedDates] = await Promise.all([
          SupabaseService.getBusinessById(request.businessId),
          SupabaseService.getBlockedDates(request.businessId),
        ]);
        const weeklyHours = (business?.weekly_hours as WeeklyHours | null | undefined) ?? {};
        const closingMargin = business?.reservation_closing_margin_minutes ?? 15;
        const nowBA = nowInBuenosAires();

        if (isDateBlocked(dateKey, blockedDates)) {
          logEvent('warn', 'reservation.rejected', {
            conversationId,
            reason: 'date_blocked',
            businessId: request.businessId,
            dateKey,
          });
          return {
            success: false,
            error: 'Requested date is blocked',
            blockedMessage: templates.dateBlocked(describeBaDateKey(dateKey, nowBA), getBlockedDateReasonMessage(dateKey, blockedDates)),
          };
        }

        if (
          isFutureReservationBlockedToday(
            dateKey,
            hour,
            minute,
            nowBA,
            business?.future_reservations_blocked_for_date,
            weeklyHours,
            closingMargin
          )
        ) {
          logEvent('warn', 'reservation.rejected', {
            conversationId,
            reason: 'future_reservations_blocked_today',
            businessId: request.businessId,
            dateKey,
          });
          return {
            success: false,
            error: 'Future reservations blocked for today',
            blockedMessage: templates.futureReservationsBlockedToday(),
          };
        }
      }

      logger.debug('Sending reservation to Supabase', {
        conversationId,
        businessId: request.businessId,
        partySize: request.partySize,
        scheduledAt: request.scheduledAt,
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

      logger.debug('Supabase response', {
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
            logger.error('Error deleting completed draft', { error: err, conversationId });
          });
        }, 5000);

        // `reservation.created` sale del handler de WhatsApp, que tiene el
        // display_code y el status finales. Acá alcanza con la traza.
        logger.debug('Reservation persisted', {
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
        logger.debug('Redis not connected, reservation create lock skipped', {
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
    logger.debug('Edit reservation draft started', {
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
    logger.debug('Edit schedule draft started', {
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
    logger.debug('Edit menu draft started', { conversationId, reservationId });
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
    logger.debug('Edit date draft started', { conversationId, reservationId });
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
    logger.debug('Edit time draft started', { conversationId, reservationId });
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
    logger.debug('Cancel menu draft started', { conversationId, reservationId });
    return draft;
  }

  /**
   * Start the M3 cancellation flow directly at the confirm step (skips the
   * intermediate reprogramar/cancelar-definitivamente menu) — used when the
   * customer's own message already made the cancellation intent explicit
   * (e.g. typing "CANCELAR").
   */
  static async startCancelConfirm(
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
      step: 'cancel_confirm',
      editMode: true,
      existingReservationId: reservationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.debug('Cancel confirm draft started (direct)', { conversationId, reservationId });
    return draft;
  }

  /**
   * Start a lightweight draft to capture a natural-language request to change
   * the stored customer name/apellido (see the `edit_customer_name` step).
   */
  static async startCustomerNameEdit(
    conversationId: string,
    businessId: string,
    field: 'full' | 'lastName'
  ): Promise<ReservationDraft> {
    const draft: ReservationDraft = {
      conversationId,
      businessId,
      step: 'edit_customer_name',
      nameEditField: field,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveDraft(draft);
    logger.debug('Customer name edit draft started', { conversationId, field });
    return draft;
  }

  /**
   * Move a normal-mode draft to the pre-creation summary step (M1 "Resumen y confirmación").
   */
  static async moveToConfirmSummary(conversationId: string): Promise<ReservationDraft | null> {
    const draft = await this.getDraft(conversationId);
    if (!draft) {
      logger.debug('Draft not found for moveToConfirmSummary', { conversationId });
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
      logger.debug('Loading and caching all businesses...');

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

      logger.debug('All businesses cached in Redis', {
        count: businesses.length,
      });
    } catch (error) {
      logger.error('Error caching all businesses', { error });
    }
  }
}
