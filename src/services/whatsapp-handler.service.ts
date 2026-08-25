import { BaileysService } from './baileys.service.js';
import { agentService } from './agent.service.js';
import { openRouterService } from './openrouter.service.js';
import { ReservationService } from './reservation.service.js';
import { SupabaseService } from './supabase.service.js';
import { SupabaseConfig } from '../config/supabase.js';
import { RedisConfig } from '../config/redis.js';
import { agentRegistry } from '../agents/index.js';
import { BaileysMessage, BlockedDateEntry, Business, BusinessEvent, Customer, ReservationDraft, WaitlistEntry, WeeklyHours } from '../types/index.js';
import { logger, logEvent } from '../utils/logger.js';
import { withLogContext } from '../utils/log-context.js';
import { normalizePhone } from '../utils/phone.js';
import {
  clearNotified,
  createdNotificationKey,
  ECHO_TTL_SECONDS,
  markNotified,
  statusNotificationKey,
} from '../utils/notification-dedup.js';
import {
  withTurnStats,
  recordOutbound,
  recordDraftStep,
  recordBlocked,
} from '../utils/turn-stats.js';
import { runWithLanguage, currentLanguage, SupportedLanguage, DEFAULT_LANGUAGE, ALL_CATALOGS } from '../i18n/index.js';
import {
  cacheDetectedLanguage,
  persistLanguage,
  resolveLanguage,
} from '../i18n/language-store.js';
import {
  detectLanguage,
  detectLanguageChangeRequest,
  parseLanguageMenuChoice,
  DETECTION_THRESHOLD,
} from '../i18n/detect.js';
import { isMultilingualGreeting } from '../i18n/keywords.js';
import { extractReservationUpdate, ReservationSlots } from './reservation-nlu.service.js';
import { planReservationActions, countActionableIntents, PlannedAction } from './reservation-planner.service.js';
import {
  evaluateReservationScope,
  isGreetingOrReservationOptInMessage,
  isObviouslyGibberish,
  isInstantChoiceMessage,
  isPureNoiseMessage,
  normalizeReservationScopeText,
  hasDateOrTimeSignal,
  isAskingOtherDaysScheduleMessage,
} from '../utils/reservation-scope.js';
import {
  nowInBuenosAires,
  parseRelativeDay,
  isWithinNextWeek,
  parseTimeOfDay,
  combineToUtcISO,
  isInPast,
  parseBaDateKey,
  formatBaDateKey,
  describeScheduledDateTime,
  describeScheduledAtUtc,
  describeBaDateKey,
  isDayOpen,
  checkBusinessHours,
  findNextOpenSlot,
  findNextSlotOnDay,
  findSoonestBookableSlot,
  findCurrentShiftClose,
  formatDayHoursForDate,
  addBaDays,
  formatDayLabel,
  startOfBaDay,
  findWeekdayDayNumberMismatch,
  utcIsoToBaParts,
  isDateBlocked,
  isFutureReservationBlockedToday,
  isWithinCurrentShift,
  hasBookableMomentLeftToday,
  formatBookableDays,
  getUpcomingOpenDaysWithHours,
  type ParsedDay,
} from '../utils/reservation-datetime.js';
import * as templates from '../utils/message-templates.js';
import { formatBusinessAddress, formatWeeklyHoursForPrompt } from '../utils/prompts.js';

type ActiveReservationSnapshot = {
  status: 'WAITING' | 'CONFIRMED' | 'NOTIFIED';
  displayCode: string | null;
};

/** How long (ms) to wait for more messages before processing the batch. */
const DEBOUNCE_MS = 1500;
const DUPLICATE_OUTBOUND_WINDOW_MS = 10000;
const INACTIVE_FALLBACK_TTL_SECONDS = 120;
/**
 * Todas las variantes localizadas de `inactiveFallback()` (una por idioma
 * soportado), para que `sanitizeAgentResponse` pueda reconocer y limpiar el
 * fallback sin importar en qué idioma haya salido — un regex fijo en español
 * no detectaba la variante en/pt y la dejaba duplicada en la respuesta final.
 */
const INACTIVE_FALLBACK_MESSAGES = Object.values(ALL_CATALOGS).map((c) => c.inactiveFallback());

export class WhatsAppHandler {
  private baileysService: BaileysService;
  private lastSentByChat: Map<string, { text: string; timestamp: number }> = new Map();

  /**
   * Debounce buffer: accumulates rapid messages per conversation.
   * When the timer fires the whole batch is merged into one text and processed once.
   */
  private debounceBuffer: Map<
    string,
    { messages: BaileysMessage[]; timer: ReturnType<typeof setTimeout> }
  > = new Map();

  /**
   * Per-conversation processing lock.
   * Ensures that if a new batch arrives while the previous one is still being
   * processed (e.g. slow AI), the new batch waits instead of running in parallel.
   */
  private processingLock: Map<string, Promise<void>> = new Map();

  /**
   * Pending messages that arrived while a conversation was being processed.
   * After the current processing finishes, these are merged and re-processed
   * so the bot always responds to the full context.
   */
  private pendingWhileProcessing: Map<string, BaileysMessage[]> = new Map();

  constructor(baileysService: BaileysService) {
    this.baileysService = baileysService;
  }

  /**
   * Debounce incoming messages per conversation.
   * Multiple messages arriving within DEBOUNCE_MS are merged into a single call
   * to _processMessage, producing exactly one response.
   *
   * If a previous batch is still being processed (LLM latency), incoming
   * messages are coalesced into a pending buffer. When the in-flight processing
   * finishes, the pending buffer is drained and merged into a single call,
   * ensuring the bot always responds to the latest user context.
   */
  async processMessage(message: BaileysMessage): Promise<void> {
    const { from, businessId } = message;
    const phone = this.normalizeWhatsAppNumber(from);
    const conversationId = `${businessId}-${phone}`;

    // If there is active processing for this conversation (LLM in-flight),
    // accumulate the message for processing after the current one finishes.
    if (this.processingLock.has(conversationId)) {
      const pending = this.pendingWhileProcessing.get(conversationId) ?? [];
      pending.push(message);
      this.pendingWhileProcessing.set(conversationId, pending);
      logger.debug('Message queued while processing in-flight', {
        conversationId,
        pendingCount: pending.length,
        text: message.message.substring(0, 80),
      });
      return;
    }

    const existing = this.debounceBuffer.get(conversationId);
    if (existing) {
      // More messages were received before the timer fired; accumulate and reset timer
      clearTimeout(existing.timer);
      existing.messages.push(message);
    }

    const entry = existing ?? { messages: [message], timer: undefined as any };

    const timer = setTimeout(() => {
      this.debounceBuffer.delete(conversationId);
      this.dispatchBatch(conversationId, entry.messages);
    }, DEBOUNCE_MS);

    entry.timer = timer;
    if (!existing) {
      this.debounceBuffer.set(conversationId, entry);
    }
  }

  /**
   * Merge a batch of messages and process them, then drain any pending messages
   * that arrived during processing.
   */
  private dispatchBatch(conversationId: string, batch: BaileysMessage[]): void {
    // Deduplicate consecutive identical messages before joining (e.g. user tapping "Si" twice fast
    // would otherwise merge to "Si\nSi" → normalized "si si" → no opt-in pattern match → loop).
    const deduplicatedTexts = batch
      .map(m => m.message)
      .filter((msg, idx, arr) => idx === 0 || msg.trim() !== arr[idx - 1].trim());

    const combined: BaileysMessage = {
      ...batch[0],
      message: deduplicatedTexts.join('\n'),
    };

    if (batch.length > 1) {
      logger.debug('Batching rapid messages into one', {
        conversationId,
        count: batch.length,
        combined: combined.message.substring(0, 120),
      });
    }

    // Serialize against any in-progress processing for this conversation
    const previous = this.processingLock.get(conversationId) ?? Promise.resolve();
    const current = previous
      .then(() => this.runTurn(conversationId, combined))
      .catch(error => { logger.error('Error in _processMessage', { conversationId, error }); })
      .finally(() => {
        // Remove the lock BEFORE draining pending so the next batch can re-acquire it.
        if (this.processingLock.get(conversationId) === current) {
          this.processingLock.delete(conversationId);
        }

        // Drain any messages that accumulated while we were processing.
        const pending = this.pendingWhileProcessing.get(conversationId);
        if (pending && pending.length > 0) {
          this.pendingWhileProcessing.delete(conversationId);
          logger.debug('Draining pending messages accumulated during processing', {
            conversationId,
            count: pending.length,
          });
          this.dispatchBatch(conversationId, pending);
        }
      });
    this.processingLock.set(conversationId, current);
  }

  /**
   * Envuelve un turno completo: abre el contexto de log (para que todo lo que
   * se emita adentro lleve `conversationId`/`businessId`/`phone` sin repetirlo
   * a mano) y cierra con una única línea `turn.completed`.
   *
   * Esa línea es el índice del sistema: con `grep '"event":"turn.completed"'`
   * se ve el estado de todas las conversaciones, y recién si algo se ve mal
   * hace falta bajar a `LOG_LEVEL=debug` a leer la traza.
   */
  private async runTurn(conversationId: string, message: BaileysMessage): Promise<void> {
    const startedAt = Date.now();
    const phone = this.normalizeWhatsAppNumber(message.from);

    await withLogContext(
      { businessId: message.businessId, phone, conversationId },
      () =>
        withTurnStats(async (stats) => {
          try {
            await this._processMessage(message);
          } finally {
            logEvent('info', 'turn.completed', {
              durationMs: Date.now() - startedAt,
              llmCalls: stats.llmCalls,
              llmMs: stats.llmMs,
              outbound: stats.outbound,
              language: currentLanguage(),
              ...(stats.step && { step: stats.step }),
              ...(stats.blocked && { blocked: stats.blocked }),
            });
          }
        })
    );
  }

  /**
   * Internal processor — receives one (possibly merged) message per invocation.
   */
  /**
   * Resolves the conversation language and runs the whole turn inside that
   * language context, so every `templates.*` call downstream emits in the
   * customer's language without any of the ~200 call sites knowing about it.
   *
   * Language resolution happens BEFORE the inactive-service check on purpose —
   * that fallback message is customer-facing too.
   */
  private async _processMessage(message: BaileysMessage): Promise<void> {
    // Hoisted so the catch below can still answer in the customer's language.
    // `runWithLanguage` is AsyncLocalStorage.run: the store is already gone by the
    // time a rejection resumes here, so the catch would otherwise fall back to
    // Spanish for an EN/PT customer. Re-entering the context explicitly fixes that.
    let resolvedLanguage: SupportedLanguage = DEFAULT_LANGUAGE;

    try {
      const { from, message: messageText, businessId, fromMe } = message;
      if (this.shouldIgnoreMessage(from, messageText, fromMe, businessId)) {
        return;
      }

      // Normalize WhatsApp JID to raw phone number (strip domain and device suffix)
      const phone = this.normalizeWhatsAppNumber(from);
      const conversationId = `${businessId}-${phone}`;

      // Cache the JID mapping in Redis for future outbound messages
      // This ensures we send to the correct JID (@lid vs @s.whatsapp.net)
      try {
        const redis = await import('../config/redis.js');
        const client = redis.RedisConfig.getClient();
        const jidMappingKey = `jid:${businessId}:${phone}`;
        await client.setEx(jidMappingKey, 30 * 24 * 60 * 60, from); // 30 days TTL
        logger.debug('JID mapping cached', { phone, from, businessId });
      } catch (error) {
        logger.debug('Failed to cache JID mapping', { error, phone, from });
      }

      logger.debug('Processing WhatsApp message', {
        businessId,
        phone,
        from,
        conversationId,
        messageLength: messageText.length,
      });

      // Check if business WhatsApp is active.
      // Only send inactive fallback when we can confirm inactive state from business data.
      const businessStatus = await SupabaseService.getBusinessById(businessId);
      if (!businessStatus) {
        logger.debug('Skipping inactive fallback due to unknown business state', {
          businessId,
          phone,
          conversationId,
        });
        return;
      }

      const { language, isExplicit } = await this.resolveConversationLanguage(
        businessId,
        phone,
        messageText,
        businessStatus.language
      );
      resolvedLanguage = language;

      await runWithLanguage(language, () =>
        this._processMessageLocalized(message, businessStatus, phone, conversationId, isExplicit)
      );
    } catch (error) {
      // The try above wraps the whole turn, not just language resolution — the old
      // log label claimed otherwise and hid the real cause of every failure here.
      logger.error('Unhandled error processing WhatsApp message', {
        error,
        businessId: message.businessId,
        from: message.from,
      });

      // Never leave the customer in silence: they can't tell a crash from being
      // ignored. sendWhatsAppMessage swallows its own errors and dedupes identical
      // text within DUPLICATE_OUTBOUND_WINDOW_MS, so this can't throw or spam.
      await runWithLanguage(resolvedLanguage, () =>
        this.sendWhatsAppMessage(message.businessId, message.from, templates.genericError())
      );
    }
  }

  /**
   * Redis → customers.preferred_language → auto-detection → businesses.language.
   *
   * Auto-detection only runs when the customer never made an explicit choice,
   * and its result is cached but NOT written to the DB: it's our inference, not
   * their decision, so `preferred_language` stays NULL and the language menu is
   * still offered. `isExplicit` is returned alongside the language so the
   * caller can decide whether to still offer that menu this turn (see
   * `offerLanguageMenuOnFirstContact`).
   */
  private async resolveConversationLanguage(
    businessId: string,
    phone: string,
    messageText: string,
    businessLanguage?: string | null
  ): Promise<{ language: SupportedLanguage; isExplicit: boolean }> {
    const resolved = await resolveLanguage(businessId, phone, businessLanguage);

    if (resolved.isExplicit) {
      logger.debug('Language resolved', {
        phone,
        businessId,
        language: resolved.language,
        source: resolved.source,
      });
      return { language: resolved.language, isExplicit: true };
    }

    const detected = detectLanguage(messageText);
    if (detected && detected.confidence >= DETECTION_THRESHOLD) {
      logger.debug('Language auto-detected', {
        phone,
        businessId,
        language: detected.language,
        confidence: detected.confidence,
        previous: resolved.language,
      });
      await cacheDetectedLanguage(businessId, phone, detected.language);
      return { language: detected.language, isExplicit: false };
    }

    logger.debug('Language resolved', {
      phone,
      businessId,
      language: resolved.language,
      source: resolved.source,
    });
    return { language: resolved.language, isExplicit: false };
  }

  /**
   * Offers the language menu on the first message from a brand-new customer —
   * unless that message already carries enough signal to skip it (see below).
   *
   * Why this exists: `handleGreeting` already offers the menu, but only fires
   * when `isGreetingMessage` matches the WHOLE message. A first message that
   * combines greeting + intent ("hi, table for 4" — the literal example from
   * the original spec) is not a bare greeting, so it used to reach
   * `handlePrefilledReservationRequest` first, which tried to parse "hi" as
   * part of a name before the customer ever got to pick a language. Found via
   * manual testing with scripts/chat-simulator.ts.
   *
   * That failure mode is now closed at the source — `couldBeAName` rejects any
   * candidate containing a digit, in any language — so a confidently-detected
   * message with real content beyond a bare greeting skips the interruption
   * entirely: we send a short reminder that the language can be changed
   * instead, and let the rest of the message be processed normally in the
   * inferred language (already the active context via
   * `resolveConversationLanguage`/`runWithLanguage`). A bare greeting ("hola",
   * "hi"...) still shows the full menu, since there's nothing else in the
   * message to act on anyway, and an ambiguous message (low/no detection
   * confidence) also still shows it — same "when in doubt, ask" bias as
   * `detectLanguage` itself.
   *
   * Only acts on customers with NO name on file — an existing customer who
   * simply never made an explicit language choice (e.g. created before this
   * feature shipped) is intentionally left to the normal known-customer path,
   * matching the earlier product decision to never re-show the menu to
   * returning customers.
   *
   * Returns true when it sent the menu — caller must stop processing this turn.
   */
  private async offerLanguageMenuOnFirstContact(
    businessId: string,
    jid: string,
    phone: string,
    conversationId: string,
    messageText: string
  ): Promise<boolean> {
    const knownCustomer = await SupabaseService.getCustomerByPhone(phone, businessId);
    if (knownCustomer?.name) {
      return false;
    }

    const detected = detectLanguage(messageText);
    const hasContentBeyondGreeting = !this.isGreetingMessage(messageText);
    if (detected && detected.confidence >= DETECTION_THRESHOLD && hasContentBeyondGreeting) {
      logger.debug('Language menu skipped — inferred with confidence from first message content', {
        conversationId,
        businessId,
        language: detected.language,
        confidence: detected.confidence,
      });
      await this.sendWhatsAppMessage(businessId, jid, templates.languageChangeHint());
      return false;
    }

    const business = await SupabaseService.getBusinessById(businessId);
    await ReservationService.startReservation(conversationId, businessId, true);
    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.languageWelcomeMenu(business?.name || 'el local')
    );
    logger.debug('Language menu sent on first contact (non-greeting message)', {
      conversationId,
      businessId,
    });
    return true;
  }

  private async _processMessageLocalized(
    message: BaileysMessage,
    businessStatus: Business,
    phone: string,
    conversationId: string,
    languageChosenExplicitly: boolean
  ): Promise<void> {
    try {
      const { from, message: messageText, businessId } = message;

      const isActive =
        businessStatus.whatsapp_session_id !== null && businessStatus.whatsapp_session_id !== undefined;
      if (!isActive) {
        const shouldNotifyUnavailable = await this.shouldSendInactiveFallback(businessId, phone);
        if (shouldNotifyUnavailable) {
          await this.sendWhatsAppMessage(businessId, from, templates.inactiveFallback());
        } else {
          logger.debug('Inactive service fallback suppressed by throttle', {
            businessId,
            phone,
            conversationId,
          });
        }
        return;
      }

      // Get the waitlist agent
      const agent = agentRegistry.get('waitlist');
      if (!agent) {
        logger.error('Waitlist agent not found');
        return;
      }

      // Check if there's an active reservation draft
      let draft = await ReservationService.getDraft(conversationId);

      // --- Language change (any step, any moment) ---
      // Placed before every other check so it works mid-flow, and deliberately
      // NOT routed through handleGreeting: switching language must preserve the
      // draft (party size, date already given), unlike a greeting which resets it.
      const languageChangeHandled = await this.handleLanguageChangeRequest(
        messageText,
        businessId,
        from,
        phone,
        conversationId,
        draft
      );
      if (languageChangeHandled) {
        return;
      }

      // --- Early exit keyword check (any step) ---
      // The M3 cancel flow's own steps consume answers that contain words like
      // "cancelar" ("sí, cancelar"), so they are excluded here and resolved by
      // their step handlers below.
      if (
        draft &&
        draft.step !== 'completed' &&
        draft.step !== 'cancel_menu' &&
        draft.step !== 'cancel_confirm' &&
        this.isExitKeyword(messageText)
      ) {
        // Cancellation intent with a real reservation in DB → M3 menu
        // (reprogramar / cancelar definitivamente) instead of cancelling directly.
        // With several active reservations, ask which one first.
        if (this.isCancellationIntent(messageText)) {
          const routed = await this.routeToReservationAction(
            'cancel',
            businessId,
            from,
            conversationId,
            false // no active reservation → fall through to the draft cancellation below
          );
          if (routed) {
            return;
          }
        }

        if (draft.step === 'edit_menu' && draft.existingReservationId) {
          // Exit words without cancellation intent while in the edit menu
          // ("salir", "dejalo"...) — close the menu, keep the reservation.
          await ReservationService.deleteDraft(conversationId);
          await this.sendWhatsAppMessage(businessId, from, templates.reservationKept());
          logger.debug('Edit menu closed via exit keyword', { conversationId });
          return;
        }

        // In any other step the draft represents a flow not yet saved to DB.
        await ReservationService.deleteDraft(conversationId);
        await this.sendWhatsAppMessage(businessId, from, templates.processCancelled());
        logger.debug('Flow cancelled by exit keyword', { conversationId, step: draft.step });
        return;
      }

      // --- Multi-action message (e.g. "cancelá la del viernes y creá una para
      // mañana a las 21") — detect and run every requested action, not just the
      // first. Only when there's no active draft; gated by a cheap pre-filter so
      // ordinary single-intent messages never hit the planner LLM. ---
      if (!draft && this.isPotentialMultiActionMessage(messageText)) {
        const multiHandled = await this.handleMultiActionMessage(
          businessId,
          from,
          messageText,
          conversationId,
          businessStatus.name
        );
        if (multiHandled) {
          logger.debug('Multi-action message handled', { conversationId });
          return;
        }
      }

      // --- Cancellation intent without an active draft ---
      // e.g. "la quiero cancelar", "cancelar mi reserva", "quiero cancelar"
      if (!draft && this.isCancellationIntent(messageText)) {
        await this.routeToReservationAction('cancel', businessId, from, conversationId);
        return;
      }

      // --- Modification intent without an active draft (M2) ---
      // e.g. "MODIFICAR", "quiero cambiar mi reserva"
      if (!draft && this.isModificationIntent(messageText)) {
        await this.routeToReservationAction('edit', businessId, from, conversationId);
        return;
      }

      // --- Name/apellido change intent without an active draft ---
      // e.g. "cambiá mi nombre a Juan Pérez", "mi apellido es Gómez"
      if (!draft && this.isNameChangeIntent(messageText)) {
        const nameChangeHandled = await this.handleNameChangeIntent(
          businessId,
          from,
          messageText,
          conversationId
        );
        if (nameChangeHandled) {
          logger.debug('Name change intent handled', { conversationId });
          return;
        }
      }

      // --- Greeting: reset flow and check for active reservation ---
      if (this.isGreetingMessage(messageText)) {
        const greetingHandled = await this.handleGreeting(messageText, businessId, from, conversationId);
        if (greetingHandled) {
          logger.debug('Greeting handled with reservation menu', { conversationId });
          return;
        }
        // handleGreeting may have left an in-progress draft untouched (e.g. mid-edit,
        // or a slot pending confirmation) instead of cancelling it — re-sync our local
        // reference rather than blindly nulling it out, so that case still falls
        // through to its own step handler below instead of restarting the flow.
        draft = await ReservationService.getDraft(conversationId);
      }

      // --- Active reservations inquiry: answer directly even while another draft is active ---
      if (this.isActiveReservationsInquiryMessage(messageText)) {
        const activeReservationsHandled = await this.handleActiveReservationsInquiry(
          businessId,
          from,
          conversationId
        );
        if (activeReservationsHandled) {
          logger.debug('Active reservations inquiry handled', { conversationId });
          return;
        }
      }

      // Courtesy handling: if reservation is already active/confirmed and user sends
      // a short acknowledgment (thanks/ok/dale/etc.), reply naturally without restarting flow.
      if (!draft) {
        const courtesyHandled = await this.handlePostReservationCourtesy(
          businessId,
          from,
          messageText
        );
        if (courtesyHandled) {
          logger.debug('Post-reservation courtesy handled', { conversationId, businessId, from });
          return;
        }

        const reservationPolicyHandled = await this.enforceSingleActiveReservationPolicy(
          businessId,
          from,
          messageText,
          conversationId
        );
        if (reservationPolicyHandled) {
          return;
        }
      }

      const scopeEvaluation = evaluateReservationScope(messageText, {
        businessName: businessStatus.name,
        currentStep: draft?.step,
        awaitingNameCorrection: draft?.awaitingNameCorrection,
        scheduleChoiceEventTitles: draft?.scheduleChoiceOptions?.events.map((event) => event.title),
      });
      if (scopeEvaluation.decision === 'out_of_window' || scopeEvaluation.reason === 'prompt_injection') {
        // Deterministic, non-negotiable: the 7-day window rule and prompt-injection
        // attempts always get the canned message — never reach the LLM.
        await this.sendWhatsAppMessage(businessId, from, scopeEvaluation.message!);

        recordBlocked(scopeEvaluation.reason ?? scopeEvaluation.decision);
        logger.debug('Reservation scope guard blocked WhatsApp flow', {
          conversationId,
          decision: scopeEvaluation.decision,
          draftStep: draft?.step,
        });
        return;
      }

      if (scopeEvaluation.decision === 'off_topic') {
        // Bare digits/punctuation with no letters (e.g. a stray "1") carry no
        // real intent and have nothing for the LLM to ground a "natural"
        // answer in — sending them to the agent risks it hallucinating a
        // plausible-looking but fake flow (seen in prod: a lone "1" right
        // after a reservation was confirmed made it invent "¿De qué mes?").
        // Bounce with the canned message instead, same as prompt-injection/
        // out-of-window, without touching the draft/step.
        if (isPureNoiseMessage(messageText.trim()) && scopeEvaluation.message) {
          await this.sendWhatsAppMessage(businessId, from, scopeEvaluation.message);

          logger.debug('Off-topic noise message bounced without reaching the LLM', {
            conversationId,
            businessId,
            draftStep: draft?.step,
          });
          return;
        }

        // Generic off-topic ("¿para qué servís?", general questions) — let the
        // agent answer naturally instead of always sending the same canned
        // bounce message. processAction()/processDraftStep() would otherwise
        // discard this reply and re-send their own step message whenever a
        // draft is active, so this is sent directly and the draft/step are
        // left untouched — the customer can still answer the pending question
        // afterwards exactly as before.
        const naturalResponse = await agentService.generateResponse(
          messageText,
          agent,
          conversationId,
          {
            businessId,
            businessName: businessStatus.name,
            businessAddress: formatBusinessAddress(businessStatus.address, businessStatus.city),
            businessHours: formatWeeklyHoursForPrompt(businessStatus.weekly_hours as WeeklyHours | null | undefined),
            businessDescription: businessStatus.description ?? undefined,
            phone,
            hasActiveDraft: !!draft,
            currentStep: draft?.step,
          }
        );
        await this.sendWhatsAppMessage(businessId, from, this.sanitizeAgentResponse(naturalResponse.response, draft));

        logger.debug('Off-topic message answered by the agent instead of the canned bounce', {
          conversationId,
          businessId,
          draftStep: draft?.step,
        });
        return;
      }

      if (!draft) {
        if (!languageChosenExplicitly) {
          const languageMenuOffered = await this.offerLanguageMenuOnFirstContact(
            businessId,
            from,
            phone,
            conversationId,
            messageText
          );
          if (languageMenuOffered) {
            return;
          }
        }

        const prefilledReservationHandled = await this.handlePrefilledReservationRequest(
          messageText,
          conversationId,
          businessId,
          from
        );
        if (prefilledReservationHandled) {
          logger.debug('Prefilled reservation request handled deterministically', {
            conversationId,
            businessId,
          });
          return;
        }

        // FAST PATH: opt-in after a scope-guard block ("¿Querés hacer una reserva?").
        // Pure greetings (hola, buenas, etc.) are handled earlier by handleGreeting.
        // For explicit opt-ins like "Si", "Dale", "Ok" that are NOT greetings, start
        // the reservation flow directly without the "¡Hola!" intro, since the bot
        // already introduced itself in the scope-guard message.
        //
        // IMPORTANT: only assume this when the bot's own last message really was
        // that canned prompt. Since off-topic messages can now also be answered
        // by the agent in free text (see the off_topic branch above), a bare "Si"
        // might instead be confirming something the AGENT just asked (e.g. "¿te
        // cancelo la reserva de Matías Andrada del 22/07?") — blindly starting a
        // brand-new reservation there would silently discard that pending
        // confirmation. When the last bot turn wasn't the canned prompt, fall
        // through and let the agent interpret the reply with its own history.
        const isOptIn = isGreetingOrReservationOptInMessage(messageText);
        const isGreeting = this.isGreetingMessage(messageText);
        if (isOptIn && !isGreeting) {
          const history = await agentService.getConversationHistory(conversationId);
          const lastAssistantMessage = history
            .slice()
            .reverse()
            .find((msg) => msg.role === 'assistant');
          // No history at all (a brand-new conversation whose first message is
          // a bare "Si") keeps the original assumption — there's nothing else
          // it could be confirming. Only skip when there IS a last bot message
          // and it's something other than the canned scope-guard prompt.
          const lastMessageWasScopeGuardPrompt =
            !lastAssistantMessage || lastAssistantMessage.content.includes('¿Querés hacer una reserva?');

          if (lastMessageWasScopeGuardPrompt) {
            await this.startNewReservationFlow(conversationId, businessId, from, phone, templates.askName());
            logger.debug('Opt-in handled deterministically after scope block', { conversationId, isOptIn, isGreeting });
            return;
          }

          logger.debug('Opt-in received but last bot message was not the scope-guard prompt — deferring to the agent', {
            conversationId,
          });
        }
      }

      // FAST PATH: deterministic reservation steps should not wait for AI response
      if (
        draft &&
        (draft.step === 'name' ||
          draft.step === 'last_name' ||
          draft.step === 'party_size' ||
          draft.step === 'edit_menu' ||
          draft.step === 'schedule_choice' ||
          draft.step === 'date' ||
          draft.step === 'time' ||
          draft.step === 'confirm_summary' ||
          draft.step === 'summary_edit_menu' ||
          draft.step === 'cancel_menu' ||
          draft.step === 'cancel_confirm' ||
          draft.step === 'edit_customer_name')
      ) {
        logger.debug('Bypassing agent for deterministic draft step', {
          conversationId,
          businessId,
          step: draft.step,
        });

        const handled = await this.processAction(
          null,
          messageText,
          conversationId,
          businessId,
          from,
          draft
        );

        if (handled) {
          logger.debug('Agent response skipped (deterministic draft step handled)', {
            conversationId,
            step: draft.step,
          });
          logger.debug('WhatsApp message processed successfully', {
            businessId,
            phone,
            action: 'DRAFT_STEP_DIRECT',
          });
          return;
        }

        logger.warn('Deterministic draft step was not fully handled, falling back to agent', {
          conversationId,
          step: draft.step,
        });
      }

      // Get business details for context
      const business = await SupabaseService.getBusinessById(businessId);
      const businessName = business?.name || 'el local';

      // Build context
      const context: any = {
        businessId,
        businessName,
        businessAddress: formatBusinessAddress(business?.address, business?.city),
        businessHours: formatWeeklyHoursForPrompt(business?.weekly_hours as WeeklyHours | null | undefined),
        businessDescription: business?.description ?? undefined,
        phone,
        hasActiveDraft: !!draft,
      };

      if (draft) {
        context.currentStep = draft.step;
        context.draftData = {
          customerName: draft.customerName,
          partySize: draft.partySize,
          scheduledDate: draft.scheduledDate,
          scheduledTime: draft.scheduledTime,
        };
      }
      // CRITICAL FIX: Auto-create draft BEFORE generating agent response
      // Check if the PREVIOUS bot message asked for name, not the current one
      if (!draft) {
        try {
          // Get conversation history to check last assistant message
          const history = await agentService.getConversationHistory(conversationId);
          const lastAssistantMessage = history
            .slice()
            .reverse()
            .find((msg: any) => msg.role === 'assistant');

          if (lastAssistantMessage) {
            const lastBotMessage = lastAssistantMessage.content.toLowerCase();
            const isAskingForName =
              lastBotMessage.includes('¿cuál es tu nombre') ||
              lastBotMessage.includes('cuál es tu nombre') ||
              lastBotMessage.includes('tu nombre') ||
              lastBotMessage.includes('cómo te llamas');

            const looksLikeName =
              !/^\d+$/.test(messageText.trim()) &&
              messageText.trim().length >= 2 &&
              !this.isPostReservationCourtesyMessage(messageText) &&
              !this.isReservationRequest(messageText) &&
              this.couldBeAName(messageText);

            if (isAskingForName && looksLikeName) {
              const extractedName = this.extractNameFromMessage(messageText);
              if (isObviouslyGibberish(extractedName)) {
                logger.debug('Invalid name rejected in auto-creation path — re-asking', { conversationId, candidate: extractedName });
                await this.sendWhatsAppMessage(
                  businessId,
                  from,
                  templates.invalidName()
                );
                return;
              }

              logger.debug('Auto-creating reservation draft', { conversationId, businessId, userName: messageText });

              // Create draft and set customer name (apellido is optional, never asked separately)
              await ReservationService.startReservation(conversationId, businessId);
              const { firstName: autoFirst, lastName: autoLast } = this.splitFullName(extractedName);

              if (autoLast) {
                await ReservationService.setCustomerNameParts(conversationId, autoFirst, autoLast);
              } else {
                await ReservationService.setCustomerName(conversationId, autoFirst);
              }
              draft = await ReservationService.getDraft(conversationId);
              await this.sendWhatsAppMessage(businessId, from, templates.askPartySize(autoFirst));

              logger.debug('Draft created and name saved', {
                conversationId,
                step: draft?.step,
                name: draft?.customerName,
              });

              // Skip agent response since we already sent our custom message
              return;
            }
          }
        } catch (error) {
          logger.error('Error in auto-draft creation', { error });
        }
      }

      // Log context before calling agent
      logger.debug('Agent context snapshot', {
        conversationId,
        businessId,
        currentStep: context.currentStep,
        hasDraft: !!draft,
        partySize: context.draftData?.partySize,
      });

      // Generate response with agent
      const agentResponse = await agentService.generateResponse(
        messageText,
        agent,
        conversationId,
        context
      );

      // Process the action based on message and draft state
      // Returns true if a custom message was already sent (skip agent response)
      const skipAgentResponse = await this.processAction(
        agentResponse.action,
        messageText,
        conversationId,
        businessId,
        from,
        draft
      );

      // Send response back to WhatsApp (only if not skipped)
      if (!skipAgentResponse) {
        const sanitizedAgentResponse = this.sanitizeAgentResponse(agentResponse.response, draft);
        const isTestEnv = process.env.NODE_ENV === 'test';
        const testRecipient = isTestEnv ? this.baileysService.getSelfJid(businessId) : null;
        const recipients = new Set<string>([from]);

        if (testRecipient) {
          recipients.add(testRecipient);
        }

        for (const recipient of recipients) {
          await this.sendWhatsAppMessage(businessId, recipient, sanitizedAgentResponse);
        }
      } else {
        logger.debug('Agent response skipped (custom message sent)', { conversationId });
      }

      logger.debug('WhatsApp message processed successfully', {
        businessId,
        phone,
        action: agentResponse.action,
      });
    } catch (error) {
      logger.error('Error processing WhatsApp message', { error, message });

      // Already inside the runWithLanguage context, so this comes out localized.
      await this.sendWhatsAppMessage(message.businessId, message.from, templates.genericError());
    }
  }

  /**
   * Process action based on agent inference and conversation state
   * Returns true if a custom message was sent (skip agent response)
   */
  private async processAction(
    action: string | null | undefined,
    messageText: string,
    conversationId: string,
    businessId: string,
    jid: string,
    draft: ReservationDraft | null
  ): Promise<boolean> {
    try {
      logger.debug('Processing action', {
        conversationId,
        action,
        hasDraft: !!draft,
        draftStep: draft?.step,
        messageText: messageText.substring(0, 50),
      });

      // If draft exists, process based on current step (reservation flow in progress)
      if (draft && draft.step !== 'completed') {
        logger.debug('Processing draft step', {
          conversationId,
          step: draft.step,
          customerName: draft.customerName,
          partySize: draft.partySize,
        });
        const customMessageSent = await this.processDraftStep(draft, messageText, conversationId, businessId, jid);
        return customMessageSent;
      }

      // Process explicit actions
      switch (action) {
        case 'CREATE_RESERVATION':
          return await this.handleCreateReservation(messageText, conversationId, businessId, jid);

        case 'CHECK_STATUS':
          await this.handleCheckStatus(businessId, jid, conversationId);
          break;

        case 'CANCEL':
          await this.handleCancel(businessId, jid, conversationId);
          break;

        case 'INFO_REQUEST':
          await this.handleInfoRequest(businessId, jid, conversationId);
          break;

        default:
          logger.debug('No specific action to process', { action, conversationId });
      }
    } catch (error) {
      logger.error('Error processing action', { error, action, conversationId });
    }

    return false; // No custom message sent, send agent response
  }

  /**
   * Process reservation draft steps
   * Returns true if a custom message was sent (skip agent response)
   */
  private async processDraftStep(
    draft: ReservationDraft,
    messageText: string,
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<boolean> {
    try {
      recordDraftStep(draft.step);
      logger.debug('Processing draft step', {
        conversationId,
        step: draft.step,
        messageText: messageText.substring(0, 50),
      });

      if (draft.pendingWeekdayDisambiguation) {
        return await this.resolvePendingWeekdayDisambiguation(
          draft,
          messageText,
          conversationId,
          businessId,
          jid
        );
      }

      if (draft.pendingWeekdayDayMismatch) {
        return await this.resolvePendingWeekdayDayMismatch(
          draft,
          messageText,
          conversationId,
          businessId,
          jid
        );
      }

      if (draft.pendingTodayTimeChoice) {
        return await this.resolvePendingTodayTimeChoice(
          draft,
          messageText,
          conversationId,
          businessId,
          jid
        );
      }

      switch (draft.step) {
        case 'name': {
          // Guard: user responded with an affirmative ("Si", "Dale", "Ok") instead of their name.
          // This happens when a scope-guard message is sent (e.g. specific-time rejection) that ends
          // with "¿Querés hacer una reserva?" and the user confirms — the draft is still at step 'name'.
          if (isGreetingOrReservationOptInMessage(messageText)) {
            logger.debug('Opt-in response received at name step — re-asking for name', {
              conversationId,
              messageText,
            });
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.askNameAgain()
            );
            return true;
          }

          let extractedName = this.extractNameCandidate(messageText);
          let partySize = this.extractPartySize(messageText);
          let nameLlmSlots: ReservationSlots | null = null;

          // Regex couldn't find a name at all — give the model one look before
          // bouncing the customer with "no entendí" (see reservation-nlu.service.ts).
          if (!extractedName) {
            nameLlmSlots = await this.getLlmSlotsFallback(draft, messageText, businessId, conversationId);
            if (nameLlmSlots?.customerName) {
              extractedName = nameLlmSlots.customerName;
              partySize = partySize ?? this.extractPartySize(nameLlmSlots.partySizeText ?? '');
            }
          }

          if (!extractedName) {
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.askNameAgain()
            );
            return true;
          }

          const nameFlaggedByModel = nameLlmSlots?.customerName === extractedName && nameLlmSlots?.nameLooksInvalid;
          if (isObviouslyGibberish(extractedName) || nameFlaggedByModel) {
            logger.debug('Invalid name rejected — re-asking', { conversationId, candidate: extractedName });
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.invalidName()
            );
            return true;
          }

          const { firstName, lastName } = this.splitFullName(extractedName);
          logger.debug('Setting customer name', { conversationId, raw: messageText, firstName, lastName });

          if (lastName) {
            // Full "Nombre Apellido" given in one message — store both.
            await ReservationService.setCustomerNameParts(conversationId, firstName, lastName);
          } else {
            // Only a first name — the apellido is optional, don't ask for it separately.
            await ReservationService.setCustomerName(conversationId, firstName);
          }

          await this.continueAfterNameCollected(
            conversationId,
            businessId,
            jid,
            messageText,
            firstName,
            partySize
          );
          return true;
        }

        case 'last_name': {
          // A greeting/opt-in isn't an apellido — re-ask without burning attempts.
          if (isGreetingOrReservationOptInMessage(messageText)) {
            await this.sendWhatsAppMessage(businessId, jid, templates.askLastNameAgain());
            return true;
          }

          const lastNameCandidate = this.extractNameCandidate(messageText);
          if (!lastNameCandidate) {
            draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
            await ReservationService.saveDraft(draft);
            if (draft.invalidAttempts >= 2) {
              await ReservationService.deleteDraft(conversationId);
              await this.sendWhatsAppMessage(businessId, jid, templates.tooManyInvalidAttempts());
            } else {
              await this.sendWhatsAppMessage(businessId, jid, templates.askLastNameAgain());
            }
            return true;
          }

          // A single token is the apellido itself; a "Nombre Apellido" reply
          // keeps only the apellido part (the first name is already stored).
          const { firstName: lnFirst, lastName: lnRest } = this.splitFullName(lastNameCandidate);
          const apellido = lnRest || lnFirst;
          await ReservationService.setCustomerLastName(conversationId, apellido);
          logger.debug('Customer last name set', { conversationId, apellido });

          const displayName = draft.customerName || lnFirst;
          await this.continueAfterNameCollected(
            conversationId,
            businessId,
            jid,
            messageText,
            displayName,
            this.extractPartySize(messageText)
          );
          return true;
        }

        case 'party_size': {
          // We just asked "¿Cuál es tu nombre correcto?" — this reply IS the
          // name, full stop. Don't require an explicit correction phrase like
          // "me llamo X" this time; the customer has no reason to know that's
          // expected, and rejecting a bare name here used to trap them in an
          // unrecoverable off-topic loop (the scope guard never let a bare
          // name through at this step either — see awaitingNameCorrection).
          if (draft.awaitingNameCorrection) {
            const correctedName = this.extractNameCandidate(messageText);

            if (correctedName) {
              draft.awaitingNameCorrection = false;
              await ReservationService.saveDraft(draft);
              await ReservationService.setNameOnly(conversationId, correctedName);
              logger.debug('Name corrected at party_size step (follow-up)', {
                conversationId,
                correctedName,
              });
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.nameChanged(correctedName)
              );
              return true;
            }

            draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
            if (draft.invalidAttempts >= 2) {
              await ReservationService.deleteDraft(conversationId);
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.tooManyInvalidAttempts()
              );
            } else {
              await ReservationService.saveDraft(draft);
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.invalidNameRetry()
              );
            }
            return true;
          }

          // Guard: a bare greeting/opt-in ("Hola", "Si", "Dale") means the customer
          // is checking in or confirming they want to continue, not answering with
          // a party size. Re-ask without burning an invalid attempt — see the
          // identical guard on the 'name' step above for why this matters.
          if (isGreetingOrReservationOptInMessage(messageText)) {
            logger.debug('Opt-in/greeting response received at party_size step — re-asking', {
              conversationId,
              messageText,
            });
            await this.sendWhatsAppMessage(businessId, jid, templates.askPartySizeShort());
            return true;
          }

          const partySize = this.extractPartySize(messageText);

          // Check if user is correcting their name instead of providing a party size
          if (this.isNameCorrectionMessage(messageText)) {
            const correctedName = this.extractNameCandidate(messageText);

            if (correctedName) {
              await ReservationService.setNameOnly(conversationId, correctedName);
              logger.debug('Name corrected at party_size step', { conversationId, correctedName });

              if (partySize && partySize > 0 && partySize <= 50) {
                await ReservationService.setPartySize(conversationId, partySize);
                logger.debug('Embedded party size set alongside name correction', {
                  conversationId,
                  partySize,
                });
                await this.resolveEmbeddedScheduleOrPromptChoice(conversationId, businessId, jid, messageText);
                return true;
              }

              await this.sendWhatsAppMessage(businessId, jid, templates.nameChanged(correctedName));
              return true;
            }

            draft.awaitingNameCorrection = true;
            await ReservationService.saveDraft(draft);
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.askCorrectName()
            );
            return true;
          }

          // User provided party size
          logger.debug('Extracting party size', { conversationId, messageText });
          logger.debug('Party size extracted', { conversationId, partySize });

          // Regex found nothing usable — give the model one look (e.g. "para toda
          // la familia, unos ocho" won't match the regex's number patterns) before
          // burning an invalid attempt.
          let resolvedPartySize = partySize;
          if (!resolvedPartySize) {
            const llmSlots = await this.getLlmSlotsFallback(draft, messageText, businessId, conversationId);
            if (llmSlots?.partySizeText) {
              resolvedPartySize = this.extractPartySize(llmSlots.partySizeText);
            }
          }

          if (resolvedPartySize && resolvedPartySize > 0 && resolvedPartySize <= 50) {
            // ----- EDIT MODE: just update the existing reservation -----
            if (draft.editMode && draft.existingReservationId) {
              const ok = await SupabaseService.updateReservationPartySize(
                draft.existingReservationId,
                resolvedPartySize
              );
              await ReservationService.deleteDraft(conversationId);
              const msg = ok
                ? templates.partySizeUpdated(resolvedPartySize)
                : templates.partySizeUpdateFailed();
              await this.sendWhatsAppMessage(businessId, jid, msg);
              return true;
            }

            // ----- NORMAL MODE -----
            await ReservationService.setPartySize(conversationId, resolvedPartySize);
            logger.debug('Party size set', { conversationId, partySize: resolvedPartySize });

            // Editing from the pre-confirmation summary: go back to it
            if (draft.returnToSummary) {
              await this.showReservationSummary(conversationId, businessId, jid);
              return true;
            }

            // Out-of-order slot-filling (#7): if the customer also named a day
            // (and maybe a time) in this same message — e.g. "4 el viernes a las
            // 21" — resolve it now instead of asking "¿hoy u otro día?" again.
            await this.resolveEmbeddedScheduleOrPromptChoice(conversationId, businessId, jid, messageText);
            return true;
          } else {
            // Invalid party size — track attempts and cancel after 2
            logger.warn('Invalid party size provided', { conversationId, messageText });

            draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
            await ReservationService.saveDraft(draft);

            if (draft.invalidAttempts >= 2) {
              await ReservationService.deleteDraft(conversationId);
              await this.sendWhatsAppMessage(businessId, jid, templates.tooManyInvalidAttempts());
            } else {
              await this.sendWhatsAppMessage(businessId, jid, templates.invalidPartySize());
            }
            return true;
          }
          break;
        }

        case 'schedule_choice': {
          // Guard: a bare greeting/opt-in doesn't answer "1 or 2" — re-show the
          // menu instead of burning an invalid attempt (see 'name' step guard).
          if (isGreetingOrReservationOptInMessage(messageText)) {
            logger.debug('Opt-in/greeting response received at schedule_choice step — re-asking', {
              conversationId,
              messageText,
            });
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              await this.buildScheduleChoiceMessage(conversationId, businessId, draft)
            );
            return true;
          }

          // Same "otros días" question as at the `time`/`date` steps — answer
          // with real hours instead of bouncing to the LLM fallback.
          if (isAskingOtherDaysScheduleMessage(normalizeReservationScopeText(messageText))) {
            const scheduleFollowUp = await this.buildScheduleChoiceMessage(conversationId, businessId, draft);
            if (await this.maybeAnswerOtherDaysScheduleQuestion(messageText, businessId, jid, scheduleFollowUp)) {
              return true;
            }
          }

          const trimmedChoice = messageText.trim();
          const normalizedChoice = normalizeReservationScopeText(messageText);

          // Los eventos se resuelven primero: la numeración del menú se corre
          // según haya o no opción "Hoy", así que un "2" puede ser "otra fecha"
          // o el primer evento. El snapshot del borrador lo desambigua.
          const scheduleOptions = draft.scheduleChoiceOptions;
          if (scheduleOptions && scheduleOptions.events.length > 0) {
            const activeEvents = await SupabaseService.getActiveEvents(businessId);
            const chosenEvent = this.matchScheduleChoiceEvent(draft, messageText, activeEvents);

            if (chosenEvent) {
              await this.applyEventChoice(draft, chosenEvent, conversationId, businessId, jid);
              return true;
            }

            // El número caía en un evento que ya no está activo: el comercio lo
            // pausó o lo borró entre que se mostró el menú y llegó la respuesta.
            const staleIndex = /^\d+$/.test(trimmedChoice)
              ? Number(trimmedChoice) - (scheduleOptions.includeToday ? 3 : 2)
              : -1;
            const staleEvent = staleIndex >= 0 ? scheduleOptions.events[staleIndex] : undefined;

            if (staleEvent) {
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.eventNoLongerAvailable(staleEvent.title)
              );
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                await this.buildScheduleChoiceMessage(conversationId, businessId, draft)
              );
              return true;
            }
          }

          // Cuando el menú se mostró sin la opción "Hoy" (porque el día ya no
          // tenía disponibilidad), el "1" significa "otra fecha", no "ahora".
          const todayWasOffered = scheduleOptions?.includeToday ?? true;
          const wantsInstant =
            todayWasOffered && (trimmedChoice === '1' || isInstantChoiceMessage(normalizedChoice));
          const wantsToPickDay = todayWasOffered ? trimmedChoice === '2' : trimmedChoice === '1';

          if (wantsInstant) {
            if (draft.editMode && draft.existingReservationId) {
              const ok = await SupabaseService.updateReservationSchedule(draft.existingReservationId, null);
              await ReservationService.deleteDraft(conversationId);
              const msg = ok
                ? templates.scheduleRevertedToInstant()
                : templates.reservationUpdateFailed();
              await this.sendWhatsAppMessage(businessId, jid, msg);
              return true;
            }

            // Check if the business is currently open before creating an instant reservation
            const businessNow = await SupabaseService.getBusinessById(businessId);
            const weeklyHoursNow = businessNow?.weekly_hours as WeeklyHours | null | undefined;

            if (weeklyHoursNow && Object.keys(weeklyHoursNow).length > 0) {
              const nowBA = nowInBuenosAires();
              const closingMarginNow = businessNow?.reservation_closing_margin_minutes ?? 15;
              const nowCheck = checkBusinessHours(nowBA, nowBA.getUTCHours(), nowBA.getUTCMinutes(), weeklyHoursNow, closingMarginNow);

              if (!nowCheck.allowed) {
                const margin = businessNow?.reservation_opening_margin_minutes ?? 15;
                const nextSlot = findNextOpenSlot(nowBA, weeklyHoursNow, margin, closingMarginNow);

                if (!nextSlot) {
                  await this.sendWhatsAppMessage(
                    businessId,
                    jid,
                    templates.closedNoAvailability()
                  );
                  await ReservationService.deleteDraft(conversationId);
                  return true;
                }

                const slotTime = `${String(nextSlot.hour).padStart(2, '0')}:${String(nextSlot.minute).padStart(2, '0')}`;
                const slotAt = combineToUtcISO(nextSlot.baDate, nextSlot.hour, nextSlot.minute);
                const slotDate = formatBaDateKey(nextSlot.baDate);

                const blockedDatesNow = await SupabaseService.getBlockedDates(businessId);
                const slotIsBlocked =
                  isDateBlocked(slotDate, blockedDatesNow) ||
                  isFutureReservationBlockedToday(
                    slotDate,
                    nextSlot.hour,
                    nextSlot.minute,
                    nowBA,
                    businessNow?.future_reservations_blocked_for_date,
                    weeklyHoursNow,
                    closingMarginNow
                  );

                if (slotIsBlocked) {
                  await this.sendWhatsAppMessage(
                    businessId,
                    jid,
                    templates.closedNoAvailability()
                  );
                  await ReservationService.deleteDraft(conversationId);
                  return true;
                }

                await ReservationService.moveToConfirmSlot(conversationId, slotDate, slotTime, slotAt, 'schedule_choice');
                await this.sendWhatsAppMessage(
                  businessId,
                  jid,
                  templates.closedSuggestNextSlot(nextSlot.label)
                );
                return true;
              }

              // Business is open right now — ask for the specific hour instead
              // of jumping straight to an instant/current-turn reservation.
              const todayDateKey = formatBaDateKey(nowBA);
              const closeSlot = findCurrentShiftClose(
                nowBA,
                nowBA.getUTCHours(),
                nowBA.getUTCMinutes(),
                weeklyHoursNow,
                closingMarginNow
              );
              const closeLabel = closeSlot
                ? `${String(closeSlot.hour).padStart(2, '0')}:${String(closeSlot.minute).padStart(2, '0')}`
                : null;

              draft.pendingTodayTimeChoice = { dateKey: todayDateKey, closeLabel };
              await ReservationService.saveDraft(draft);
              await this.sendWhatsAppMessage(businessId, jid, templates.askTodayTimeOpen(closeLabel));
              return true;
            }

            // No weekly_hours configured — no way to know open/closing times, keep the instant behavior.
            await ReservationService.setInstantSchedule(conversationId);
            await this.showReservationSummary(conversationId, businessId, jid);
            return true;
          }

          // The customer may have already named a day in this same message (e.g. "el viernes")
          const nowBA = nowInBuenosAires();
          let parsedDay = wantsToPickDay ? null : parseRelativeDay(messageText, nowBA);

          // Regex found no day in a message that wasn't "1"/"2" either — give
          // the model one look before falling through to the invalid-choice
          // re-ask below (e.g. "prefiero el finde que viene").
          if (!parsedDay && !wantsToPickDay) {
            const scheduleLlmSlots = await this.getLlmSlotsFallback(draft, messageText, businessId, conversationId);
            if (scheduleLlmSlots?.dateText) {
              const llmParsedDay = parseRelativeDay(scheduleLlmSlots.dateText, nowBA);
              if (llmParsedDay && isWithinNextWeek(llmParsedDay.baDate, nowBA)) {
                parsedDay = llmParsedDay;
              }
            }
          }

          if (parsedDay) {
            if (!isWithinNextWeek(parsedDay.baDate, nowBA)) {
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.outOfWindowAskDay()
              );
              return true;
            }

            // Reject dates the business has explicitly blocked (business_blocked_dates)
            // right away — before asking for the time — so the customer isn't asked
            // "¿a qué hora?" for a day the local isn't taking reservations at all.
            const dateKeyForScheduleBlock = formatBaDateKey(parsedDay.baDate);
            const blockedDatesForSchedule = await SupabaseService.getBlockedDates(businessId);
            if (isDateBlocked(dateKeyForScheduleBlock, blockedDatesForSchedule)) {
              const blockedReason = await this.resolveBlockedDateMessage(
                businessId,
                dateKeyForScheduleBlock,
                blockedDatesForSchedule
              );
              if (await this.proposeSoonestSlot(conversationId, businessId, jid, 'date', blockedReason ?? null)) {
                return true;
              }
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.dateBlocked(parsedDay.label, blockedReason)
              );
              return true;
            }

            // Reject closed weekdays right away too (before asking for the time),
            // offering the soonest bookable day so the customer can accept with "sí".
            const businessForScheduleDay = await SupabaseService.getBusinessById(businessId);
            const weeklyHoursForScheduleDay = businessForScheduleDay?.weekly_hours as
              | WeeklyHours
              | null
              | undefined;
            if (weeklyHoursForScheduleDay && Object.keys(weeklyHoursForScheduleDay).length > 0) {
              const scheduleDayCheck = isDayOpen(parsedDay.baDate, weeklyHoursForScheduleDay);
              if (!scheduleDayCheck.open) {
                if (
                  await this.proposeSoonestSlot(conversationId, businessId, jid, 'date', scheduleDayCheck.reason ?? null)
                ) {
                  return true;
                }
                await this.sendWhatsAppMessage(
                  businessId,
                  jid,
                  `❌ ${scheduleDayCheck.reason}\n\n` +
                    (await this.buildAskDayMessage(businessId, weeklyHoursForScheduleDay))
                );
                return true;
              }
            }

            // The customer may have already given the time in the same message too
            // (e.g. "el viernes a las 21") — skip the redundant "¿A qué hora?" ask.
            const parsedTimeSameMsg = parseTimeOfDay(messageText);

            if (
              await this.raiseWeekdayDayNumberMismatchIfNeeded(
                draft,
                messageText,
                parsedDay,
                businessId,
                jid,
                parsedTimeSameMsg ?? undefined
              )
            ) {
              return true;
            }

            if (
              await this.raiseWeekdayAmbiguityIfNeeded(
                draft,
                parsedDay,
                conversationId,
                businessId,
                jid,
                parsedTimeSameMsg ?? undefined,
                weeklyHoursForScheduleDay,
                businessForScheduleDay?.reservation_closing_margin_minutes ?? 15
              )
            ) {
              return true;
            }

            await ReservationService.setScheduledDate(conversationId, parsedDay);

            if (parsedTimeSameMsg) {
              await this.finalizeScheduledTime(
                draft,
                conversationId,
                businessId,
                jid,
                formatBaDateKey(parsedDay.baDate),
                parsedTimeSameMsg.hour,
                parsedTimeSameMsg.minute
              );
              return true;
            }

            await this.sendWhatsAppMessage(
              businessId,
              jid,
              await this.buildAskTimeMessage(businessId, dateKeyForScheduleBlock, parsedDay.label)
            );
            return true;
          }

          if (wantsToPickDay) {
            await ReservationService.moveToDateStep(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, await this.buildAskDayMessage(businessId));
            return true;
          }

          draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
          await ReservationService.saveDraft(draft);

          if (draft.invalidAttempts >= 2) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.tooManyInvalidAttempts()
            );
          } else {
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.scheduleChoiceInvalid(this.scheduleChoiceOptionCount(draft))
            );
          }
          return true;
        }

        case 'date': {
          // Guard: a bare greeting/opt-in doesn't name a day — re-ask instead of
          // burning an invalid attempt (see 'name' step guard).
          if (isGreetingOrReservationOptInMessage(messageText)) {
            logger.debug('Opt-in/greeting response received at date step — re-asking', {
              conversationId,
              messageText,
            });
            await this.sendWhatsAppMessage(businessId, jid, templates.invalidDate());
            return true;
          }

          // Same "otros días" question as at the `time` step (see there) —
          // answer with real hours instead of bouncing to the LLM fallback.
          if (isAskingOtherDaysScheduleMessage(normalizeReservationScopeText(messageText))) {
            const followUp = await this.buildAskDayMessage(businessId);
            if (await this.maybeAnswerOtherDaysScheduleQuestion(messageText, businessId, jid, followUp)) {
              return true;
            }
          }

          const nowBA = nowInBuenosAires();
          let parsedDay = parseRelativeDay(messageText, nowBA);

          if (!parsedDay || !isWithinNextWeek(parsedDay.baDate, nowBA)) {
            // Regex found no valid day — give the model one look before giving
            // up (e.g. "el finde que viene no, mejor el jueves de esta semana").
            const dateLlmSlots = await this.getLlmSlotsFallback(draft, messageText, businessId, conversationId);
            if (dateLlmSlots?.dateText) {
              const llmParsedDay = parseRelativeDay(dateLlmSlots.dateText, nowBA);
              if (llmParsedDay && isWithinNextWeek(llmParsedDay.baDate, nowBA)) {
                parsedDay = llmParsedDay;
              }
            }
          }

          // Fetch business once — needed for both invalid-date fallback and hours validation below.
          const businessForDate = await SupabaseService.getBusinessById(businessId);
          const weeklyHoursForDate = businessForDate?.weekly_hours as WeeklyHours | null | undefined;

          if (!parsedDay || !isWithinNextWeek(parsedDay.baDate, nowBA)) {
            draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
            await ReservationService.saveDraft(draft);

            if (draft.invalidAttempts >= 2) {
              await ReservationService.deleteDraft(conversationId);
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.tooManyInvalidAttempts()
              );
            } else {
              // Proactively suggest the soonest available slot so the customer can
              // confirm with "sí". They already opted for "otra fecha", so never
              // propose today (spec: "no del día actual si se seleccionó otro día").
              if (await this.proposeSoonestSlot(conversationId, businessId, jid, 'date', null)) {
                return true;
              }

              // No suitable default slot — re-ask showing open days.
              if (parsedDay) {
                await this.sendWhatsAppMessage(
                  businessId,
                  jid,
                  templates.outOfWindowPrefix() +
                  (await this.buildAskDayMessage(businessId, weeklyHoursForDate))
                );
              } else {
                await this.sendWhatsAppMessage(businessId, jid, await this.buildAskDayMessage(businessId, weeklyHoursForDate));
              }
            }
            return true;
          }
          if (weeklyHoursForDate && Object.keys(weeklyHoursForDate).length > 0) {
            const dayCheck = isDayOpen(parsedDay.baDate, weeklyHoursForDate);
            if (!dayCheck.open) {
              draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
              await ReservationService.saveDraft(draft);
              if (draft.invalidAttempts >= 2) {
                await ReservationService.deleteDraft(conversationId);
                await this.sendWhatsAppMessage(
                  businessId,
                  jid,
                  templates.tooManyInvalidAttempts()
                );
                return true;
              }

              // Offer the soonest available slot (never today — they picked a
              // specific day) so the customer can confirm with "sí".
              if (await this.proposeSoonestSlot(conversationId, businessId, jid, 'date', dayCheck.reason ?? null)) {
                return true;
              }

              await this.sendWhatsAppMessage(
                businessId,
                jid,
                `❌ ${dayCheck.reason}\n\n` + await this.buildAskDayMessage(businessId, weeklyHoursForDate)
              );
              return true;
            }
          }

          // Reject dates the business has explicitly blocked (business_blocked_dates)
          // right away — before asking for the time — so the customer isn't asked
          // "¿a qué hora?" for a day the local isn't taking reservations at all.
          const dateKeyForDateStepBlock = formatBaDateKey(parsedDay.baDate);
          const blockedDatesForDateStep = await SupabaseService.getBlockedDates(businessId);
          if (isDateBlocked(dateKeyForDateStepBlock, blockedDatesForDateStep)) {
            const blockedReason = await this.resolveBlockedDateMessage(
              businessId,
              dateKeyForDateStepBlock,
              blockedDatesForDateStep
            );
            // Offer the soonest bookable day (never today) so the customer can
            // accept with "sí"; fall back to the plain block notice otherwise.
            if (await this.proposeSoonestSlot(conversationId, businessId, jid, 'date', blockedReason ?? null)) {
              return true;
            }
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.dateBlocked(parsedDay.label, blockedReason)
            );
            return true;
          }

          // The customer may have already given the time in the same message too
          // (e.g. "el miércoles a las 19") — skip the redundant "¿A qué hora?" ask.
          const parsedTimeSameMsg = parseTimeOfDay(messageText);

          if (
            await this.raiseWeekdayDayNumberMismatchIfNeeded(
              draft,
              messageText,
              parsedDay,
              businessId,
              jid,
              parsedTimeSameMsg ?? undefined
            )
          ) {
            return true;
          }

          if (
            await this.raiseWeekdayAmbiguityIfNeeded(
              draft,
              parsedDay,
              conversationId,
              businessId,
              jid,
              parsedTimeSameMsg ?? undefined,
              weeklyHoursForDate,
              businessForDate?.reservation_closing_margin_minutes ?? 15
            )
          ) {
            return true;
          }

          await ReservationService.setScheduledDate(conversationId, parsedDay);

          // Date-only edits (M2 "Fecha" on an existing reservation, or the
          // pre-confirmation summary menu) keep the already-known time
          // instead of re-asking it.
          const keepTimeParts =
            !parsedTimeSameMsg &&
            draft.scheduledTime &&
            (draft.editingField === 'date' || draft.returnToSummary)
              ? draft.scheduledTime.split(':').map(Number)
              : null;

          if (parsedTimeSameMsg || keepTimeParts) {
            await this.finalizeScheduledTime(
              draft,
              conversationId,
              businessId,
              jid,
              formatBaDateKey(parsedDay.baDate),
              parsedTimeSameMsg ? parsedTimeSameMsg.hour : keepTimeParts![0],
              parsedTimeSameMsg ? parsedTimeSameMsg.minute : keepTimeParts![1]
            );
            return true;
          }

          await this.sendWhatsAppMessage(
            businessId,
            jid,
            await this.buildAskTimeMessage(businessId, dateKeyForDateStepBlock, parsedDay.label, weeklyHoursForDate)
          );
          return true;
        }

        case 'time': {
          // Guard: a bare greeting/opt-in doesn't answer with an hour — re-ask
          // instead of burning an invalid attempt (see 'name' step guard). This
          // is the exact trap a customer hit after replying "09/07" to "¿A qué
          // hora...?": the reply got scope-blocked, the draft stayed on 'time',
          // and every later "Hola"/"Si" kept hitting the same off-topic wall.
          if (isGreetingOrReservationOptInMessage(messageText)) {
            logger.debug('Opt-in/greeting response received at time step — re-asking', {
              conversationId,
              messageText,
            });
            await this.sendWhatsAppMessage(businessId, jid, templates.invalidTime());
            return true;
          }

          // The customer may be asking about other days' schedules instead of
          // answering the hour for the currently chosen day (e.g. "¿y los
          // horarios de los otros días?"). Answer with the real hours instead
          // of falling through to the LLM fallback, which has no access to
          // weekly_hours and ends up falsely claiming it doesn't know.
          if (draft.scheduledDate && isAskingOtherDaysScheduleMessage(normalizeReservationScopeText(messageText))) {
            const nowBAForOtherDays = nowInBuenosAires();
            const dayLabelForOtherDays = describeBaDateKey(draft.scheduledDate, nowBAForOtherDays);
            const followUp = await this.buildAskTimeMessage(businessId, draft.scheduledDate, dayLabelForOtherDays);
            if (await this.maybeAnswerOtherDaysScheduleQuestion(messageText, businessId, jid, followUp)) {
              return true;
            }
          }

          // The customer may be naming a different day in this same message
          // instead of just answering the hour (e.g. "el martes a las 14" while
          // the draft was still holding the previously chosen Wednesday).
          const nowBAForTime = nowInBuenosAires();
          const dayOverride = parseRelativeDay(messageText, nowBAForTime);
          let parsedTime = parseTimeOfDay(messageText);
          let scheduledDate = draft.scheduledDate;

          if (dayOverride && formatBaDateKey(dayOverride.baDate) !== scheduledDate) {
            if (!isWithinNextWeek(dayOverride.baDate, nowBAForTime)) {
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.outOfWindowAskDay()
              );
              return true;
            }

            const businessForDayOverride = await SupabaseService.getBusinessById(businessId);
            const weeklyHoursForDayOverride = businessForDayOverride?.weekly_hours as WeeklyHours | null | undefined;
            if (weeklyHoursForDayOverride && Object.keys(weeklyHoursForDayOverride).length > 0) {
              const dayCheck = isDayOpen(dayOverride.baDate, weeklyHoursForDayOverride);
              if (!dayCheck.open) {
                await this.sendWhatsAppMessage(businessId, jid, templates.dayClosedAskOtherDay(dayCheck.reason));
                return true;
              }
            }

            if (
              await this.raiseWeekdayDayNumberMismatchIfNeeded(
                draft,
                messageText,
                dayOverride,
                businessId,
                jid,
                parsedTime ?? undefined
              )
            ) {
              return true;
            }

            if (
              await this.raiseWeekdayAmbiguityIfNeeded(
                draft,
                dayOverride,
                conversationId,
                businessId,
                jid,
                parsedTime ?? undefined,
                weeklyHoursForDayOverride,
                businessForDayOverride?.reservation_closing_margin_minutes ?? 15
              )
            ) {
              return true;
            }

            scheduledDate = formatBaDateKey(dayOverride.baDate);
            await ReservationService.setScheduledDate(conversationId, dayOverride);
          }

          // The customer may also be changing the party size in the same
          // message (e.g. "...para 2 personas"). Only an explicit "N personas"
          // mention counts here — a bare number means the hour, not the size.
          const partySizeOverride = this.extractExplicitPartySizeMention(messageText);
          if (partySizeOverride) {
            await ReservationService.setPartySize(conversationId, partySizeOverride);
            draft.partySize = partySizeOverride;
          }

          // Regex found no hour — give the model one look before giving up
          // (e.g. "a la nochecita, tipo 9" won't match the regex's time patterns).
          if (!parsedTime && scheduledDate) {
            const timeLlmSlots = await this.getLlmSlotsFallback(draft, messageText, businessId, conversationId);
            if (timeLlmSlots?.timeText) {
              parsedTime = parseTimeOfDay(timeLlmSlots.timeText);
            }
          }

          if (!parsedTime || !scheduledDate) {
            draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
            await ReservationService.saveDraft(draft);

            if (draft.invalidAttempts >= 2) {
              await ReservationService.deleteDraft(conversationId);
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.tooManyInvalidAttempts()
              );
            } else if (scheduledDate) {
              // Suggest the first available slot on the chosen day so the customer can confirm with "sí".
              const businessForTime = await SupabaseService.getBusinessById(businessId);
              const weeklyHoursForTime = businessForTime?.weekly_hours as WeeklyHours | null | undefined;
              const openingMarginForTime = businessForTime?.reservation_opening_margin_minutes ?? 15;
              const closingMarginForTime = businessForTime?.reservation_closing_margin_minutes ?? 15;

              if (weeklyHoursForTime && Object.keys(weeklyHoursForTime).length > 0) {
                const baDateForTime = parseBaDateKey(scheduledDate);
                const todayKey = formatBaDateKey(startOfBaDay(nowBAForTime));
                const afterMinutes = scheduledDate === todayKey
                  ? nowBAForTime.getUTCHours() * 60 + nowBAForTime.getUTCMinutes()
                  : 0;
                const nextSlotOnDay = findNextSlotOnDay(
                  baDateForTime, afterMinutes, weeklyHoursForTime, openingMarginForTime, closingMarginForTime
                );
                if (nextSlotOnDay) {
                  const slotTime = `${String(nextSlotOnDay.hour).padStart(2, '0')}:${String(nextSlotOnDay.minute).padStart(2, '0')}`;
                  const slotAt = combineToUtcISO(baDateForTime, nextSlotOnDay.hour, nextSlotOnDay.minute);
                  await ReservationService.moveToConfirmSlot(conversationId, scheduledDate, slotTime, slotAt, 'time');
                  await this.sendWhatsAppMessage(
                    businessId,
                    jid,
                    templates.didntUnderstandTimeSuggest(slotTime)
                  );
                  return true;
                }
              }

              // No suitable slot on that day — re-ask with hours range.
              const dayLabel = describeBaDateKey(scheduledDate, nowBAForTime);
              await this.sendWhatsAppMessage(businessId, jid, await this.buildAskTimeMessage(businessId, scheduledDate, dayLabel, weeklyHoursForTime));
            } else {
              await this.sendWhatsAppMessage(businessId, jid, templates.invalidTime());
            }
            return true;
          }

          await this.finalizeScheduledTime(draft, conversationId, businessId, jid, scheduledDate, parsedTime.hour, parsedTime.minute);
          return true;
        }

        case 'confirm_slot': {
          const normalized = normalizeReservationScopeText(messageText);
          const isYes = /^(si|sí|yes|dale|ok|bueno|perfecto|claro|va|vamos|genial|listo)$/.test(normalized.trim());
          const isNo = /^(no|nope|nel|para nada|prefiero|otro|diferente)$/.test(normalized.trim()) || /\bno\b/.test(normalized);

          const proposedAt = draft.scheduledAt;
          const proposedDate = draft.scheduledDate;
          const proposedTime = draft.scheduledTime;
          const origin = draft.confirmSlotOrigin;

          // The customer may be naming a different day/time instead of a plain yes/no
          // (e.g. "¿puede ser el martes?", "si el martes a las 10", "no, mejor a las 21").
          // Re-parse and re-propose that slot rather than repeating the generic prompt.
          if (!isYes && hasDateOrTimeSignal(messageText, normalized)) {
            const nowBA = nowInBuenosAires();
            const parsedDay = parseRelativeDay(messageText, nowBA);
            const parsedTimeOverride = parseTimeOfDay(messageText);

            if (parsedDay || parsedTimeOverride) {
              const targetBaDate = parsedDay ? parsedDay.baDate : (proposedDate ? parseBaDateKey(proposedDate) : null);
              const [proposedHour, proposedMinute] = proposedTime ? proposedTime.split(':').map(Number) : [null, null];
              const targetHour = parsedTimeOverride ? parsedTimeOverride.hour : proposedHour;
              const targetMinute = parsedTimeOverride ? parsedTimeOverride.minute : proposedMinute;

              if (targetBaDate && targetHour !== null && targetMinute !== null && isWithinNextWeek(targetBaDate, nowBA)) {
                const newAt = combineToUtcISO(targetBaDate, targetHour, targetMinute);

                if (isInPast(newAt)) {
                  await this.sendWhatsAppMessage(businessId, jid, templates.timeAlreadyPassed());
                  return true;
                }

                const newDateKey = formatBaDateKey(targetBaDate);
                const businessForConfirm = await SupabaseService.getBusinessById(businessId);
                const weeklyHoursForConfirm = businessForConfirm?.weekly_hours as WeeklyHours | null | undefined;
                const closingMarginForConfirm = businessForConfirm?.reservation_closing_margin_minutes ?? 15;

                const blockedDatesForConfirm = await SupabaseService.getBlockedDates(businessId);
                if (isDateBlocked(newDateKey, blockedDatesForConfirm)) {
                  await this.sendWhatsAppMessage(
                    businessId,
                    jid,
                    templates.dateBlocked(
                      describeBaDateKey(newDateKey, nowBA),
                      await this.resolveBlockedDateMessage(businessId, newDateKey, blockedDatesForConfirm)
                    )
                  );
                  return true;
                }

                if (
                  isFutureReservationBlockedToday(
                    newDateKey,
                    targetHour,
                    targetMinute,
                    nowBA,
                    businessForConfirm?.future_reservations_blocked_for_date,
                    weeklyHoursForConfirm ?? {},
                    closingMarginForConfirm
                  )
                ) {
                  await this.sendWhatsAppMessage(businessId, jid, templates.futureReservationsBlockedToday());
                  return true;
                }

                const openingMarginForConfirm = businessForConfirm?.reservation_opening_margin_minutes ?? 15;
                const hoursCheck = weeklyHoursForConfirm && Object.keys(weeklyHoursForConfirm).length > 0
                  ? checkBusinessHours(targetBaDate, targetHour, targetMinute, weeklyHoursForConfirm, closingMarginForConfirm, openingMarginForConfirm)
                  : { allowed: true as const };

                if (!hoursCheck.allowed) {
                  await this.sendWhatsAppMessage(
                    businessId,
                    jid,
                    templates.hoursRejectedAskOther(hoursCheck.reason)
                  );
                  return true;
                }

                const newTimeLabel = `${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}`;
                await ReservationService.moveToConfirmSlot(conversationId, newDateKey, newTimeLabel, newAt, origin ?? 'schedule_choice');
                const label = describeScheduledAtUtc(newAt, nowBA);

                // The customer only named a day here — the time shown is carried
                // over from the previously proposed slot, not something they typed
                // for this day. Surface that day's hours so they notice and can
                // pick a different time instead of confirming one they never chose.
                let carriedTimeHoursNote = '';
                if (parsedDay && !parsedTimeOverride && weeklyHoursForConfirm && Object.keys(weeklyHoursForConfirm).length > 0) {
                  const hoursRangeForDay = formatDayHoursForDate(
                    targetBaDate,
                    weeklyHoursForConfirm,
                    openingMarginForConfirm,
                    closingMarginForConfirm
                  );
                  carriedTimeHoursNote = templates.carriedTimeHoursNote(hoursRangeForDay);
                }

                await this.sendWhatsAppMessage(
                  businessId,
                  jid,
                  templates.confirmSlotPrompt(label, carriedTimeHoursNote)
                );
                return true;
              }

              await this.sendWhatsAppMessage(businessId, jid, templates.didNotUnderstandDayAndTime());
              return true;
            }
          }

          if (isYes && proposedAt && proposedDate && proposedTime) {
            if (draft.editMode && draft.existingReservationId) {
              const ok = await SupabaseService.updateReservationSchedule(draft.existingReservationId, proposedAt);
              await ReservationService.deleteDraft(conversationId);
              const label = describeScheduledAtUtc(proposedAt, nowInBuenosAires());
              const msg = ok
                ? templates.reservationRescheduled(label)
                : templates.reservationUpdateFailed();
              await this.sendWhatsAppMessage(businessId, jid, msg);
            } else {
              await this.createAndNotifyReservation(conversationId, businessId, jid);
            }
            return true;
          }

          if (isNo) {
            if (origin === 'schedule_choice') {
              // Let the user choose again: instant or future day
              await ReservationService.moveToScheduleChoice(conversationId);
              await this.promptScheduleChoice(conversationId, businessId, jid);
            } else if (origin === 'date') {
              // Come back from date step: clear proposed slot, ask for a different day
              const dateDraftForDate = await ReservationService.getDraft(conversationId);
              if (dateDraftForDate) {
                dateDraftForDate.step = 'date';
                dateDraftForDate.scheduledAt = undefined;
                dateDraftForDate.scheduledTime = undefined;
                dateDraftForDate.scheduledDate = undefined;
                dateDraftForDate.confirmSlotOrigin = undefined;
                await ReservationService.saveDraft(dateDraftForDate);
              }
              await this.sendWhatsAppMessage(businessId, jid, await this.buildAskDayMessage(businessId));
            } else {
              // Come back from time step: ask for a different time on the same day
              const dateDraft = await ReservationService.getDraft(conversationId);
              if (dateDraft) {
                dateDraft.step = 'time';
                dateDraft.scheduledAt = undefined;
                dateDraft.scheduledTime = undefined;
                dateDraft.confirmSlotOrigin = undefined;
                await ReservationService.saveDraft(dateDraft);
              }
              await this.sendWhatsAppMessage(businessId, jid, templates.askTimeAgain());
            }
            return true;
          }

          const fallbackLabel = proposedAt ? describeScheduledAtUtc(proposedAt, nowInBuenosAires()) : null;
          await this.sendWhatsAppMessage(
            businessId,
            jid,
            templates.confirmSlotYesNoReminder(fallbackLabel)
          );
          return true;
        }

        case 'edit_menu': {
          // M2: user is choosing what to modify: 1=personas, 2=fecha, 3=horario, 4=nueva reserva
          const choice = this.extractNumber(messageText);
          const reservationId = draft.existingReservationId;

          if (!reservationId) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, templates.noActiveReservation());
            return true;
          }

          if (choice === 4 || this.isExplicitNewReservationIntent(messageText)) {
            await ReservationService.deleteDraft(conversationId);
            await this.startNewReservationFlow(
              conversationId,
              businessId,
              jid,
              this.normalizeWhatsAppNumber(jid),
              templates.askName()
            );
            return true;
          }

          // Editing the stored name/apellido is intentionally NOT a numbered
          // menu option (it's only reachable via natural language — see
          // handleNameChangeIntent() / the edit_customer_name step) so it
          // doesn't advertise itself as an action the customer has to guess is there.

          if (choice === 1) {
            await ReservationService.startEditReservation(conversationId, businessId, reservationId, {
              customerName: draft.customerName,
              partySize: draft.partySize,
            });
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.askNewPartySize()
            );
            return true;
          } else if (choice === 2) {
            // Change only the day, keeping the current time when one exists.
            if (draft.scheduledAt) {
              const parts = utcIsoToBaParts(draft.scheduledAt);
              await ReservationService.startEditDate(
                conversationId,
                businessId,
                reservationId,
                { customerName: draft.customerName, partySize: draft.partySize },
                parts
              );
              await this.sendWhatsAppMessage(businessId, jid, await this.buildAskDayMessage(businessId));
            } else {
              // Instant reservation: there is no time to keep — full schedule flow
              await ReservationService.startEditSchedule(conversationId, businessId, reservationId, {
                customerName: draft.customerName,
                partySize: draft.partySize,
              });
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                await this.buildScheduleChoiceMessage(conversationId, businessId)
              );
            }
            return true;
          } else if (choice === 3) {
            // Change only the time, keeping the current day (today for instant ones)
            const dateKey = draft.scheduledAt
              ? utcIsoToBaParts(draft.scheduledAt).dateKey
              : formatBaDateKey(nowInBuenosAires());
            await ReservationService.startEditTime(
              conversationId,
              businessId,
              reservationId,
              { customerName: draft.customerName, partySize: draft.partySize },
              dateKey
            );
            const dayLabel = describeBaDateKey(dateKey, nowInBuenosAires());
            await this.sendWhatsAppMessage(businessId, jid, await this.buildAskTimeMessage(businessId, dateKey, dayLabel));
            return true;
          } else {
            await this.sendWhatsAppMessage(businessId, jid, templates.editMenuInvalidChoice());
            return true;
          }
        }

        case 'confirm_summary': {
          // M1 "Resumen y confirmación": 1=confirmar, 2=modificar
          const trimmedSummary = messageText.trim();
          const normalizedSummary = normalizeReservationScopeText(messageText);
          const wantsConfirm =
            trimmedSummary === '1' ||
            /^(si|sí|confirmar|confirmo|dale|ok|okay|correcto|perfecto|listo)\b/.test(
              normalizedSummary
            );
          const wantsModify =
            trimmedSummary === '2' || /\b(modificar|cambiar|editar)\b/.test(normalizedSummary);

          if (wantsConfirm) {
            await this.createAndNotifyReservation(conversationId, businessId, jid);
            return true;
          }

          if (wantsModify) {
            draft.step = 'summary_edit_menu';
            draft.invalidAttempts = 0;
            await ReservationService.saveDraft(draft);
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              draft.eventId ? templates.summaryEditMenuEvent() : templates.summaryEditMenu()
            );
            return true;
          }

          draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
          if (draft.invalidAttempts >= 2) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, templates.tooManyInvalidAttempts());
          } else {
            await ReservationService.saveDraft(draft);
            await this.sendWhatsAppMessage(businessId, jid, templates.confirmSummaryInvalidChoice());
          }
          return true;
        }

        case 'summary_edit_menu': {
          // What to modify before confirming: 1=personas, 2=fecha, 3=horario
          const summaryChoice = this.extractNumber(messageText);

          // Reserva de evento: la fecha y el horario los fija el evento, así
          // que el menú sólo ofrece 1=personas y 2=salirse del evento para
          // volver a elegir (ver summaryEditMenuEvent).
          if (draft.eventId && summaryChoice === 2) {
            draft.eventId = undefined;
            draft.eventTitle = undefined;
            draft.scheduledAt = undefined;
            draft.scheduledDate = undefined;
            draft.scheduledTime = undefined;
            draft.invalidAttempts = 0;
            await ReservationService.saveDraft(draft);
            await this.promptScheduleChoice(conversationId, businessId, jid);
            return true;
          }

          if (draft.eventId && summaryChoice === 3) {
            await this.sendWhatsAppMessage(businessId, jid, templates.summaryEditMenuEvent());
            return true;
          }

          if (summaryChoice === 1) {
            draft.step = 'party_size';
            draft.returnToSummary = true;
            draft.invalidAttempts = 0;
            await ReservationService.saveDraft(draft);
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.askPartySize(draft.customerName || 'Cliente')
            );
            return true;
          }

          if (summaryChoice === 2) {
            draft.step = 'date';
            draft.returnToSummary = true;
            draft.invalidAttempts = 0;
            await ReservationService.saveDraft(draft);
            await this.sendWhatsAppMessage(businessId, jid, await this.buildAskDayMessage(businessId));
            return true;
          }

          if (summaryChoice === 3) {
            if (!draft.scheduledDate) {
              // Instant draft: anchor the time change to today
              draft.scheduledDate = formatBaDateKey(nowInBuenosAires());
            }
            draft.step = 'time';
            draft.returnToSummary = true;
            draft.invalidAttempts = 0;
            await ReservationService.saveDraft(draft);
            const dayLabel = describeBaDateKey(draft.scheduledDate, nowInBuenosAires());
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              await this.buildAskTimeMessage(businessId, draft.scheduledDate, dayLabel)
            );
            return true;
          }

          await this.sendWhatsAppMessage(
            businessId,
            jid,
            draft.eventId ? templates.summaryEditMenuEvent() : templates.editMenuInvalidChoice()
          );
          return true;
        }

        case 'reservation_selection': {
          const phone = this.normalizeWhatsAppNumber(jid);
          const selection = this.extractNumber(messageText);

          if (this.isExplicitNewReservationIntent(messageText)) {
            await this.startNewReservationFlow(conversationId, businessId, jid, phone, templates.askName());
            return true;
          }

          if (selection && draft.availableReservationIds?.[selection - 1]) {
            const selectedReservationId = draft.availableReservationIds[selection - 1];
            const activeReservations = await SupabaseService.getActiveReservationsByPhone(
              phone,
              businessId
            );
            const selectedReservation = activeReservations.find(
              (reservation) => reservation.id === selectedReservationId
            );

            if (selectedReservation) {
              // Route to the flow the customer originally asked for (cancel vs
              // modify); default to the edit menu when the selection came from a
              // plain "hola"/inquiry with no specific action attached.
              if (draft.pendingSelectionAction === 'cancel') {
                await this.startCancelFlow(conversationId, businessId, jid, selectedReservation);
              } else {
                await this.startEditMenuFlow(conversationId, businessId, jid, selectedReservation);
              }
              return true;
            }
          }

          await this.sendWhatsAppMessage(businessId, jid, templates.activeReservationSelectionInvalid());
          return true;
        }

        case 'edit_customer_name': {
          // Capturing a natural-language name/apellido change (see handleNameChangeIntent).
          if (isGreetingOrReservationOptInMessage(messageText)) {
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.askCorrectNameField(draft.nameEditField === 'lastName' ? 'lastName' : 'full')
            );
            return true;
          }

          const candidate = this.extractNameCandidate(messageText);
          if (!candidate) {
            draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
            await ReservationService.saveDraft(draft);
            if (draft.invalidAttempts >= 2) {
              await ReservationService.deleteDraft(conversationId);
              await this.sendWhatsAppMessage(businessId, jid, templates.tooManyInvalidAttempts());
            } else {
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                templates.invalidLastNameRetry()
              );
            }
            return true;
          }

          const phone = this.normalizeWhatsAppNumber(jid);
          const field = draft.nameEditField ?? 'full';
          const updated = await this.applyCustomerNameChange(phone, businessId, field, candidate);
          await ReservationService.deleteDraft(conversationId);

          if (!updated) {
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              templates.noStoredCustomerData()
            );
            return true;
          }

          const fullName = this.buildFullName(updated.name, updated.lastName) || updated.name;
          await this.sendWhatsAppMessage(
            businessId,
            jid,
            templates.customerNameUpdated(fullName)
          );
          return true;
        }

        case 'cancel_menu': {
          // M3: 1=reprogramar, 2=cancelar definitivamente
          const normalizedCancel = normalizeReservationScopeText(messageText);
          const cancelChoice = this.extractNumber(messageText);
          const wantsReschedule = cancelChoice === 1 || /\breprogramar\b/.test(normalizedCancel);
          const wantsDefinitiveCancel =
            cancelChoice === 2 || /\b(cancelar|anular|definitivamente)\b/.test(normalizedCancel);
          const cancelReservationId = draft.existingReservationId;

          if (!cancelReservationId) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, templates.noActiveReservation());
            return true;
          }

          if (wantsReschedule) {
            await ReservationService.startEditSchedule(conversationId, businessId, cancelReservationId, {
              customerName: draft.customerName,
              partySize: draft.partySize,
            });
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              `${templates.rescheduleIntro()}\n\n${await this.buildScheduleChoiceMessage(conversationId, businessId)}`
            );
            return true;
          }

          if (wantsDefinitiveCancel) {
            draft.step = 'cancel_confirm';
            draft.invalidAttempts = 0;
            await ReservationService.saveDraft(draft);
            await this.sendWhatsAppMessage(businessId, jid, templates.cancelConfirmPrompt());
            return true;
          }

          draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
          if (draft.invalidAttempts >= 2) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, templates.reservationKept());
          } else {
            await ReservationService.saveDraft(draft);
            await this.sendWhatsAppMessage(businessId, jid, templates.cancelMenuInvalidChoice());
          }
          return true;
        }

        case 'cancel_confirm': {
          // M3 "¿Estás seguro?": 1=sí, cancelar / 2=no, conservar
          const normalizedConfirm = normalizeReservationScopeText(messageText);
          const confirmChoice = this.extractNumber(messageText);
          // Check the negative FIRST because "no quiero cancelar" also contains "cancelar".
          const wantsToKeep =
            confirmChoice === 2 || /^no\b/.test(normalizedConfirm) || /\bconservar\b/.test(normalizedConfirm);
          const wantsToCancel =
            confirmChoice === 1 ||
            /^(si|sí)\b/.test(normalizedConfirm) ||
            /\b(cancelar|anular)\b/.test(normalizedConfirm);
          const confirmReservationId = draft.existingReservationId;

          if (!confirmReservationId) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, templates.noActiveReservation());
            return true;
          }

          if (wantsToKeep) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, templates.reservationKept());
            logger.debug('Cancellation aborted — reservation kept', {
              conversationId,
              reservationId: confirmReservationId,
            });
            return true;
          }

          if (wantsToCancel) {
            await ReservationService.deleteDraft(conversationId);
            const cancelled = await this.cancelReservationForCustomer(confirmReservationId);
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              cancelled ? templates.reservationCancelled() : templates.cancelFailed()
            );
            logEvent(cancelled ? 'info' : 'warn', 'reservation.cancelled', {
              reservationId: confirmReservationId,
              via: 'm3_flow',
              success: cancelled,
            });
            return true;
          }

          draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
          if (draft.invalidAttempts >= 2) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, templates.reservationKept());
          } else {
            await ReservationService.saveDraft(draft);
            await this.sendWhatsAppMessage(businessId, jid, templates.cancelConfirmInvalidChoice());
          }
          return true;
        }

        case 'completed':
          // Already completed
          break;
      }
    } catch (error) {
      logger.error('Error processing draft step', { error, conversationId, step: draft.step });
    }

    return false; // No custom message sent, continue with agent response
  }

  /**
   * When `parsedDay` was resolved by naming a weekday that happens to be TODAY
   * (e.g. "el jueves" said on a Thursday), it's genuinely ambiguous whether the
   * customer means today or next week. If so, stashes both candidate dates
   * (plus any time already given in the same message) on the draft, asks the
   * customer to clarify, and returns true — the caller should stop processing
   * and let the next inbound message resolve it (see the top of
   * {@link processDraftStep}). Returns false when there's nothing ambiguous.
   *
   * There's one case where naming today's weekday is NOT ambiguous: if the
   * business is already closed for the rest of today (no bookable shift left),
   * "today" isn't a real option anymore, so it can only mean next week — that
   * case resolves straight through {@link finalizeWeekdayChoice} instead of
   * asking a question with an answer that's already known. `weeklyHours` is
   * optional so callers that haven't fetched it yet keep the always-ask
   * behavior rather than skipping this check.
   */
  private async raiseWeekdayAmbiguityIfNeeded(
    draft: ReservationDraft,
    parsedDay: ParsedDay,
    conversationId: string,
    businessId: string,
    jid: string,
    pendingTime?: { hour: number; minute: number },
    weeklyHours?: WeeklyHours | null,
    closingMarginMinutes = 15
  ): Promise<boolean> {
    if (!parsedDay.isToday || !parsedDay.matchedWeekdayName) {
      return false;
    }

    const todayDateKey = formatBaDateKey(parsedDay.baDate);
    const nextBaDate = addBaDays(parsedDay.baDate, 7);
    const nextDateKey = formatBaDateKey(nextBaDate);
    const weekdayLabel = formatDayLabel(parsedDay.baDate, false); // e.g. "jueves 02/07"
    const nextLabel = formatDayLabel(nextBaDate, false); // e.g. "jueves 09/07"

    if (
      weeklyHours &&
      Object.keys(weeklyHours).length > 0 &&
      !hasBookableMomentLeftToday(nowInBuenosAires(), weeklyHours, closingMarginMinutes)
    ) {
      await this.finalizeWeekdayChoice(
        draft,
        conversationId,
        businessId,
        jid,
        nextDateKey,
        todayDateKey,
        pendingTime?.hour,
        pendingTime?.minute
      );
      return true;
    }

    draft.pendingWeekdayDisambiguation = {
      weekdayLabel,
      todayDateKey,
      nextDateKey,
      pendingHour: pendingTime?.hour,
      pendingMinute: pendingTime?.minute,
    };
    await ReservationService.saveDraft(draft);

    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.weekdayAmbiguityPrompt(weekdayLabel, nextLabel)
    );
    return true;
  }

  /**
   * Resolves a pending weekday-disambiguation question (see
   * {@link raiseWeekdayAmbiguityIfNeeded}) from the customer's reply. Returns
   * true once handled (either resolved and continued, or re-asked because the
   * reply wasn't recognized).
   */
  private async resolvePendingWeekdayDisambiguation(
    draft: ReservationDraft,
    messageText: string,
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<boolean> {
    const pending = draft.pendingWeekdayDisambiguation;
    if (!pending) return false;

    const trimmed = messageText.trim();
    const normalized = normalizeReservationScopeText(messageText);
    const wantsToday = trimmed === '1' || /\bhoy\b/.test(normalized);
    const wantsNext = trimmed === '2' || /\b(que viene|proxim\w*|semana que viene|el otro)\b/.test(normalized);

    if (!wantsToday && !wantsNext) {
      draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
      if (draft.invalidAttempts >= 2) {
        await ReservationService.deleteDraft(conversationId);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.tooManyInvalidAttempts()
        );
      } else {
        await ReservationService.saveDraft(draft);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.weekdayAmbiguityInvalid(pending.weekdayLabel.split(' ')[0])
        );
      }
      return true;
    }

    const chosenDateKey = wantsToday ? pending.todayDateKey : pending.nextDateKey;
    draft.pendingWeekdayDisambiguation = undefined;

    await this.finalizeWeekdayChoice(
      draft,
      conversationId,
      businessId,
      jid,
      chosenDateKey,
      pending.todayDateKey,
      pending.pendingHour,
      pending.pendingMinute
    );
    return true;
  }

  /**
   * Commits a resolved weekday choice (either "today" or "next week", however
   * that was decided — an explicit 1/2 reply via
   * {@link resolvePendingWeekdayDisambiguation}, or the automatic next-week
   * resolution in {@link raiseWeekdayAmbiguityIfNeeded} when today is already
   * closed): applies any time given in the same original message, otherwise
   * checks the date isn't business-blocked and asks for the time.
   */
  private async finalizeWeekdayChoice(
    draft: ReservationDraft,
    conversationId: string,
    businessId: string,
    jid: string,
    chosenDateKey: string,
    todayDateKey: string,
    pendingHour?: number,
    pendingMinute?: number
  ): Promise<void> {
    if (pendingHour !== undefined && pendingMinute !== undefined) {
      await ReservationService.saveDraft(draft);
      await this.finalizeScheduledTime(
        draft,
        conversationId,
        businessId,
        jid,
        chosenDateKey,
        pendingHour,
        pendingMinute
      );
      return;
    }

    const chosenBaDate = parseBaDateKey(chosenDateKey);
    const chosenLabel = describeBaDateKey(chosenDateKey, nowInBuenosAires());

    // Reject dates the business has explicitly blocked (business_blocked_dates)
    // right away — before asking for the time.
    const blockedDatesForChoice = await SupabaseService.getBlockedDates(businessId);
    if (isDateBlocked(chosenDateKey, blockedDatesForChoice)) {
      await this.sendWhatsAppMessage(
        businessId,
        jid,
        templates.dateBlocked(
          chosenLabel,
          await this.resolveBlockedDateMessage(businessId, chosenDateKey, blockedDatesForChoice)
        )
      );
      return;
    }

    await ReservationService.setScheduledDate(conversationId, {
      baDate: chosenBaDate,
      label: chosenLabel,
      isToday: chosenDateKey === todayDateKey,
      matchedWeekdayName: true,
    });
    await this.sendWhatsAppMessage(businessId, jid, await this.buildAskTimeMessage(businessId, chosenDateKey, chosenLabel));
  }

  /**
   * When the customer names a weekday together with an explicit day-of-month
   * number that doesn't match the nearest in-window occurrence of that
   * weekday (e.g. "jueves 17" when the closest bookable Thursday is the 9th),
   * the requested date is beyond the 7-day booking window. Instead of
   * silently booking the nearest Thursday (ignoring the "17"), stash the
   * nearest in-window alternative (plus any time already given in the same
   * message) and ask the customer whether to take it instead. Returns true
   * once handled — the caller should stop processing and let the next
   * inbound message resolve it (see the top of {@link processDraftStep}).
   * Returns false when there's no such mismatch.
   */
  private async raiseWeekdayDayNumberMismatchIfNeeded(
    draft: ReservationDraft,
    messageText: string,
    parsedDay: ParsedDay,
    businessId: string,
    jid: string,
    pendingTime?: { hour: number; minute: number }
  ): Promise<boolean> {
    const mismatch = findWeekdayDayNumberMismatch(messageText, parsedDay);
    if (!mismatch) return false;

    const nearestDateKey = formatBaDateKey(parsedDay.baDate);
    const nearestLabel = parsedDay.label;

    draft.pendingWeekdayDayMismatch = {
      weekdayLabel: mismatch.weekdayLabel,
      requestedDayNumber: mismatch.requestedDayNumber,
      nearestDateKey,
      nearestLabel,
      nearestIsToday: parsedDay.isToday,
      pendingHour: pendingTime?.hour,
      pendingMinute: pendingTime?.minute,
    };
    await ReservationService.saveDraft(draft);

    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.weekdayDayMismatchPrompt(mismatch.weekdayLabel, mismatch.requestedDayNumber, nearestLabel)
    );
    return true;
  }

  /**
   * Resolves a pending weekday/day-number mismatch question (see
   * {@link raiseWeekdayDayNumberMismatchIfNeeded}) from the customer's reply.
   * Returns true once handled (either resolved and continued, or re-asked
   * because the reply wasn't recognized).
   */
  private async resolvePendingWeekdayDayMismatch(
    draft: ReservationDraft,
    messageText: string,
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<boolean> {
    const pending = draft.pendingWeekdayDayMismatch;
    if (!pending) return false;

    const trimmed = messageText.trim();
    const normalized = normalizeReservationScopeText(messageText);
    const wantsYes = trimmed === '1' || /^(si|dale|ok|okay|okey|oka|claro|va|de una)\b/.test(normalized);
    const wantsNo = trimmed === '2' || /^no\b/.test(normalized);

    if (!wantsYes && !wantsNo) {
      draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
      if (draft.invalidAttempts >= 2) {
        await ReservationService.deleteDraft(conversationId);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.tooManyInvalidAttempts()
        );
      } else {
        await ReservationService.saveDraft(draft);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.weekdayDayMismatchInvalid(pending.nearestLabel)
        );
      }
      return true;
    }

    draft.pendingWeekdayDayMismatch = undefined;

    if (wantsNo) {
      await ReservationService.saveDraft(draft);
      await this.sendWhatsAppMessage(businessId, jid, await this.buildAskDayMessage(businessId));
      return true;
    }

    if (pending.pendingHour !== undefined && pending.pendingMinute !== undefined) {
      await ReservationService.saveDraft(draft);
      await this.finalizeScheduledTime(
        draft,
        conversationId,
        businessId,
        jid,
        pending.nearestDateKey,
        pending.pendingHour,
        pending.pendingMinute
      );
      return true;
    }

    // Reject dates the business has explicitly blocked (business_blocked_dates)
    // right away — before asking for the time.
    const blockedDatesForMismatch = await SupabaseService.getBlockedDates(businessId);
    if (isDateBlocked(pending.nearestDateKey, blockedDatesForMismatch)) {
      await this.sendWhatsAppMessage(
        businessId,
        jid,
        templates.dateBlocked(
          pending.nearestLabel,
          await this.resolveBlockedDateMessage(businessId, pending.nearestDateKey, blockedDatesForMismatch)
        )
      );
      return true;
    }

    const nearestBaDate = parseBaDateKey(pending.nearestDateKey);
    await ReservationService.setScheduledDate(conversationId, {
      baDate: nearestBaDate,
      label: pending.nearestLabel,
      isToday: pending.nearestIsToday,
      matchedWeekdayName: true,
    });
    await this.sendWhatsAppMessage(
      businessId,
      jid,
      await this.buildAskTimeMessage(businessId, pending.nearestDateKey, pending.nearestLabel)
    );
    return true;
  }

  /**
   * Resolves the pending "¿a qué hora es la reserva de hoy?" question raised
   * when the customer chooses the instant/today option while the business is
   * currently open (see the `wantsInstant` branch of the `schedule_choice`
   * step). Lets the customer either name a specific hour — validated and
   * finalized like any other slot via {@link finalizeScheduledTime}, with the
   * usual same-day fallback on a business-hours conflict — or reply "ahora"
   * to keep the original instant/current-turn behavior.
   */
  private async resolvePendingTodayTimeChoice(
    draft: ReservationDraft,
    messageText: string,
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<boolean> {
    const pending = draft.pendingTodayTimeChoice;
    if (!pending) return false;

    if (isGreetingOrReservationOptInMessage(messageText)) {
      await this.sendWhatsAppMessage(businessId, jid, templates.askTodayTimeOpen(pending.closeLabel));
      return true;
    }

    const trimmedChoice = messageText.trim();
    const normalized = normalizeReservationScopeText(messageText);

    if (trimmedChoice === '1' || isInstantChoiceMessage(normalized)) {
      draft.pendingTodayTimeChoice = undefined;
      await ReservationService.saveDraft(draft);
      await ReservationService.setInstantSchedule(conversationId);
      await this.showReservationSummary(conversationId, businessId, jid);
      return true;
    }

    const parsedTime = parseTimeOfDay(messageText);

    if (!parsedTime) {
      draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
      await ReservationService.saveDraft(draft);

      if (draft.invalidAttempts >= 2) {
        await ReservationService.deleteDraft(conversationId);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.tooManyInvalidAttempts()
        );
      } else {
        // Re-ask including the closing time context already known from pending.
        await this.sendWhatsAppMessage(businessId, jid, templates.askTodayTimeOpen(pending.closeLabel));
      }
      return true;
    }

    draft.pendingTodayTimeChoice = undefined;
    await ReservationService.saveDraft(draft);
    const awaitingRetry = await this.finalizeScheduledTime(
      draft,
      conversationId,
      businessId,
      jid,
      pending.dateKey,
      parsedTime.hour,
      parsedTime.minute
    );
    if (awaitingRetry) {
      draft.pendingTodayTimeChoice = pending;
      await ReservationService.saveDraft(draft);
    }
    return true;
  }

  /**
   * Builds the "¿A qué hora...?" prompt including the business's opening hours
   * for that specific day (e.g. "08:00–14:00 y 17:00–02:00"), so the customer
   * doesn't have to ask separately what the schedule is. Pass `knownWeeklyHours`
   * to reuse a `weekly_hours` value the caller already fetched; omit it to fetch
   * fresh. Falls back to the plain prompt when hours aren't configured.
   */
  private async buildAskTimeMessage(
    businessId: string,
    dateKey: string,
    dayLabel: string,
    knownWeeklyHours?: WeeklyHours | null
  ): Promise<string> {
    // Fetch the business (Redis-cached) for both weekly_hours and the margins so
    // the displayed range reflects the actually-bookable window (opening+margin
    // → close−margin) rather than the raw open/close times.
    const business = await SupabaseService.getBusinessById(businessId);
    const weeklyHours =
      knownWeeklyHours !== undefined
        ? knownWeeklyHours
        : (business?.weekly_hours as WeeklyHours | null | undefined);
    const openingMargin = business?.reservation_opening_margin_minutes ?? 0;
    const closingMargin = business?.reservation_closing_margin_minutes ?? 0;
    const hoursRange =
      weeklyHours && Object.keys(weeklyHours).length > 0
        ? formatDayHoursForDate(parseBaDateKey(dateKey), weeklyHours, openingMargin, closingMargin)
        : null;
    return templates.askTime(dayLabel, hoursRange);
  }

  /**
   * Builds the "¿Qué día preferís?" prompt including the open days of the week
   * so the customer knows upfront which days are available.
   * Pass `knownWeeklyHours` to reuse an already-fetched value; omit to fetch fresh.
   */
  private async buildAskDayMessage(
    businessId: string,
    knownWeeklyHours?: WeeklyHours | null
  ): Promise<string> {
    const business = await SupabaseService.getBusinessById(businessId);
    const weeklyHours =
      knownWeeklyHours !== undefined
        ? knownWeeklyHours
        : (business?.weekly_hours as WeeklyHours | null | undefined);
    let openDays: string | null = null;
    if (weeklyHours && Object.keys(weeklyHours).length > 0) {
      const nowBA = nowInBuenosAires();
      const blockedDates = await SupabaseService.getBlockedDates(businessId);
      const todayKey = formatBaDateKey(startOfBaDay(nowBA));
      const closingMargin = business?.reservation_closing_margin_minutes ?? 15;

      // When the business has blocked further reservations for today
      // (future_reservations_blocked_for_date) and no shift is active right now,
      // today has no bookable slot left — drop it from the offered days too.
      const todayFullyBlocked =
        business?.future_reservations_blocked_for_date === todayKey &&
        !isWithinCurrentShift(nowBA.getUTCHours(), nowBA.getUTCMinutes(), nowBA, weeklyHours, closingMargin);

      openDays =
        formatBookableDays(
          weeklyHours,
          nowBA,
          // Omit weekdays whose upcoming occurrence is a blocked date — or today
          // when future reservations are closed and there's no current turno — so
          // we never suggest a day the customer cannot actually book.
          (key) => isDateBlocked(key, blockedDates) || (todayFullyBlocked && key === todayKey)
        ) || null;
    }
    return templates.askDay(openDays);
  }

  /**
   * Handles "¿y los horarios de los otros días?" at the `schedule_choice`/
   * `date`/`time` steps: instead of falling through to the LLM fallback (which
   * has no access to `weekly_hours` and ends up claiming ignorance), answers
   * with the real upcoming days/hours and re-sends `followUpMessage` so the
   * customer can pick a day/time right after — without touching the draft's
   * step or losing what's already been chosen. Returns true when it handled
   * the message (caller should `return true` immediately after); false when
   * the message wasn't this kind of question, or hours aren't configured, so
   * the caller's normal parsing logic should run instead.
   */
  private async maybeAnswerOtherDaysScheduleQuestion(
    messageText: string,
    businessId: string,
    jid: string,
    followUpMessage: string
  ): Promise<boolean> {
    if (!isAskingOtherDaysScheduleMessage(normalizeReservationScopeText(messageText))) {
      return false;
    }

    const business = await SupabaseService.getBusinessById(businessId);
    const weeklyHours = business?.weekly_hours as WeeklyHours | null | undefined;
    if (!weeklyHours || Object.keys(weeklyHours).length === 0) {
      return false;
    }

    const nowBA = nowInBuenosAires();
    const blockedDates = await SupabaseService.getBlockedDates(businessId);
    const openingMargin = business?.reservation_opening_margin_minutes ?? 15;
    const closingMargin = business?.reservation_closing_margin_minutes ?? 15;
    const dayLines = getUpcomingOpenDaysWithHours(
      weeklyHours,
      nowBA,
      (dateKey) => isDateBlocked(dateKey, blockedDates),
      openingMargin,
      closingMargin,
      6
    );

    await this.sendWhatsAppMessage(
      businessId,
      jid,
      `${templates.otherDaysSchedule(dayLines)}\n\n${followUpMessage}`
    );
    return true;
  }

  /**
   * Computes the soonest bookable slot (never today — the customer is picking a
   * specific day) honoring business hours and blocked dates, and if one exists
   * moves the draft to `confirm_slot` proposing it. The customer accepts with
   * "sí" or names another day/time. Returns true when a suggestion was sent;
   * false when nothing is available, so the caller can fall back to its own
   * re-ask. `reason` (why the requested day/time didn't work) is prefixed to the
   * message; `preferDate` biases the search toward a specific day first.
   */
  private async proposeSoonestSlot(
    conversationId: string,
    businessId: string,
    jid: string,
    origin: 'schedule_choice' | 'time' | 'date',
    reason: string | null,
    options: { preferDate?: Date } = {}
  ): Promise<boolean> {
    const business = await SupabaseService.getBusinessById(businessId);
    const weeklyHours = business?.weekly_hours as WeeklyHours | null | undefined;
    if (!weeklyHours || Object.keys(weeklyHours).length === 0) return false;

    const margin = business?.reservation_opening_margin_minutes ?? 15;
    const closingMargin = business?.reservation_closing_margin_minutes ?? 15;
    const blockedDates = await SupabaseService.getBlockedDates(businessId);

    const slot = findSoonestBookableSlot(nowInBuenosAires(), weeklyHours, margin, closingMargin, {
      skipToday: true,
      preferDate: options.preferDate,
      isDateBlocked: (key) => isDateBlocked(key, blockedDates),
    });
    if (!slot) return false;

    const slotDateKey = formatBaDateKey(slot.baDate);
    const slotTime = `${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`;
    const slotAt = combineToUtcISO(slot.baDate, slot.hour, slot.minute);
    await ReservationService.moveToConfirmSlot(conversationId, slotDateKey, slotTime, slotAt, origin);
    await this.sendWhatsAppMessage(businessId, jid, templates.suggestNextSlot(slot.label, reason));
    return true;
  }

  /**
   * Validates a day+hour pair and either finishes the reservation (create or,
   * in edit mode, update) or offers the next same-day slot on a business-hours
   * conflict. Shared by the `time` step and by `date`/`schedule_choice` when the
   * customer names a day AND a time together (e.g. "el miércoles a las 19").
   */
  /**
   * Returns `true` when the time was rejected but the customer still gets to
   * retry (invalid attempts under the cap) — callers that track a pending
   * "waiting for a time" flag must keep it set in that case so the retry
   * routes back to the same prompt instead of falling through to whatever
   * step the draft was last on.
   */
  private async finalizeScheduledTime(
    draft: ReservationDraft,
    conversationId: string,
    businessId: string,
    jid: string,
    scheduledDate: string,
    hour: number,
    minute: number
  ): Promise<boolean> {
    const baDate = parseBaDateKey(scheduledDate);
    const scheduledAt = combineToUtcISO(baDate, hour, minute);
    const nowBA = nowInBuenosAires();
    const today = formatBaDateKey(startOfBaDay(nowBA));

    if (isInPast(scheduledAt)) {
      // For today's date with a past time, offer the same time tomorrow instead
      if (scheduledDate === today) {
        const tomorrowDate = addBaDays(baDate, 1);
        const tomorrowDateKey = formatBaDateKey(tomorrowDate);
        const tomorrowScheduledAt = combineToUtcISO(tomorrowDate, hour, minute);
        const tomorrowLabel = formatDayLabel(tomorrowDate, false);
        const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

        await ReservationService.moveToConfirmSlot(conversationId, tomorrowDateKey, timeLabel, tomorrowScheduledAt, 'time');
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.timeAlreadyPassedSuggestTomorrow(timeLabel, tomorrowLabel)
        );
        return true;
      }

      draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
      await ReservationService.saveDraft(draft);

      if (draft.invalidAttempts >= 2) {
        await ReservationService.deleteDraft(conversationId);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.tooManyInvalidAttempts()
        );
        return false;
      }

      await this.sendWhatsAppMessage(
        businessId,
        jid,
        templates.timeAlreadyPassed()
      );
      return true;
    }

    const business = await SupabaseService.getBusinessById(businessId);
    const weeklyHours = business?.weekly_hours as WeeklyHours | null | undefined;
    const closingMargin = business?.reservation_closing_margin_minutes ?? 15;

    // Blocked dates / future-reservation closures take priority over the
    // regular hours check — a day can be within business hours and still be
    // unavailable for a business-configured reason (holiday closure, etc.).
    const blockedDates = await SupabaseService.getBlockedDates(businessId);
    if (isDateBlocked(scheduledDate, blockedDates)) {
      const blockedReason = await this.resolveBlockedDateMessage(businessId, scheduledDate, blockedDates);
      // Offer the soonest bookable day (never today) so the customer can accept
      // with "sí" instead of just being told the date is unavailable.
      if (await this.proposeSoonestSlot(conversationId, businessId, jid, 'date', blockedReason ?? null)) {
        return false;
      }
      draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
      await ReservationService.saveDraft(draft);
      if (draft.invalidAttempts >= 2) {
        await ReservationService.deleteDraft(conversationId);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.tooManyInvalidAttempts()
        );
        return false;
      }
      await this.sendWhatsAppMessage(
        businessId,
        jid,
        templates.dateBlocked(describeBaDateKey(scheduledDate, nowBA), blockedReason)
      );
      return true;
    }

    if (
      isFutureReservationBlockedToday(
        scheduledDate,
        hour,
        minute,
        nowBA,
        business?.future_reservations_blocked_for_date,
        weeklyHours ?? {},
        closingMargin
      )
    ) {
      draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
      await ReservationService.saveDraft(draft);
      if (draft.invalidAttempts >= 2) {
        await ReservationService.deleteDraft(conversationId);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.tooManyInvalidAttempts()
        );
        return false;
      }
      await this.sendWhatsAppMessage(businessId, jid, templates.futureReservationsBlockedToday());
      return true;
    }

    // Check business hours if weekly_hours is configured
    if (weeklyHours && Object.keys(weeklyHours).length > 0) {
      const openingMargin = business?.reservation_opening_margin_minutes ?? 15;
      const hoursCheck = checkBusinessHours(baDate, hour, minute, weeklyHours, closingMargin, openingMargin);
      if (!hoursCheck.allowed) {
        const margin = openingMargin;
        const afterMinutes = hour * 60 + minute;
        const nextSlot = findNextSlotOnDay(baDate, afterMinutes, weeklyHours, margin, closingMargin);

        if (nextSlot) {
          // Offer the next available opening on the same day
          const slotTime = `${String(nextSlot.hour).padStart(2, '0')}:${String(nextSlot.minute).padStart(2, '0')}`;
          const slotAt = combineToUtcISO(baDate, nextSlot.hour, nextSlot.minute);
          await ReservationService.moveToConfirmSlot(conversationId, scheduledDate, slotTime, slotAt, 'time');
          await this.sendWhatsAppMessage(
            businessId,
            jid,
            templates.hoursRejectedSuggestSlot(hoursCheck.reason, slotTime)
          );
          return false;
        }

        // No later opening on the chosen day — offer the soonest slot on another
        // day (never today, since they picked a specific day) so they can still
        // confirm with "sí" instead of being left to guess a new day/time.
        if (
          await this.proposeSoonestSlot(conversationId, businessId, jid, 'time', hoursCheck.reason ?? null, {
            preferDate: baDate,
          })
        ) {
          return false;
        }

        // No availability anywhere in the window — ask user to pick a different time or day
        draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
        await ReservationService.saveDraft(draft);
        if (draft.invalidAttempts >= 2) {
          await ReservationService.deleteDraft(conversationId);
          await this.sendWhatsAppMessage(
            businessId,
            jid,
            templates.tooManyInvalidAttempts()
          );
          return false;
        }

        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.hoursRejectedNoMoreSlots(hoursCheck.reason)
        );
        return true;
      }
    }

    const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    // ----- EDIT MODE: update the existing reservation's schedule -----
    // (skipped when returnToSummary is set — that's a not-yet-created draft
    // being edited from the pre-confirmation summary, handled below.)
    if (draft.editMode && draft.existingReservationId && !draft.returnToSummary) {
      const ok = await SupabaseService.updateReservationSchedule(draft.existingReservationId, scheduledAt);
      await ReservationService.deleteDraft(conversationId);
      const label = describeScheduledDateTime(scheduledDate, hour, minute, nowInBuenosAires());
      await this.sendWhatsAppMessage(
        businessId,
        jid,
        ok ? templates.scheduleUpdated(label) : templates.cancelFailed()
      );
      return false;
    }

    // ----- NORMAL MODE: store the slot, then show the M1 summary -----
    await ReservationService.setScheduledTime(conversationId, timeLabel, scheduledAt);
    await this.showReservationSummary(conversationId, businessId, jid);
    return false;
  }

  /**
   * M1 "Resumen y confirmación": show the collected data and ask the customer
   * to confirm (1) or modify (2) before the reservation is actually created.
   */
  private async showReservationSummary(
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<void> {
    const draft = await ReservationService.moveToConfirmSummary(conversationId);
    if (!draft) {
      logger.warn('Cannot show summary — draft missing', { conversationId });
      return;
    }

    const whenLabel = draft.scheduledAt
      ? describeScheduledAtUtc(draft.scheduledAt, nowInBuenosAires())
      : templates.instantTurnLabel();

    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.reservationSummary(
        draft.customerName || 'Cliente',
        draft.partySize || 0,
        whenLabel,
        this.buildFullName(draft.customerName, draft.customerLastName) || draft.customerName || 'Cliente',
        draft.eventTitle ?? null
      )
    );
  }

  /**
   * Ask the customer whether the reservation is for the current turn or for a
   * specific day/time within the next 7 days, advancing the draft to `schedule_choice`.
   *
   * Checks today's real availability FIRST — not just whether today's weekday
   * is marked closed, but whether there is any bookable moment left today
   * (accounting for the current instant, shift gaps, and blocked dates). If
   * there is none, the "1) Hoy" option is never shown at all: the customer
   * gets the closed notice up front, right after giving the party size, with
   * the next open days/hours attached — instead of picking "Hoy" and being
   * told afterward that it's closed.
   */
  private async promptScheduleChoice(
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<void> {
    const nowBA = nowInBuenosAires();
    const business = await SupabaseService.getBusinessById(businessId);
    const weeklyHours = business?.weekly_hours as WeeklyHours | null | undefined;

    if (weeklyHours && Object.keys(weeklyHours).length > 0) {
      const blockedDates = await SupabaseService.getBlockedDates(businessId);
      const todayKey = formatBaDateKey(nowBA);
      const openingMargin = business?.reservation_opening_margin_minutes ?? 15;
      const closingMargin = business?.reservation_closing_margin_minutes ?? 15;

      const todayBlocked = isDateBlocked(todayKey, blockedDates);
      const nowCheck = !todayBlocked
        ? checkBusinessHours(nowBA, nowBA.getUTCHours(), nowBA.getUTCMinutes(), weeklyHours, closingMargin, openingMargin)
        : { allowed: false };

      let todayHasAvailability = nowCheck.allowed;
      if (!todayHasAvailability && !todayBlocked) {
        // Not open right this instant — but there may still be a later shift
        // today (e.g. before opening, or a gap between lunch and dinner).
        const nextSlot = findNextOpenSlot(nowBA, weeklyHours, openingMargin, closingMargin);
        todayHasAvailability = !!nextSlot?.isToday;
      }

      if (!todayHasAvailability) {
        // Sin disponibilidad hoy, pero con eventos publicados, saltar el menú
        // escondería el evento en este turno. Se muestra igual, sin la opción
        // "Hoy": queda "1) Otra fecha" y los eventos a continuación.
        const events = await SupabaseService.getActiveEvents(businessId);
        if (events.length > 0) {
          await this.sendScheduleChoiceMenu(conversationId, businessId, jid, events, false);
          return;
        }

        await ReservationService.moveToDateStep(conversationId);
        const dayLines = getUpcomingOpenDaysWithHours(
          weeklyHours,
          nowBA,
          (dateKey) => isDateBlocked(dateKey, blockedDates),
          openingMargin,
          closingMargin,
          7
        );
        await this.sendWhatsAppMessage(businessId, jid, templates.askDayClosedTodayWithSchedule(dayLines));
        return;
      }
    }

    const events = await SupabaseService.getActiveEvents(businessId);
    await this.sendScheduleChoiceMenu(conversationId, businessId, jid, events, true);
  }

  /**
   * Manda el menú de `schedule_choice` y deja anotado en el borrador qué
   * opciones vio el cliente, para poder mapear el número que responda.
   *
   * El menú es dinámico en dos ejes — si hay o no opción "Hoy", y cuántos
   * eventos hay — así que la numeración no se puede dar por sentada en el
   * handler: sin este snapshot, un "3" podría significar cosas distintas
   * según lo que se hubiera mostrado.
   */
  private async sendScheduleChoiceMenu(
    conversationId: string,
    businessId: string,
    jid: string,
    events: BusinessEvent[],
    includeToday: boolean
  ): Promise<void> {
    const draft = await ReservationService.moveToScheduleChoice(conversationId);
    if (draft) {
      draft.scheduleChoiceOptions = {
        includeToday,
        events: events.map(({ id, title }) => ({ id, title })),
      };
      await ReservationService.saveDraft(draft);
    }

    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.askScheduleChoice(events.map((event) => event.title), includeToday)
    );
  }

  /**
   * Reconstruye el menú de `schedule_choice` para volver a mostrarlo (re-ask,
   * respuesta inválida, vuelta desde el menú de edición). Refresca los eventos
   * y reescribe el snapshot: entre un turno y otro el comercio pudo publicar o
   * pausar uno, y el borrador tiene que reflejar lo que el cliente ve ahora.
   */
  private async buildScheduleChoiceMessage(
    conversationId: string,
    businessId: string,
    draft?: ReservationDraft | null
  ): Promise<string> {
    const events = await SupabaseService.getActiveEvents(businessId);
    // Se conserva si la opción "Hoy" estaba o no en el menú original: si se
    // ocultó porque hoy ya no había disponibilidad, sigue sin corresponder.
    const includeToday = draft?.scheduleChoiceOptions?.includeToday ?? true;

    const target = draft ?? (await ReservationService.getDraft(conversationId));
    if (target) {
      target.scheduleChoiceOptions = {
        includeToday,
        events: events.map(({ id, title }) => ({ id, title })),
      };
      await ReservationService.saveDraft(target);
    }

    return templates.askScheduleChoice(events.map((event) => event.title), includeToday);
  }

  /**
   * Cuántas opciones tiene el menú tal como lo vio el cliente. Se usa para
   * redactar el mensaje de opción inválida con el rango correcto.
   */
  private scheduleChoiceOptionCount(draft: ReservationDraft): number {
    const options = draft.scheduleChoiceOptions;
    if (!options) return 2;
    return (options.includeToday ? 2 : 1) + options.events.length;
  }

  /**
   * Traduce la respuesta del cliente en el paso `schedule_choice` al evento que
   * eligió, si eligió uno. Acepta el número de la opción o el título escrito.
   */
  private matchScheduleChoiceEvent(
    draft: ReservationDraft,
    messageText: string,
    events: BusinessEvent[]
  ): BusinessEvent | null {
    const options = draft.scheduleChoiceOptions;
    if (!options || options.events.length === 0) return null;

    // Los eventos empiezan después de "Hoy" (si está) y de "Otra fecha".
    const firstEventOption = options.includeToday ? 3 : 2;
    const trimmed = messageText.trim();

    if (/^\d+$/.test(trimmed)) {
      const eventIndex = Number(trimmed) - firstEventOption;
      const chosen = options.events[eventIndex];
      return chosen ? events.find((event) => event.id === chosen.id) ?? null : null;
    }

    // El cliente puede escribir el título en vez del número.
    const normalized = normalizeReservationScopeText(messageText);
    if (normalized.length < 3) return null;

    return (
      events.find((event) => {
        const title = normalizeReservationScopeText(event.title);
        return title.length >= 3 && (title === normalized || normalized.includes(title));
      }) ?? null
    );
  }

  /**
   * El cliente eligió un evento: manda las fotos, después la presentación, y
   * salta directo al resumen. La fecha y el horario los fija el evento, así
   * que no hay nada más que preguntar (la cantidad de personas ya se pidió
   * antes de este paso).
   */
  private async applyEventChoice(
    draft: ReservationDraft,
    event: BusinessEvent,
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<void> {
    // Secuencial a propósito: Baileys serializa los envíos y en paralelo las
    // fotos llegan desordenadas.
    for (const [index, imageUrl] of event.imageUrls.slice(0, 3).entries()) {
      await this.sendWhatsAppImage(
        businessId,
        jid,
        imageUrl,
        index === 0 ? `🎉 ${event.title}` : undefined
      );
    }

    const parts = utcIsoToBaParts(event.startsAt);
    draft.eventId = event.id;
    draft.eventTitle = event.title;
    draft.scheduledAt = event.startsAt;
    draft.scheduledDate = parts.dateKey;
    draft.scheduledTime = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    draft.invalidAttempts = 0;
    await ReservationService.saveDraft(draft);

    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.eventSelected(
        event.title,
        event.description,
        describeScheduledAtUtc(event.startsAt, nowInBuenosAires())
      )
    );

    await this.showReservationSummary(conversationId, businessId, jid);
  }

  /**
   * Create reservation and notify both WhatsApp and frontend
   */
  private async createAndNotifyReservation(
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<void> {
    try {
      // Extract normalized phone number for database storage
      const phone = this.normalizeWhatsAppNumber(jid);

      logger.debug('Attempting to create reservation in Supabase', {
        conversationId,
        businessId,
        jid,
        phone,
      });

      // Get draft data BEFORE creating reservation (to build confirmation message)
      const draft = await ReservationService.getDraft(conversationId);

      const result = await ReservationService.createReservation(conversationId, phone);

      logger.debug('Reservation creation result', {
        conversationId,
        success: result.success,
        hasWaitlistEntry: !!result.waitlistEntry,
        error: result.error,
      });

      if (result.success && result.waitlistEntry && draft) {
        // -- Duplicate: customer already has an active reservation --
        if (result.alreadyExists) {
          const entry = result.waitlistEntry;
          logger.debug('Reservation already exists, showing summary', {
            conversationId,
            entryId: entry.id,
            displayCode: entry.display_code,
          });
          await ReservationService.deleteDraft(conversationId);
          const summaryMsg =
            `⚠️ Ya tenés una reserva para ${this.describeReservationWhen(entry.scheduled_at)}:\n\n` +
            `👥 Personas: *${entry.party_size}*\n` +
            `📋 Código: *${entry.display_code}*\n\n` +
            `Si querés modificarla, respondé *hola* para ver las opciones.`;
          await this.sendWhatsAppMessage(businessId, jid, summaryMsg);
          await agentService.recordAssistantMessage(conversationId, summaryMsg);
          return;
        }

        logEvent('info', 'reservation.created', {
          entryId: result.waitlistEntry.id,
          status: result.waitlistEntry.status,
          displayCode: result.waitlistEntry.display_code,
          source: 'ai_chat',
        });

        // Build and send confirmation message to customer via WhatsApp
        const entry = result.waitlistEntry;

        logger.debug('Building confirmation message', {
          businessId,
          status: entry.status,
          displayCode: entry.display_code,
        });

        let confirmationMessage: string;
        const whenLabel = entry.scheduled_at
          ? this.describeReservationWhen(entry.scheduled_at)
          : templates.instantTurnLabel();
        const customerLabel = draft.customerName || 'Cliente';
        const fullNameLabel = this.buildFullName(draft.customerName, draft.customerLastName) || customerLabel;
        const partySizeLabel = draft.partySize || entry.party_size;

        if (entry.status === 'CONFIRMED' || entry.status === 'NOTIFIED') {
          confirmationMessage = templates.reservationConfirmed(
            customerLabel,
            partySizeLabel,
            whenLabel,
            entry.display_code,
            fullNameLabel
          );
        } else {
          // WAITING — el operador debe confirmar manualmente
          confirmationMessage = templates.reservationReceived(
            customerLabel,
            partySizeLabel,
            whenLabel,
            entry.display_code,
            fullNameLabel
          );
        }

        logger.debug('Sending confirmation message to customer', {
          businessId,
          jid,
          phone,
          status: entry.status,
          displayCode: entry.display_code,
          messagePreview: confirmationMessage.substring(0, 100),
        });

        await this.sendWhatsAppMessage(businessId, jid, confirmationMessage);
        await agentService.recordAssistantMessage(conversationId, confirmationMessage);

        // Mark dedup keys after sending:
        // - For CONFIRMED/NOTIFIED: short-lived key to prevent realtime duplicate.
        // - For WAITING: mark as "creation notification sent" so realtime fallback skips it.
        if (entry.status === 'CONFIRMED' || entry.status === 'NOTIFIED') {
          await markNotified(statusNotificationKey(entry.id, entry.status), ECHO_TTL_SECONDS);
        }
        // Always mark initial creation notification so realtime subscriber doesn't duplicate it
        await markNotified(createdNotificationKey(entry.id));

        logger.debug('Confirmation message sent successfully to customer', {
          conversationId,
          jid,
          phone,
          entryId: entry.id,
          displayCode: entry.display_code,
        });

        // Store reservation notification in Redis
        try {
          const redis = await import('../config/redis.js');
          const client = redis.RedisConfig.getClient();
          const notificationKey = `notifications:${businessId}:reservation`;

          const notification = {
            type: 'reservation_created',
            waitlistEntry: result.waitlistEntry,
            message: 'Nueva reserva creada desde WhatsApp',
            timestamp: new Date().toISOString(),
          };

          await client.lPush(notificationKey, JSON.stringify(notification));
          await client.lTrim(notificationKey, 0, 99); // Keep last 100 notifications
          await client.expire(notificationKey, 7 * 24 * 60 * 60); // 7 days expiration

          logger.debug('Reservation notification stored in Redis', { businessId });
        } catch (error) {
          logger.error('Failed to store reservation notification', { businessId, error });
        }
      } else {
        // Failed to create reservation - send error message to user
        logger.error('Failed to create reservation', { conversationId, error: result.error });

        const errorMessage =
          result.blockedMessage ??
          '❌ Lo siento, hubo un problema al crear tu reserva. Por favor intenta de nuevo o contacta con el local.';
        await this.sendWhatsAppMessage(businessId, jid, errorMessage);
      }
    } catch (error) {
      logger.error('Error creating and notifying reservation', { error, conversationId });
    }
  }

  /**
   * Returns the best available client-facing message for a blocked date.
   * Uses the pre-stored `reasonMessage` when present; otherwise generates one
   * via the LLM from the raw `reason` and caches it in the DB so future calls
   * are instant. Returns null when neither field is available (generic template
   * fallback is handled by `templates.dateBlocked`).
   */
  private async resolveBlockedDateMessage(
    businessId: string,
    dateKey: string,
    blockedDates: ReadonlyMap<string, BlockedDateEntry>
  ): Promise<string | null> {
    const entry = blockedDates.get(dateKey);
    if (!entry) return null;

    if (entry.reasonMessage) return entry.reasonMessage;

    if (!entry.reason) return null;

    // reason is set but reason_message was never generated (e.g. date created
    // directly in the DB without going through the API). Generate it now and
    // cache it so the next customer gets the fast path.
    try {
      const business = await SupabaseService.getBusinessById(businessId);
      const generated = await openRouterService.generateBlockedDateReasonMessage(
        entry.reason,
        business?.name,
        business?.type
      );
      await SupabaseService.updateBlockedDateReasonMessage(businessId, dateKey, generated);
      logger.debug('Blocked date reason_message generated on-the-fly', { businessId, dateKey });
      return generated;
    } catch (error) {
      logger.warn('Failed to generate blocked date reason_message on-the-fly', {
        error,
        businessId,
        dateKey,
      });
      return null;
    }
  }

  /**
   * Send message via WhatsApp
   */
  private async sendWhatsAppMessage(
    businessId: string,
    to: string,
    message: string
  ): Promise<void> {
    try {
      const dedupKey = `${businessId}:${to}`;
      const lastSent = this.lastSentByChat.get(dedupKey);
      if (
        lastSent &&
        lastSent.text === message &&
        Date.now() - lastSent.timestamp < DUPLICATE_OUTBOUND_WINDOW_MS
      ) {
        logger.debug('Suppressing duplicate outbound message', {
          businessId,
          to,
          windowMs: DUPLICATE_OUTBOUND_WINDOW_MS,
        });
        return;
      }

      const success = await this.baileysService.sendMessage(businessId, to, message);

      if (!success) {
        // `BaileysService.sendMessage` ya emitió `msg.out_failed` con la causa
        // tipificada; duplicarlo acá sólo agregaría ruido sin información.
        return;
      }

      recordOutbound();
      this.lastSentByChat.set(dedupKey, {
        text: message,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Error sending WhatsApp message', { error, businessId, to });
    }
  }

  /**
   * Envía una imagen por WhatsApp. Hermano de sendWhatsAppMessage, pero sin
   * pasar por el dedupe de salientes: ese guard compara el texto del mensaje,
   * y dos fotos distintas del mismo evento tienen el mismo caption (o ninguno),
   * así que las descartaría por duplicadas.
   */
  private async sendWhatsAppImage(
    businessId: string,
    to: string,
    imageUrl: string,
    caption?: string
  ): Promise<void> {
    try {
      const success = await this.baileysService.sendImageMessage(businessId, to, imageUrl, caption);
      if (!success) {
        // BaileysService ya emitió msg.out_failed con la causa tipificada.
        return;
      }
      recordOutbound();
    } catch (error) {
      logger.error('Error sending WhatsApp image', { error, businessId, to, imageUrl });
    }
  }

  private async shouldSendInactiveFallback(businessId: string, phone: string): Promise<boolean> {
    try {
      if (!RedisConfig.isReady()) {
        logger.debug('Redis not ready, skipping inactive fallback send to avoid false positives', {
          businessId,
          phone,
        });
        return false;
      }

      const client = RedisConfig.getClient();
      const key = `wa:fallback:inactive:${businessId}:${phone}`;
      const wasSet = await client.set(key, '1', {
        NX: true,
        EX: INACTIVE_FALLBACK_TTL_SECONDS,
      });

      return !!wasSet;
    } catch (error) {
      logger.error('Error applying inactive fallback throttle, skipping fallback send', {
        businessId,
        phone,
        error,
      });
      return false;
    }
  }

  private shouldIgnoreMessage(
    from: string,
    _messageText: string,
    fromMe: boolean | undefined,
    businessId: string
  ): boolean {
    const isTestEnv = process.env.NODE_ENV === 'test';

    if (isTestEnv) {
      // In test we allow self-chat messages, but outbound bot echoes are filtered in BaileysService.
      logger.debug('TEST MODE: processing inbound message', { businessId, from, fromMe });
      return false;
    } else {
      // En producción: ignorar todos los mensajes fromMe (respuestas del bot)
      if (fromMe) {
        logger.debug('Ignoring own message in production mode', { businessId, from });
        return true;
      }
      return false;
    }
  }

  private sanitizeAgentResponse(response: string, draft: ReservationDraft | null): string {
    const trimmedResponse = response.trim();
    let sanitized = trimmedResponse;
    for (const fallbackMessage of INACTIVE_FALLBACK_MESSAGES) {
      const fallbackEscaped = fallbackMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(fallbackEscaped, 'gi'), '').trim();
    }

    const hasUnresolvedPlaceholders = /\{(?:name|qty)\}|\[(?:NOMBRE|CANTIDAD)\]/i.test(sanitized);
    if (hasUnresolvedPlaceholders) {
      logger.warn('Agent response contains unresolved placeholders, forcing deterministic fallback', {
        draftStep: draft?.step,
        preview: sanitized.substring(0, 120),
      });

      if (draft?.step === 'party_size') {
        return templates.askPartySizeShort();
      }

      return templates.askNameAgain();
    }

    if (!sanitized) {
      return draft?.step === 'party_size'
        ? templates.askPartySizeShort()
        : templates.askNameAgain();
    }

    return sanitized;
  }

  private normalizeWhatsAppNumber(jid: string): string {
    return normalizePhone(jid);
  }

  private normalizeCourtesyText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[¡!¿?.,;:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async enforceSingleActiveReservationPolicy(
    businessId: string,
    jid: string,
    messageText: string,
    conversationId: string
  ): Promise<boolean> {
    try {
      if (!this.isExplicitNewReservationIntent(messageText)) {
        return false;
      }

      const phone = this.normalizeWhatsAppNumber(jid);
      const activeReservations = await SupabaseService.getActiveReservationsByPhone(phone, businessId);
      const conflictingReservation = activeReservations.find((reservation) =>
        SupabaseService.reservationsOverlap(null, reservation.scheduled_at ?? null)
      );

      if (!conflictingReservation) {
        return false;
      }

      const statusLabel = this.getReservationStatusLabel(conflictingReservation.status);

      const reminderMessage = templates.newReservationOverlapReminder(
        this.describeReservationWhen(conflictingReservation.scheduled_at),
        conflictingReservation.display_code,
        statusLabel
      );

      await this.sendWhatsAppMessage(businessId, jid, reminderMessage);

      logger.debug('Reservation overlap policy applied', {
        conversationId,
        businessId,
        status: conflictingReservation.status,
        displayCode: conflictingReservation.display_code,
      });

      return true;
    } catch (error) {
      logger.error('Error enforcing reservation overlap policy', {
        error,
        conversationId,
        businessId,
      });
      return false;
    }
  }

  private isExplicitNewReservationIntent(text: string): boolean {
    const normalized = this.normalizeCourtesyText(text);

    const explicitPatterns = [
      /^reservar$/,
      /\botra\s+reserva\b/,
      /\bnueva\s+reserva\b/,
      /\bquiero\s+hacer\s+otra\s+reserva\b/,
      /\bquiero\s+reservar\b/,
      /\breservar\s+otra\b/,
      /\bhacer\s+una\s+reserva\b/,
      /\bmesa\s+para\b/,
      /\bquiero\s+una\s+mesa\b/,
      // Inglés
      /^book$/,
      /\banother\s+(booking|reservation)\b/,
      /\bnew\s+(booking|reservation)\b/,
      /\b(want|need|like)\s+to\s+book\b/,
      /\bmake\s+a\s+(booking|reservation)\b/,
      /\btable\s+for\b/,
      // Portugués
      /^reservar$/,
      /\boutra\s+reserva\b/,
      /\bnova\s+reserva\b/,
      /\bquero\s+reservar\b/,
      /\bfazer\s+uma\s+reserva\b/,
      /\bmesa\s+para\b/,
    ];

    return explicitPatterns.some((pattern) => pattern.test(normalized));
  }

  /** "hoy" for instant reservations, or "viernes 17/07 a las 21:00" for scheduled ones. */
  private describeReservationWhen(scheduledAt: string | null | undefined): string {
    if (!scheduledAt) {
      return 'hoy';
    }
    return describeScheduledAtUtc(scheduledAt, nowInBuenosAires());
  }

  private getReservationStatusLabel(status: string): string {
    switch (status) {
      case 'WAITING':
        return 'Pendiente';
      case 'CONFIRMED':
        return 'Confirmada';
      case 'NOTIFIED':
        return 'Notificada';
      case 'SEATED':
        return 'Finalizada';
      case 'CANCELLED':
        return 'Cancelada';
      case 'NO_SHOW':
        return 'No show';
      default:
        return status;
    }
  }

  private isGratitudeMessage(text: string): boolean {
    const normalized = this.normalizeCourtesyText(text);

    if (!normalized) {
      return false;
    }

    const gratitudePatterns = [
      /^(muchas\s+)?gracias(\s+totales)?$/,
      /^gracias\s+por\s+todo$/,
      /^thank(s|\s+you)$/,
      /^mil\s+gracias$/,
      /^genial\s+gracias$/,
      /^ok\s+gracias$/,
      /^dale\s+gracias$/,
      // Inglés
      /^thank\s+you\s+(so\s+)?(very\s+)?much$/,
      /^(many\s+)?thanks(\s+a\s+lot)?$/,
      /^thx$/,
      /^(ok|okay)\s+thank(s|\s+you)$/,
      // Portugués
      /^(muito\s+)?obrigad[oa]$/,
      /^obrigad[oa]\s+por\s+tudo$/,
      /^valeu$/,
      /^(ok|beleza)\s+obrigad[oa]$/,
    ];

    return gratitudePatterns.some((pattern) => pattern.test(normalized));
  }

  private isShortAcknowledgementMessage(text: string): boolean {
    const normalized = this.normalizeCourtesyText(text);

    if (!normalized) {
      return false;
    }

    const acknowledgementPatterns = [
      /^(ok|okay|okey)$/,
      /^okis$/,
      /^dale$/,
      /^genial$/,
      /^perfecto$/,
      /^listo$/,
      /^de\s+una$/,
      /^de\s+diez$/,
      /^(buenisimo|buenisima|buenisimo+)$/,
      /^excelente$/,
      /^joya$/,
      /^barbaro$/,
      // Inglés
      /^(sure|alright|allright)$/,
      /^(great|awesome|cool|nice|excellent)$/,
      /^(got\s+it|understood|sounds\s+good)$/,
      // Portugués
      /^(beleza|blz)$/,
      /^(certo|ta\s+bom|tudo\s+bem)$/,
      /^(otimo|show|massa)$/,
    ];

    return acknowledgementPatterns.some((pattern) => pattern.test(normalized));
  }

  private isPostReservationCourtesyMessage(text: string): boolean {
    return this.isGratitudeMessage(text) || this.isShortAcknowledgementMessage(text);
  }

  /**
   * Returns true when the message clearly expresses intent to cancel a reservation,
   * even without an active draft (e.g. "la quiero cancelar", "cancelar mi reserva").
   * More targeted than isExitKeyword — requires "cancelar" or close synonyms.
   */
  /**
   * Returns true if the text COULD plausibly be a person's name.
   * Rejects phrases that contain verb conjugations or exceed name-length limits.
   * e.g. "Matías" → true | "me puedo tirar un pedo" → false | "Juan Pérez" → true
   */
  private couldBeAName(text: string): boolean {
    const trimmed = text.trim();
    const words = trimmed.split(/\s+/);

    // A digit anywhere rules out a name in any of the supported languages —
    // e.g. "table for 4" / "mesa pra 4" — independent of whether the
    // surrounding reservation phrasing is recognized (those patterns below
    // are Spanish-leaning and don't catch every EN/PT phrasing).
    if (/\d/.test(trimmed)) return false;

    // Names realistically have 1–4 words (including compound names)
    if (words.length > 4) return false;

    // Questions are never names
    if (trimmed.endsWith('?')) return false;

    const lower = this.normalizeCourtesyText(text);

    // Reject common social / filler phrases that aren’t names
    const socialPhrases = [
      'todo bien', 'como estas', 'como te va', 'que tal', 'como andas',
      'como va', 'bien gracias', 'muy bien', 'todo ok', 'todo good',
      'nada nada', 'nada mucho', 'que onda', 'buenas noches', 'buenas tardes',
      'buenos dias', 'buen dia',
    ];
    if (socialPhrases.some(p => lower.includes(p))) return false;

    // Reject leftover date/time references (e.g. "para mañana", "esta noche") that
    // survive stripping of reservation phrasing — these are never a person's name.
    if (hasDateOrTimeSignal(trimmed, normalizeReservationScopeText(trimmed))) return false;

    // Reject if it contains conjugated verbs or pronouns that signal a full sentence
    const sentenceMarkers = [
      'puedo', 'puede', 'podes', 'quiero', 'quiere', 'queres',
      'tengo', 'tiene', 'tenes', 'voy', 'vamos',
      'estoy', 'estas', 'estamos',
      'hago', 'hace', 'haces', 'vivo', 'vive',
      'tirar', 'hacer', 'poder', 'tener', 'decir', 'saber',
    ];

    return !sentenceMarkers.some(marker => lower.includes(marker));
  }

  private isCancellationIntent(text: string): boolean {
    const lower = this.normalizeCourtesyText(text);
    // "cancelar"/"anular" always signal cancellation on their own.
    // "cancelar" es idéntico en ES y PT; "cancel" cubre el inglés.
    if (/\bcancela/.test(lower) || /\banula/.test(lower) || /\bcancel\b/.test(lower)) return true;
    // Inglés: "delete/remove/drop my booking"
    if (/\b(delet|remov|drop)/.test(lower) && /\b(booking|reservation|table)\b/.test(lower)) {
      return true;
    }
    // Portugués: "desmarcar", "desistir"
    if (/\b(desmarc|desist)/.test(lower)) return true;
    // "borrar/eliminar/sacar/quitar" only count when clearly about the
    // reservation — matched as word-boundary stems (covers "sacá"/"saca"/
    // "sacar", "eliminá"/"elimina"/"eliminar", etc.) and without requiring an
    // exact fixed phrase, so filler words in between ("esa", "mi", "la") don't
    // break the match (e.g. "eliminar ESA reserva", not just "eliminar reserva").
    return /\b(borr|elimin|saca|quita)/.test(lower) && /\breserva/.test(lower);
  }

  private isExitKeyword(text: string): boolean {
    const normalized = this.normalizeCourtesyText(text);
    // Match if any exit keyword appears as a whole word anywhere in the message.
    // This handles: "cancelar", "CANCELAR", "quiero cancelar", "me quiero ir",
    // "para salir", "stop ya", "volver al menu", etc.
    const keywords = [
      'cancelar', 'cancela', 'cancel',
      'salir', 'quiero salir', 'me quiero ir',
      'stop', 'detener',
      'inicio', 'menu', 'volver', 'atras', 'restart',
      'no quiero', 'dejalo', 'olvidalo', 'olvidame', 'olvida',
      'no importa', 'no gracias', 'dejame', 'no hacer',
      // Inglés
      'exit', 'quit', 'nevermind', 'never mind', 'forget it', 'go back', 'back',
      'no thanks', 'no thank you',
      // Portugués
      'sair', 'esquece', 'esquece isso', 'deixa', 'deixa pra la', 'voltar',
      'nao quero', 'nao obrigado', 'nao obrigada',
    ];
    return keywords.some(kw => {
      // Word-boundary aware: the keyword must appear as a standalone token
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalized);
    });
  }

  private isGreetingMessage(text: string): boolean {
    // Multilingual by union (ES/EN/PT) — see src/i18n/keywords.ts. A tourist
    // greets in their own language before ever seeing the language menu, so
    // this matcher must recognise "hi" and "oi" as readily as "hola".
    return isMultilingualGreeting(this.normalizeCourtesyText(text));
  }

  private isActiveReservationsInquiryMessage(text: string): boolean {
    const normalized = this.normalizeCourtesyText(text);

    const patterns = [
      /\bmis\s+reservas\b/,
      /\bmis\s+reservas\s+activas\b/,
      /\bcu[aá]les\s+son\s+mis\s+reservas\b/,
      /\bcu[aá]ntas?\s+reservas\b/,
      /\bcu[aá]ntas?\s+reservas\s+activas\b/,
      /\bqu[eé]\s+reservas\s+tengo\b/,
      /\bqu[eé]\s+reservas\s+ten(?:go|es|emos)\b/,
      // "tengo reservas?", "hola tengo reservas?", "tengo reservas activas?"
      /\btengo\s+reservas?\b/,
      // "ver mis reservas", "consultar mis reservas"
      /\bver\s+mis?\s+reservas?\b/,
      /\bconsultar?\s+(?:mis?\s+)?reservas?\b/,
    ];

    return patterns.some((pattern) => pattern.test(normalized));
  }

  /**
   * True when this phone already has history WITH THIS BUSINESS — `customers` is
   * one row per (phone, business_id), so a regular at another local still counts
   * as new here.
   *
   * A bare row isn't enough: `handleCheckStatus`/`handleCancel` used to mint rows
   * whose name was the literal 'Unknown', and rows created before that was fixed
   * are still in production. Those are treated as new, since we know nothing real
   * about the person.
   */
  private async isReturningCustomer(phone: string, businessId: string): Promise<boolean> {
    const customer = await SupabaseService.getCustomerByPhone(phone, businessId);
    const name = customer?.name?.trim();
    return !!name && name.toLowerCase() !== 'unknown';
  }

  private async handleActiveReservationsInquiry(
    businessId: string,
    jid: string,
    conversationId: string
  ): Promise<boolean> {
    try {
      const phone = this.normalizeWhatsAppNumber(jid);
      const activeReservations = await SupabaseService.getActiveReservationsByPhone(phone, businessId);

      if (activeReservations.length === 0) {
        // "No tenés reservas" es el mensaje correcto para un cliente que ya nos
        // conoce, pero a alguien que nunca escribió no le dice quiénes somos ni
        // qué puede hacer. Se bifurca según si el teléfono ya tiene historial
        // CON ESTE NEGOCIO (customers es una fila por (phone, business_id)).
        const isReturning = await this.isReturningCustomer(phone, businessId);

        if (!isReturning) {
          const business = await SupabaseService.getBusinessById(businessId);
          await this.sendWhatsAppMessage(
            businessId,
            jid,
            `${templates.firstContactNoReservations(business?.name || 'el local')}\n\n` +
              templates.languageChangeHint()
          );
          logger.debug('First-contact welcome sent instead of the terse no-reservations reply', {
            conversationId,
            businessId,
          });
          return true;
        }

        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.noActiveReservationsInquiry()
        );
        logger.debug('No active reservations to report', { conversationId });
        return true;
      }

      if (activeReservations.length > 1) {
        const availableReservationIds = activeReservations.map((reservation) => reservation.id);
        await ReservationService.startReservationSelection(conversationId, businessId, availableReservationIds);

        const quickOptions = activeReservations.map((reservation, index) => ({
          index: index + 1,
          partySize: reservation.party_size ?? 0,
          whenLabel: this.describeReservationWhen(reservation.scheduled_at),
          displayCode: reservation.display_code ?? null,
          statusLabel: this.getReservationStatusLabel(reservation.status),
        }));

        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.activeReservationsMenu(quickOptions)
        );

        logger.debug('Active reservations inquiry handled with selection menu', {
          conversationId,
          reservationCount: activeReservations.length,
        });
        return true;
      }

      // A single active reservation: go straight to the action menu (same as
      // a plain greeting does) instead of a read-only listing — the customer
      // should choose what to do (modificar/cancelar), not just see a summary.
      await this.startEditMenuFlow(conversationId, businessId, jid, activeReservations[0]);

      logger.debug('Active reservations inquiry handled — routed straight to edit menu', {
        conversationId,
        reservationCount: activeReservations.length,
      });
      return true;
    } catch (error) {
      logger.error('Error handling active reservations inquiry', { error, conversationId });
      return false;
    }
  }

  /**
   * Handle a greeting: cancel any active draft, check for today's reservation,
   * and either show the reservation menu or a normal welcome response.
   * Returns true if the greeting was handled (message was sent).
   */
  /**
   * Shows the M2 modification menu for an active reservation and stores the
   * edit_menu draft so the next message is intercepted.
   */
  private async startEditMenuFlow(
    conversationId: string,
    businessId: string,
    jid: string,
    activeReservation: {
      id: string;
      party_size: number;
      display_code: string | null;
      scheduled_at?: string | null;
      status: string;
    }
  ): Promise<void> {
    const statusLabel =
      activeReservation.status === 'CONFIRMED' || activeReservation.status === 'NOTIFIED'
        ? '✅ Confirmada'
        : '⏳ Pendiente';

    const phone = this.normalizeWhatsAppNumber(jid);
    const customer = await SupabaseService.getCustomerByPhone(phone, businessId);

    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.editMenu(
        activeReservation.party_size,
        this.describeReservationWhen(activeReservation.scheduled_at),
        activeReservation.display_code ?? '-',
        statusLabel,
        customer?.name?.trim() || null
      )
    );

    await ReservationService.startEditMenu(conversationId, businessId, activeReservation.id, {
      partySize: activeReservation.party_size ?? undefined,
      scheduledAt: activeReservation.scheduled_at ?? null,
    });
  }

  /**
   * Starts the M3 cancellation flow: shows the reservation summary with the
   * reprogramar/cancelar-definitivamente menu and stores the cancel_menu draft.
   */
  private async startCancelFlow(
    conversationId: string,
    businessId: string,
    jid: string,
    activeReservation: {
      id: string;
      party_size: number;
      display_code: string | null;
      scheduled_at?: string | null;
    }
  ): Promise<void> {
    // Direct CANCELAR intent skips the reprogramar/cancelar-definitivamente
    // menu and goes straight to a single Sí/Volver-atrás confirmation.
    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.cancelDirectConfirmPrompt(
        activeReservation.party_size,
        this.describeReservationWhen(activeReservation.scheduled_at),
        activeReservation.display_code ?? '-'
      )
    );

    await ReservationService.startCancelConfirm(conversationId, businessId, activeReservation.id, {
      partySize: activeReservation.party_size ?? undefined,
      scheduledAt: activeReservation.scheduled_at ?? null,
    });

    logger.debug('Cancel confirm shown directly (M3, menu skipped)', {
      conversationId,
      reservationId: activeReservation.id,
    });
  }

  /**
   * Starts a brand-new reservation flow, skipping the name/apellido steps
   * when the phone number is already registered in `customers` for this
   * business (CAMBIO 1). The customer's identity is resolved fresh from the
   * DB on every call — by phone + businessId, both always available on the
   * incoming message — rather than cached on the (short-lived, 1h TTL)
   * reservation draft, so it survives draft deletion/expiry.
   */
  private async startNewReservationFlow(
    conversationId: string,
    businessId: string,
    jid: string,
    phone: string,
    unknownCustomerMessage: string
  ): Promise<void> {
    const knownCustomer = await SupabaseService.getCustomerByPhone(phone, businessId);
    // A stored preference means the customer already picked a language once —
    // don't re-ask, just greet in it and mention how to switch.
    const hasChosenLanguage = !!knownCustomer?.preferred_language;

    if (knownCustomer?.name) {
      await ReservationService.startReservationForKnownCustomer(
        conversationId,
        businessId,
        knownCustomer.name,
        knownCustomer.lastName
      );
      // The change-hint always shows for known customers, even ones without an
      // explicit preferred_language (e.g. existing customers from before this
      // feature shipped) — they're already replying in an auto-detected
      // language this turn (see resolveConversationLanguage), so they still
      // need to know how to switch it if it's wrong.
      const greeting = `${templates.welcomeBackAskPartySize(knownCustomer.name)}\n\n${templates.languageChangeHint()}`;
      await this.sendWhatsAppMessage(businessId, jid, greeting);
      logger.debug('Reservation flow started for known customer — name step skipped', {
        conversationId,
        businessId,
        hasChosenLanguage,
      });
      return;
    }

    // First contact: offer the language menu instead of jumping straight to the
    // name question. Non-blocking — the draft still moves to `name`, so if the
    // customer ignores the menu and answers with their name, the flow continues.
    if (!hasChosenLanguage) {
      const business = await SupabaseService.getBusinessById(businessId);
      await ReservationService.startReservation(conversationId, businessId, true);
      await this.sendWhatsAppMessage(
        businessId,
        jid,
        templates.languageWelcomeMenu(business?.name || 'el local')
      );
      logger.debug('Language menu sent on first contact', { conversationId, businessId });
      return;
    }

    await ReservationService.startReservation(conversationId, businessId);
    await this.sendWhatsAppMessage(businessId, jid, unknownCustomerMessage);
  }

  /**
   * Routes a direct edit/cancel intent to the right flow, disambiguating when
   * the customer has more than one active reservation: 0 → optional "no tenés
   * reserva"; 1 → straight to the edit/cancel menu; >1 → the selection menu,
   * remembering the requested action so the picked reservation goes to the
   * matching flow (see the `reservation_selection` step). Returns true when it
   * sent a message; false only when there were no active reservations and
   * `notifyIfNone` was false, so the caller can fall through.
   */
  private async routeToReservationAction(
    action: 'edit' | 'cancel',
    businessId: string,
    jid: string,
    conversationId: string,
    notifyIfNone: boolean = true
  ): Promise<boolean> {
    const phone = this.normalizeWhatsAppNumber(jid);
    const activeReservations = await SupabaseService.getActiveReservationsByPhone(phone, businessId);

    if (activeReservations.length === 0) {
      if (notifyIfNone) {
        await this.sendWhatsAppMessage(businessId, jid, templates.noActiveReservation());
        return true;
      }
      return false;
    }

    if (activeReservations.length === 1) {
      if (action === 'cancel') {
        await this.startCancelFlow(conversationId, businessId, jid, activeReservations[0]);
      } else {
        await this.startEditMenuFlow(conversationId, businessId, jid, activeReservations[0]);
      }
      return true;
    }

    // Multiple active reservations — ask which one, remembering the action.
    const availableReservationIds = activeReservations.map((reservation) => reservation.id);
    await ReservationService.startReservationSelection(
      conversationId,
      businessId,
      availableReservationIds,
      action
    );

    const quickOptions = activeReservations.map((reservation, index) => ({
      index: index + 1,
      partySize: reservation.party_size ?? 0,
      whenLabel: this.describeReservationWhen(reservation.scheduled_at),
      displayCode: reservation.display_code ?? null,
      statusLabel: this.getReservationStatusLabel(reservation.status),
    }));

    await this.sendWhatsAppMessage(
      businessId,
      jid,
      templates.activeReservationsMenu(quickOptions, action)
    );

    logger.debug('Reservation selection menu shown for direct action', {
      conversationId,
      action,
      reservationCount: activeReservations.length,
    });
    return true;
  }

  /**
   * Cheap pre-filter (no LLM) for messages that plausibly pack MORE THAN ONE
   * distinct action, so the planner is only invoked for genuine compounds and
   * ordinary single-intent messages stay on the deterministic path. Requires a
   * conjunction plus at least two distinct action families.
   */
  private isPotentialMultiActionMessage(text: string): boolean {
    const n = this.normalizeCourtesyText(text);
    const hasConnector = /\b(y|e|luego|despues|tambien|ademas|aparte|mas tarde)\b/.test(n);
    if (!hasConnector) return false;

    let families = 0;
    if (/\b(cancel|anul|dar de baja|no voy)\b/.test(n)) families += 1;
    if (/\b(reserv|crea|crear|nueva|otra mesa|mesa para|una mesa|anota|apunta)\b/.test(n)) families += 1;
    if (/\b(modific|cambi|reprogram|edit|mov[ée]|corr[ée])\b/.test(n)) families += 1;
    if (/\b(mis reservas|cuales|que reservas|estado de)\b/.test(n)) families += 1;

    return families >= 2;
  }

  /**
   * Executes every action found in a compound message. Non-terminal actions
   * (cancel, query) run first and in order; the terminal one (a new reservation,
   * or a modify) runs last since it may need further turns. Returns true when it
   * handled the message; false to fall back to single-intent handling.
   */
  private async handleMultiActionMessage(
    businessId: string,
    from: string,
    messageText: string,
    conversationId: string,
    businessName?: string
  ): Promise<boolean> {
    try {
      const history = await agentService.getConversationHistory(conversationId);
      const actions = await planReservationActions(messageText, businessName, history);
      if (!actions || countActionableIntents(actions) < 2) {
        return false;
      }

      const phone = this.normalizeWhatsAppNumber(from);
      let activeReservations = await SupabaseService.getActiveReservationsByPhone(phone, businessId);
      const summaryLines: string[] = [];

      // --- Non-terminal actions: cancels and queries, in the requested order ---
      for (const action of actions) {
        if (action.intent === 'cancel') {
          const target = this.matchTargetReservation(action, activeReservations);
          if (!target) {
            summaryLines.push(templates.cancelTargetNotFound(activeReservations.length > 0));
            continue;
          }
          const ok = await this.cancelReservationForCustomer(target.id);
          if (ok) {
            summaryLines.push(
              templates.reservationCancelledInline(
                this.describeReservationWhen(target.scheduled_at),
                target.display_code
              )
            );
            activeReservations = activeReservations.filter((r) => r.id !== target.id);
          } else {
            summaryLines.push(templates.cancelActionFailed());
          }
        } else if (action.intent === 'query') {
          summaryLines.push(
            activeReservations.length === 0
              ? templates.noActiveReservationsShort()
              : this.describeActiveReservationsInline(activeReservations)
          );
        }
      }

      const createAction = actions.find((a) => a.intent === 'create');
      const modifyAction = actions.find((a) => a.intent === 'modify');

      // --- Terminal action (interactive): a new reservation, or a modify ---
      if (createAction || modifyAction) {
        if (summaryLines.length > 0) {
          await this.sendWhatsAppMessage(businessId, from, summaryLines.join('\n'));
        }

        if (createAction) {
          await this.startPlannedCreate(conversationId, businessId, from, phone, createAction, messageText);
          return true;
        }

        const target = this.matchTargetReservation(modifyAction!, activeReservations);
        if (target) {
          await this.startEditMenuFlow(conversationId, businessId, from, target);
        } else {
          await this.routeToReservationAction('edit', businessId, from, conversationId);
        }
        return true;
      }

      if (summaryLines.length > 0) {
        await this.sendWhatsAppMessage(businessId, from, summaryLines.join('\n'));
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error handling multi-action message', { error, conversationId, businessId });
      return false;
    }
  }

  /**
   * Picks which active reservation a cancel/modify action refers to: the only
   * one when there's a single active reservation; otherwise the one whose day
   * matches the referenced text ("la del viernes"). Returns null when it stays
   * ambiguous so the caller can ask.
   */
  private matchTargetReservation(
    action: PlannedAction,
    reservations: WaitlistEntry[]
  ): WaitlistEntry | null {
    if (reservations.length === 0) return null;
    if (reservations.length === 1) return reservations[0];

    const refText = [action.targetReservationText, action.dateText].filter(Boolean).join(' ');
    if (!refText) return null;

    const nowBA = nowInBuenosAires();
    const parsed = parseRelativeDay(refText, nowBA);
    if (parsed) {
      const key = formatBaDateKey(parsed.baDate);
      const matches = reservations.filter(
        (r) => r.scheduled_at && utcIsoToBaParts(r.scheduled_at).dateKey === key
      );
      if (matches.length === 1) return matches[0];
    }

    if (/\b(hoy|turno actual|ahora)\b/.test(this.normalizeCourtesyText(refText))) {
      const instant = reservations.filter((r) => !r.scheduled_at);
      if (instant.length === 1) return instant[0];
    }

    return null;
  }

  /** One-message summary of a customer's active reservations (for the query action). */
  private describeActiveReservationsInline(reservations: WaitlistEntry[]): string {
    const lines = reservations.map(
      (r, i) =>
        `${i + 1}. ${r.party_size} personas, ${this.describeReservationWhen(r.scheduled_at)}` +
        `${r.display_code ? ` (${r.display_code})` : ''} — ${this.getReservationStatusLabel(r.status)}`
    );
    return ['📋 Tus reservas activas:', ...lines].join('\n');
  }

  /**
   * Starts a new-reservation flow from a planned `create` action, pre-filling
   * whatever slots the planner extracted (name, party size, day, time). Resolves
   * the name from the message or the stored customer; when everything is present
   * the reservation is finalized, otherwise the normal flow prompts for the rest.
   */
  private async startPlannedCreate(
    conversationId: string,
    businessId: string,
    jid: string,
    phone: string,
    action: PlannedAction,
    originalMessage: string
  ): Promise<void> {
    await ReservationService.startReservation(conversationId, businessId);

    let fullName = action.customerName?.trim() || '';
    if (!fullName) {
      const customer = await SupabaseService.getCustomerByPhone(phone, businessId);
      if (customer?.name) {
        fullName = this.buildFullName(customer.name, customer.lastName) || customer.name;
      }
    }

    const partySize = action.partySizeText ? this.extractPartySize(action.partySizeText) : null;
    const scheduleText = [action.dateText, action.timeText].filter(Boolean).join(' ').trim();

    if (!fullName) {
      // No name yet — stash the party size and let the normal flow ask name/apellido.
      if (partySize && partySize > 0 && partySize <= 50) {
        await ReservationService.setPartySize(conversationId, partySize);
      }
      await this.sendWhatsAppMessage(businessId, jid, templates.askName());
      return;
    }

    // Treat the resolved name as complete (don't re-ask apellido mid-compound).
    const { firstName, lastName } = this.splitFullName(fullName);
    await ReservationService.setCustomerNameParts(conversationId, firstName, lastName);

    if (!(partySize && partySize > 0 && partySize <= 50)) {
      await this.sendWhatsAppMessage(businessId, jid, templates.askPartySize(firstName));
      return;
    }
    await ReservationService.setPartySize(conversationId, partySize);

    // Resolve day/time from the extracted schedule text (falls back to the full
    // message), finalizing when complete or prompting for whatever's missing.
    await this.resolveEmbeddedScheduleOrPromptChoice(
      conversationId,
      businessId,
      jid,
      scheduleText || originalMessage
    );
  }

  private isModificationIntent(text: string): boolean {
    const normalized = this.normalizeCourtesyText(text);

    const patterns = [
      /\bmodificar\b/,
      /\bmodificarla\b/,
      /\bcambiar\s+(mi\s+)?reserva\b/,
      /\bcambiarla\b/,
      /\beditar\s+(mi\s+)?reserva\b/,
      // Inglés
      /\b(change|modify|edit|update)\s+(my\s+)?(booking|reservation)\b/,
      /\breschedule\b/,
      // Portugués
      /\b(alterar|mudar|modificar|editar)\s+(minha\s+)?reserva\b/,
      /\bremarcar\b/,
    ];

    return patterns.some((pattern) => pattern.test(normalized));
  }

  /**
   * Detects a natural-language request to change the stored name/apellido, e.g.
   * "cambiá mi nombre a Juan", "mi apellido es Gómez", "corregí mi nombre".
   * Only meaningful when there is no active reservation draft (the name/last_name
   * steps handle in-flow corrections themselves).
   */
  private isNameChangeIntent(text: string): boolean {
    const n = this.normalizeCourtesyText(text);
    return (
      /\b(cambia|cambiar|cambiame|corregi|corregir|corrige|actualiza|actualizar|edita|editar)\s+(mi\s+|el\s+)?(nombre|apellido)\b/.test(n) ||
      /\b(mi\s+)(nombre|apellido)\s+(es|seria|real\s+es|correcto\s+es|va\s+a\s+ser)\b/.test(n) ||
      /\b(pone[rm]e?|anota[rm]e?)\s+(el\s+|como\s+)?(nombre|apellido)\b/.test(n)
    );
  }

  /**
   * Splits a name-change request into the target field and (optionally) the new
   * value. `field` is `'lastName'` when the message mentions only "apellido",
   * else `'full'` (updates first name + apellido). `value` is null when the
   * customer named the intent but not the new value ("quiero cambiar mi nombre").
   */
  private extractNameChangeRequest(text: string): { field: 'full' | 'lastName'; value: string | null } {
    const n = this.normalizeCourtesyText(text);
    const field: 'full' | 'lastName' =
      /\bapellido\b/.test(n) && !/\bnombre\b/.test(n) ? 'lastName' : 'full';

    // Capture whatever follows the connector ("a", "por", "es", "sea", ":").
    const match = text.match(/(?:\ba\b|\bpor\b|\bes\b|\bsea\b|:)\s+(.+)$/i);
    const value = match?.[1] ? this.extractNameCandidate(match[1]) : null;
    return { field, value };
  }

  /** Applies a name/apellido change to the customer record by phone. */
  private async applyCustomerNameChange(
    phone: string,
    businessId: string,
    field: 'full' | 'lastName',
    value: string
  ): Promise<Customer | null> {
    if (field === 'lastName') {
      return SupabaseService.updateCustomerNameByPhone(phone, businessId, { lastName: value });
    }
    const { firstName, lastName } = this.splitFullName(value);
    return SupabaseService.updateCustomerNameByPhone(phone, businessId, {
      name: firstName,
      // Only overwrite the apellido when the customer actually provided one.
      ...(lastName ? { lastName } : {}),
    });
  }

  /**
   * Handles a natural-language name-change request. When the new value is
   * present it's applied immediately; otherwise a short `edit_customer_name`
   * draft is started to capture the follow-up reply.
   */
  private async handleNameChangeIntent(
    businessId: string,
    jid: string,
    messageText: string,
    conversationId: string
  ): Promise<boolean> {
    try {
      const phone = this.normalizeWhatsAppNumber(jid);
      const { field, value } = this.extractNameChangeRequest(messageText);

      if (!value) {
        await ReservationService.startCustomerNameEdit(conversationId, businessId, field);
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.askCorrectNameField(field)
        );
        return true;
      }

      const updated = await this.applyCustomerNameChange(phone, businessId, field, value);
      if (!updated) {
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.noStoredCustomerData()
        );
        return true;
      }

      const fullName = this.buildFullName(updated.name, updated.lastName) || updated.name;
      await this.sendWhatsAppMessage(
        businessId,
        jid,
        templates.customerNameUpdated(fullName)
      );
      return true;
    } catch (error) {
      logger.error('Error handling name change intent', { error, conversationId, businessId });
      return false;
    }
  }

  /**
   * Handles an explicit language-change request at any point of the flow.
   *
   * Returns true when it handled the message (caller must return immediately).
   * The draft is left untouched on purpose: switching language must not lose
   * the party size, date or time already collected — so instead of restarting,
   * it re-emits the pending question in the new language via
   * {@link replayCurrentStepPrompt}.
   *
   * `detectLanguageChangeRequest` is deliberately strict (flag emoji, bare
   * language name, or change-verb + language) so that merely mentioning a
   * language while booking never triggers a switch.
   */
  private async handleLanguageChangeRequest(
    messageText: string,
    businessId: string,
    jid: string,
    phone: string,
    conversationId: string,
    draft: ReservationDraft | null
  ): Promise<boolean> {
    // Reply to the welcome language menu. Handled HERE rather than in the
    // `name` step because a bare "2" is not a name, not reservation-related and
    // not an opt-in — evaluateReservationScope would bounce it as off-topic
    // long before processDraftStep ever ran.
    if (draft?.awaitingLanguageChoice) {
      const choice = parseLanguageMenuChoice(messageText);

      delete draft.awaitingLanguageChoice;
      await ReservationService.saveDraft(draft);

      if (!choice) {
        // Not a language choice — the customer went straight to answering with
        // their name. Fall through to the normal flow: that's what makes the
        // menu non-blocking.
        return false;
      }

      await persistLanguage(businessId, phone, choice.language);
      logger.debug('Language selected from welcome menu', {
        conversationId,
        businessId,
        language: choice.language,
        source: choice.source,
      });

      await runWithLanguage(choice.language, async () => {
        await this.sendWhatsAppMessage(businessId, jid, templates.askName());
      });
      return true;
    }

    const request = detectLanguageChangeRequest(messageText);
    if (!request) {
      return false;
    }

    const previous = currentLanguage();
    await persistLanguage(businessId, phone, request.language);

    logger.debug('Language changed by customer request', {
      conversationId,
      businessId,
      phone,
      from: previous,
      to: request.language,
      source: request.source,
      step: draft?.step ?? null,
    });

    // Everything from here on must already speak the NEW language, so the
    // remainder of this turn runs in a fresh context instead of the one the
    // message arrived with.
    await runWithLanguage(request.language, async () => {
      await this.sendWhatsAppMessage(businessId, jid, templates.languageChanged());

      if (draft && draft.step !== 'completed') {
        const prompt = await this.replayCurrentStepPrompt(draft, businessId);
        if (prompt) {
          await this.sendWhatsAppMessage(businessId, jid, prompt);
        }
      }
    });

    return true;
  }

  /**
   * Rebuilds the question the customer is currently being asked, so a language
   * switch doesn't leave them staring at a confirmation with no idea what the
   * bot was waiting for.
   *
   * Returns null for steps whose prompt can't be reconstructed from the draft
   * alone (they need the persisted reservation, or a slot suggestion computed
   * earlier in the turn). In those cases the customer only gets the "language
   * changed" confirmation and their next message is handled normally — degraded
   * but never wrong.
   */
  private async replayCurrentStepPrompt(
    draft: ReservationDraft,
    businessId: string
  ): Promise<string | null> {
    switch (draft.step) {
      case 'name':
        return templates.askName();

      case 'last_name':
        return draft.customerName
          ? templates.askLastName(draft.customerName)
          : templates.askName();

      case 'party_size':
        return draft.customerName
          ? templates.askPartySize(draft.customerName)
          : templates.askPartySizeShort();

      case 'schedule_choice':
        return await this.buildScheduleChoiceMessage(draft.conversationId, businessId, draft);

      case 'date':
        return await this.buildAskDayMessage(businessId);

      case 'time': {
        if (!draft.scheduledDate) {
          return await this.buildAskDayMessage(businessId);
        }
        const dayLabel = describeBaDateKey(draft.scheduledDate, nowInBuenosAires());
        return await this.buildAskTimeMessage(businessId, draft.scheduledDate, dayLabel);
      }

      case 'confirm_summary': {
        const whenLabel = draft.scheduledAt
          ? describeScheduledAtUtc(draft.scheduledAt, nowInBuenosAires())
          : templates.instantTurnLabel();
        return templates.reservationSummary(
          draft.customerName || 'Cliente',
          draft.partySize || 0,
          whenLabel,
          this.buildFullName(draft.customerName, draft.customerLastName) ||
            draft.customerName ||
            'Cliente'
        );
      }

      case 'summary_edit_menu':
        return draft.eventId ? templates.summaryEditMenuEvent() : templates.summaryEditMenu();

      case 'cancel_confirm':
        return templates.cancelConfirmPrompt();

      // edit_menu, cancel_menu, reservation_selection and confirm_slot depend on
      // state that isn't in the draft (the stored reservation, the list of
      // active reservations, the suggested slot). Re-deriving it here would
      // duplicate their handlers; the confirmation alone is enough.
      default:
        return null;
    }
  }

  private async handleGreeting(
    _messageText: string,
    businessId: string,
    jid: string,
    conversationId: string
  ): Promise<boolean> {
    try {
      const existingDraft = await ReservationService.getDraft(conversationId);

      // A slot has already been proposed and is awaiting sí/no, or the customer
      // is mid-edit of a real, already-confirmed reservation: a stray "Hola"
      // (e.g. sent alongside another message in the same debounce batch)
      // must NOT silently wipe that progress. Leave the draft untouched and
      // let the message fall through to be handled as normal step input —
      // the step's own handler will re-show the pending question.
      const isProtectedDraft =
        !!existingDraft &&
        existingDraft.step !== 'completed' &&
        (existingDraft.editMode === true ||
          existingDraft.step === 'confirm_slot' ||
          existingDraft.step === 'confirm_summary' ||
          existingDraft.step === 'summary_edit_menu' ||
          existingDraft.step === 'cancel_menu' ||
          existingDraft.step === 'cancel_confirm' ||
          existingDraft.step === 'edit_menu');

      if (isProtectedDraft) {
        logger.debug('Greeting ignored — preserving in-progress draft', {
          conversationId,
          step: existingDraft!.step,
          editMode: existingDraft!.editMode ?? false,
        });
        return false;
      }

      // 1. Cancel any active draft silently
      if (existingDraft && existingDraft.step !== 'completed') {
        await ReservationService.deleteDraft(conversationId);
        logger.debug('Draft cancelled on greeting', { conversationId, step: existingDraft.step });
      }

      // 2. Clear LLM conversation history so the agent starts fresh
      try {
        await agentService.clearConversationHistory(conversationId);
        logger.debug('Conversation history cleared on greeting', { conversationId });
      } catch (err) {
        logger.warn('Failed to clear conversation history on greeting', { err });
      }

      const phone = this.normalizeWhatsAppNumber(jid);

      // 3. Check for active reservations today (Buenos Aires timezone)
      const activeReservations = await SupabaseService.getActiveReservationsByPhone(
        phone,
        businessId
      );

      if (activeReservations.length === 1) {
        const activeReservation = activeReservations[0];
        // 4a. Single reservation: show the edit menu directly.
        await this.startEditMenuFlow(conversationId, businessId, jid, activeReservation);

        logger.debug('Greeting handled — single active reservation shown', {
          conversationId,
          reservationId: activeReservation.id,
        });
        return true;
      }

      if (activeReservations.length > 1) {
        const availableReservationIds = activeReservations.map((reservation) => reservation.id);
        await ReservationService.startReservationSelection(conversationId, businessId, availableReservationIds);

        const quickOptions = activeReservations.map((reservation, index) => ({
          index: index + 1,
          partySize: reservation.party_size ?? 0,
          whenLabel: this.describeReservationWhen(reservation.scheduled_at),
          displayCode: reservation.display_code ?? null,
          statusLabel: this.getReservationStatusLabel(reservation.status),
        }));

        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.activeReservationsMenu(quickOptions)
        );

        logger.debug('Greeting handled — multiple active reservations shown', {
          conversationId,
          reservationCount: activeReservations.length,
        });
        return true;
      }

      // 4b. No reservation: known customers skip straight to party size (CAMBIO 1);
      // unknown customers get the deterministic M1 welcome + name question.
      const business = await SupabaseService.getBusinessById(businessId);
      await this.startNewReservationFlow(
        conversationId,
        businessId,
        jid,
        phone,
        templates.welcomeMessage(business?.name || 'el local')
      );
      logger.debug('Greeting handled — reservation flow started', {
        conversationId,
      });
      return true;
    } catch (error) {
      logger.error('Error handling greeting', { error, conversationId });
      return false;
    }
  }

  private async handlePostReservationCourtesy(
    businessId: string,
    jid: string,
    messageText: string
  ): Promise<boolean> {
    try {
      if (!this.isPostReservationCourtesyMessage(messageText)) {
        return false;
      }

      const activeReservation = await this.getLatestActiveReservationForPhone(businessId, jid);
      if (!activeReservation) {
        return false;
      }

      const reservationRef = activeReservation.displayCode
        ? ` (código *${activeReservation.displayCode}*)`
        : '';

      const isGratitude = this.isGratitudeMessage(messageText);

      const response = templates.postReservationCourtesyReply(
        reservationRef,
        activeReservation.status === 'WAITING',
        isGratitude
      );

      await this.sendWhatsAppMessage(businessId, jid, response);
      return true;
    } catch (error) {
      logger.error('Error handling post-reservation courtesy', { error, businessId, jid });
      return false;
    }
  }

  private async getLatestActiveReservationForPhone(
    businessId: string,
    jid: string
  ): Promise<ActiveReservationSnapshot | null> {
    try {
      const phone = this.normalizeWhatsAppNumber(jid);
      const client = SupabaseConfig.getClient();

      const { data: customerData, error: customerError } = await client
        .from('customers')
        .select('id')
        .eq('business_id', businessId)
        .eq('phone', phone)
        .maybeSingle();

      if (customerError) {
        throw customerError;
      }

      if (!customerData) {
        return null;
      }

      const { data: reservationData, error: reservationError } = await client
        .from('waitlist_entries')
        .select('status, display_code')
        .eq('business_id', businessId)
        .eq('customer_id', customerData.id)
        .in('status', ['WAITING', 'CONFIRMED', 'NOTIFIED'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (reservationError) {
        throw reservationError;
      }

      if (!reservationData) {
        return null;
      }

      return {
        status: reservationData.status as ActiveReservationSnapshot['status'],
        displayCode: reservationData.display_code,
      };
    } catch (error) {
      logger.error('Error loading latest active reservation for phone', { error, businessId, jid });
      return null;
    }
  }

  private async handlePrefilledReservationRequest(
    messageText: string,
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<boolean> {
    try {
      if (!this.isReservationRequest(messageText)) {
        return false;
      }

      const extractedName = this.extractNameCandidate(messageText);
      if (!extractedName) {
        return false;
      }

      const partySize = this.extractPartySize(messageText);
      const { firstName, lastName } = this.splitFullName(extractedName);

      await ReservationService.startReservation(conversationId, businessId);

      logger.debug('Prefilled reservation data captured', {
        conversationId,
        firstName,
        lastName,
        partySize,
      });

      if (lastName) {
        await ReservationService.setCustomerNameParts(conversationId, firstName, lastName);
      } else {
        // Only a first name — the apellido is optional, don't ask for it separately.
        await ReservationService.setCustomerName(conversationId, firstName);
      }

      await this.continueAfterNameCollected(conversationId, businessId, jid, messageText, firstName, partySize);
      return true;
    } catch (error) {
      logger.error('Error handling prefilled reservation request', {
        error,
        conversationId,
        businessId,
      });
      return false;
    }
  }

  /**
   * Extract number from text
   */
  private extractNumber(text: string): number | null {
    const match = text.match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  }

  private extractPartySize(text: string): number | null {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    if (/^\d{1,2}$/.test(trimmed)) {
      const numericValue = parseInt(trimmed, 10);
      return numericValue >= 1 && numericValue <= 50 ? numericValue : null;
    }

    const withoutTimeHints = trimmed
      .replace(/\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/g, ' ')
      .replace(/\b(?:1[0-2]|0?\d)\s?(?:am|pm|a\.m\.|p\.m\.)\b/gi, ' ');

    const contextualPatterns = [
      /\b(?:somos|para|de|total(?:es)?)\s+(\d{1,2})(?:\s+personas?)?\b/i,
      /\b(\d{1,2})\s+personas?\b/i,
    ];

    for (const pattern of contextualPatterns) {
      const match = withoutTimeHints.match(pattern);
      if (match?.[1]) {
        const numericValue = parseInt(match[1], 10);
        if (numericValue >= 1 && numericValue <= 50) {
          return numericValue;
        }
      }
    }

    return null;
  }

  /**
   * Narrower party-size sniff for steps where a bare number already means
   * something else (e.g. the `time` step, where "14" is an hour). Only an
   * explicit "N personas" mention counts — never a bare digit or a "para N"
   * without the word "personas", both of which would collide with an hour.
   */
  private extractExplicitPartySizeMention(text: string): number | null {
    const withoutTimeHints = text
      .replace(/\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/g, ' ')
      .replace(/\b(?:1[0-2]|0?\d)\s?(?:am|pm|a\.m\.|p\.m\.)\b/gi, ' ');

    const match = withoutTimeHints.match(/\b(\d{1,2})\s+personas?\b/i);
    if (!match) return null;

    const numericValue = parseInt(match[1], 10);
    return numericValue >= 1 && numericValue <= 50 ? numericValue : null;
  }

  /**
   * Second-look via the LLM for a message the regex parsers below couldn't
   * make sense of (see reservation-nlu.service.ts). Returns null when there's
   * nothing usable — callers keep their existing "no entendí" behavior as-is.
   */
  private async getLlmSlotsFallback(
    draft: ReservationDraft,
    messageText: string,
    businessId: string,
    conversationId: string
  ): Promise<ReservationSlots | null> {
    try {
      const [business, history] = await Promise.all([
        SupabaseService.getBusinessById(businessId),
        agentService.getConversationHistory(conversationId),
      ]);
      return await extractReservationUpdate(messageText, draft, business?.name, history);
    } catch (error) {
      logger.warn('LLM slots fallback lookup failed', { conversationId, error });
      return null;
    }
  }

  /** Splits a cleaned name candidate into first name + apellido (rest of the tokens). */
  private splitFullName(full: string): { firstName: string; lastName: string } {
    const parts = full.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      return { firstName: parts[0] ?? full.trim(), lastName: '' };
    }
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  /** Joins first name + apellido for the reservation detail; skips empty parts. */
  private buildFullName(name?: string | null, lastName?: string | null): string {
    return [name, lastName]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join(' ')
      .trim();
  }

  /**
   * Shared tail of the name/last_name steps once the customer's name (and, when
   * available, apellido) is stored: sets any party size the customer already
   * mentioned, resolves an embedded day/time if present, and otherwise asks the
   * next pending question. `embeddedPartySize` is the party size parsed from the
   * current message (may be null); a previously-stashed draft.partySize is used
   * as a fallback so nothing collected earlier is lost.
   */
  private async continueAfterNameCollected(
    conversationId: string,
    businessId: string,
    jid: string,
    messageText: string,
    displayName: string,
    embeddedPartySize: number | null
  ): Promise<void> {
    const draftNow = await ReservationService.getDraft(conversationId);
    const validEmbedded =
      embeddedPartySize && embeddedPartySize > 0 && embeddedPartySize <= 50
        ? embeddedPartySize
        : null;
    const effectivePartySize = validEmbedded ?? draftNow?.partySize ?? null;

    if (!(effectivePartySize && effectivePartySize > 0 && effectivePartySize <= 50)) {
      await this.sendWhatsAppMessage(businessId, jid, templates.askPartySize(displayName));
      return;
    }

    if (validEmbedded) {
      await ReservationService.setPartySize(conversationId, validEmbedded);
      logger.debug('Embedded party size set after name collected', { conversationId, partySize: validEmbedded });
    }

    await this.resolveEmbeddedScheduleOrPromptChoice(conversationId, businessId, jid, messageText);
  }

  /**
   * Out-of-order slot-filling tail (requirement #7): once name and party size
   * are known, if the SAME message already named a valid day (and possibly a
   * time), resolve it immediately instead of forcing the "¿hoy u otro día?"
   * question. Shared by the name/last_name steps, the party_size step and the
   * prefilled fast-path so any of them can complete the reservation from a
   * single message regardless of the order the data arrived in. Falls back to
   * the normal schedule-choice prompt when there's no usable day in the message.
   */
  private async resolveEmbeddedScheduleOrPromptChoice(
    conversationId: string,
    businessId: string,
    jid: string,
    messageText: string
  ): Promise<void> {
    const nowBA = nowInBuenosAires();
    const namedDay = parseRelativeDay(messageText, nowBA);
    if (namedDay && isWithinNextWeek(namedDay.baDate, nowBA)) {
      const business = await SupabaseService.getBusinessById(businessId);
      const weeklyHours = business?.weekly_hours as WeeklyHours | null | undefined;
      const dayOpen = weeklyHours && Object.keys(weeklyHours).length > 0
        ? isDayOpen(namedDay.baDate, weeklyHours)
        : { open: true };
      const dateKey = formatBaDateKey(namedDay.baDate);
      const blockedDates = await SupabaseService.getBlockedDates(businessId);

      // Reject dates the business has explicitly blocked — show the reason before re-prompting
      if (isDateBlocked(dateKey, blockedDates)) {
        const blockedReason = await this.resolveBlockedDateMessage(
          businessId,
          dateKey,
          blockedDates
        );
        // Try to suggest the soonest available slot so customer can confirm with "sí"
        if (await this.proposeSoonestSlot(conversationId, businessId, jid, 'date', blockedReason ?? null)) {
          return;
        }
        // No suitable slot found — show the block notice and re-prompt
        await this.sendWhatsAppMessage(
          businessId,
          jid,
          templates.dateBlocked(namedDay.label, blockedReason)
        );
        await this.promptScheduleChoice(conversationId, businessId, jid);
        return;
      }

      if (dayOpen.open) {
        await ReservationService.setScheduledDate(conversationId, namedDay);

        const namedTime = parseTimeOfDay(messageText);
        if (namedTime) {
          const refreshedDraft = await ReservationService.getDraft(conversationId);
          if (refreshedDraft) {
            await this.finalizeScheduledTime(
              refreshedDraft,
              conversationId,
              businessId,
              jid,
              dateKey,
              namedTime.hour,
              namedTime.minute
            );
            return;
          }
        }

        await this.sendWhatsAppMessage(
          businessId,
          jid,
          await this.buildAskTimeMessage(businessId, dateKey, namedDay.label, weeklyHours)
        );
        return;
      }
    }

    await this.promptScheduleChoice(conversationId, businessId, jid);
  }

  private extractNameCandidate(text: string): string | null {
    const explicitPatterns = [
      /(?:me\s+llamo|mi\s+nombre\s+es|llámame|puedes?\s+llamarme|soy)\s+(.+?)(?=(?:\s+(?:somos|para)\s+\d{1,2}(?:\s+personas?)?)|(?:\s+\d{1,2}\s+personas?\b)|(?:\s+(?:a\s+las|para\s+las|tipo\s+las|sobre\s+las)\s+\d{1,2}(?::\d{2})?\b)|$)/i,
    ];

    for (const pattern of explicitPatterns) {
      const match = text.trim().match(pattern);
      if (match?.[1]) {
        const explicitCandidate = this.cleanNameCandidate(match[1]);
        if (explicitCandidate) {
          return explicitCandidate;
        }
      }
    }

    return this.cleanNameCandidate(text);
  }

  private cleanNameCandidate(text: string): string | null {
    let cleaned = text.trim();

    const greetingWords = [
      'hola', 'buenas', 'buen día', 'buenos días', 'buenas tardes',
      'buenas noches', 'hey', 'hi', 'saludos',
    ];
    const greetingRegex = new RegExp(`^(${greetingWords.join('|')})[,!.\\s]*`, 'i');
    cleaned = cleaned.replace(greetingRegex, '').trim();

    const leadingReservationPatterns = [
      /^(?:quiero|quisiera|necesito|me\s+gustaria|me\s+gustaría)\s+(?:hacer\s+)?(?:una\s+)?(?:reserva(?:r|cion)?|mesa|turno)\b/i,
      /^(?:hacer\s+)?(?:una\s+)?(?:reserva(?:r|cion)?|mesa|turno)\b/i,
      /^(?:me\s+llamo|mi\s+nombre\s+es|llámame|puedes?\s+llamarme|soy)\s+/i,
    ];

    for (const pattern of leadingReservationPatterns) {
      cleaned = cleaned.replace(pattern, '').trim();
    }

    const trailingPatterns = [
      /\b(?:somos|para)\s+\d{1,2}(?:\s+personas?)?\b.*$/i,
      /\b\d{1,2}\s+personas?\b.*$/i,
      /\b(?:a\s+las|para\s+las|tipo\s+las|sobre\s+las)\s+\d{1,2}(?::\d{2})?\b.*$/i,
    ];

    for (const pattern of trailingPatterns) {
      cleaned = cleaned.replace(pattern, '').trim();
    }

    cleaned = cleaned
      .replace(/^[,!.\s]+|[,!.\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned || !this.couldBeAName(cleaned)) {
      return null;
    }

    return this.capitalizeName(cleaned);
  }

  /**
   * Extracts the actual name from a message that may contain greetings or extra words.
   * e.g. "Hola me llamo Matías" → "Matías"
   *      "soy Juan Pérez"      → "Juan Pérez"
   *      "Matías"              → "Matías"
   */
  private extractNameFromMessage(text: string): string {
    const extractedCandidate = this.extractNameCandidate(text);
    if (extractedCandidate) {
      return extractedCandidate;
    }

    let cleaned = text.trim();

    // Explicit patterns — most reliable
    const explicitPatterns = [
      /(?:me\s+llamo|mi\s+nombre\s+es|llámame|puedes?\s+llamarme|soy)\s+([\wáéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[\wáéíóúüñÁÉÍÓÚÜÑ]+)*)/i,
    ];
    for (const pattern of explicitPatterns) {
      const match = cleaned.match(pattern);
      if (match && match[1]) {
        return this.capitalizeName(match[1].trim());
      }
    }

    // Strip leading greetings
    const greetingWords = [
      'hola', 'buenas', 'buen día', 'buenos días', 'buenas tardes',
      'buenas noches', 'hey', 'hi', 'saludos',
    ];
    const greetingRegex = new RegExp(
      `^(${greetingWords.join('|')})[,!.\\s]*`,
      'i'
    );
    cleaned = cleaned.replace(greetingRegex, '').trim();

    // If what remains still has filler words at the start, strip them too
    const fillerStart = /^(es|el|la|mi|me|soy|nombre)\s+/i;
    cleaned = cleaned.replace(fillerStart, '').trim();

    // Return cleaned text capitalized, or original trimmed if cleaning erased everything
    return cleaned.length > 0
      ? this.capitalizeName(cleaned)
      : this.capitalizeName(text.trim());
  }

  /** Capitalizes the first letter of each word. */
  private capitalizeName(name: string): string {
    return name
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Returns true if the message looks like a name correction rather than a party size.
   * e.g. "no, me llamo Juan", "perdón soy María", "mi nombre es Pedro"
   */
  private isNameCorrectionMessage(text: string): boolean {
    const lower = text.toLowerCase().trim();
    // Must not be purely numeric
    if (/^\d+$/.test(lower)) return false;

    // Reject negations — "mi nombre NO es X" is NOT a correction
    const negationPatterns = [
      'no es mi nombre', 'no me llamo', 'no soy', 'no es',
      'mi nombre no', 'nombre no es',
    ];
    if (negationPatterns.some(p => lower.includes(p))) return false;

    const correctionPhrases = [
      'me llamo', 'mi nombre es', 'soy ', 'llámame', 'puedes llamarme',
      'mi nombre', 'en realidad', 'perdón', 'perdon', 'error', 'me equivoqué',
      'me equivoque', 'cambiar nombre', 'cambiar mi nombre',
    ];
    return correctionPhrases.some(phrase => lower.includes(phrase));
  }

  /**
   * Returns true if the message is clearly a reservation/table request rather than a name.
   * e.g. "necesito una mesa para 4", "quiero reservar", "mesa para 2 personas"
   */
  private isReservationRequest(text: string): boolean {
    const lower = this.normalizeCourtesyText(text);
    // Catch "para N" (e.g. "para 4", "para 2 personas")
    if (/para\s+\d/.test(lower)) return true;
    const keywords = [
      'mesa', 'reserva', 'reservar', 'reservacion',
      'necesito', 'quiero', 'quisiera', 'me gustaria',
      'personas', 'persona', 'lugar', 'lugares',
      'agendar', 'apartar', 'turno',
    ];
    return keywords.some(kw => lower.includes(kw));
  }

  /**
   * 🎯 ACTION: Create Reservation - Start the multi-step flow
   */
  /**
   * Returns true when a deterministic message was already sent (the agent's
   * own freeform reply must be skipped in that case).
   */
  private async handleCreateReservation(
    messageText: string,
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<boolean> {
    try {
      const phone = this.normalizeWhatsAppNumber(jid);
      logger.debug('Starting CREATE_RESERVATION action', { conversationId, businessId, phone });

      // Start reservation flow regardless of existing active reservations.
      // Known customers (phone already in `customers`) skip straight to
      // party_size — the agent's own reply is driven by the resulting step,
      // so no message is sent from here either way.
      const knownCustomer = await SupabaseService.getCustomerByPhone(phone, businessId);
      const draft = knownCustomer?.name
        ? await ReservationService.startReservationForKnownCustomer(
            conversationId,
            businessId,
            knownCustomer.name,
            knownCustomer.lastName
          )
        : await ReservationService.startReservation(conversationId, businessId);
      logger.debug('Reservation flow started', {
        conversationId,
        draftStep: draft.step,
      });

      // For known customers (name already on file, draft starts at
      // `party_size`) the opening message may already carry the party size
      // (and even a day/time, e.g. "reserva para hoy 4 personas a las 21").
      // Capture it now and advance the draft through the real schedule logic
      // instead of leaving it parked at `party_size` while an ungrounded
      // freeform reply goes out — that mismatch is what let a later
      // bare-number answer (meant as the hour) get misread as a party-size
      // correction. New customers still need the `name` step first, so this
      // fast path is skipped for them.
      if (knownCustomer?.name) {
        const partySize = this.extractPartySize(messageText);
        if (partySize && partySize > 0 && partySize <= 50) {
          await ReservationService.setPartySize(conversationId, partySize);
          await this.resolveEmbeddedScheduleOrPromptChoice(conversationId, businessId, jid, messageText);
          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error('Error handling create reservation', { error, conversationId });
      return false;
    }
  }

  /**
   * 📊 ACTION: Check Status - Query reservation info
   */
  private async handleCheckStatus(
    businessId: string,
    jid: string,
    conversationId: string
  ): Promise<void> {
    try {
      // Extract normalized phone number for database lookups
      const phone = this.normalizeWhatsAppNumber(jid);

      // Read-only lookup on purpose: this path must never mint a customer row.
      // It used to call getOrCreateCustomer('Unknown', ...), which created rows
      // whose name was the literal 'Unknown' — and since that string is truthy,
      // it poisoned every "is this a returning customer?" check downstream.
      const customer = await SupabaseService.getCustomerByPhone(phone, businessId);

      if (!customer) {
        logger.warn('Customer not found', { businessId, phone });
        return;
      }

      // Get current reservation
      const client = SupabaseConfig.getClient();
      const { data: reservation } = await client
        .from('waitlist_entries')
        .select('*')
        .eq('business_id', businessId)
        .eq('customer_id', customer.id)
        .eq('status', 'WAITING')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!reservation) {
        logger.debug('No active reservation found', { customerId: customer.id });
        return;
      }

      logger.debug('Reservation status queried', {
        customerId: customer.id,
      });
    } catch (error) {
      logger.error('Error handling check status', { error, conversationId });
    }
  }

  /**
   * Cancela una reserva a pedido del propio cliente.
   *
   * Idéntico a `SupabaseService.updateReservationStatus(id, 'CANCELLED')` salvo
   * por un detalle que no es opcional: marca el aviso como ya enviado ANTES de
   * escribir en la DB. El suscriptor de Realtime ve ese UPDATE a los pocos
   * milisegundos y, sin la marca, le mandaría al cliente un segundo mensaje
   * diciéndole que la canceló el restaurante — que es justo lo contrario de lo
   * que acaba de pasar. En este turno la respuesta se la damos nosotros.
   *
   * Si el UPDATE falla se levanta la marca: si no, una cancelación posterior
   * hecha desde el panel quedaría muda por hasta 24 horas.
   */
  private async cancelReservationForCustomer(reservationId: string): Promise<boolean> {
    const dedupKey = statusNotificationKey(reservationId, 'CANCELLED');
    await markNotified(dedupKey);

    const cancelled = await SupabaseService.updateReservationStatus(reservationId, 'CANCELLED');

    if (!cancelled) {
      await clearNotified(dedupKey);
    }

    return cancelled;
  }

  /**
   * ❌ ACTION: Cancel - Mark reservation as CANCELLED
   */
  private async handleCancel(
    businessId: string,
    jid: string,
    conversationId: string
  ): Promise<void> {
    try {
      // Extract normalized phone number for database lookups
      const phone = this.normalizeWhatsAppNumber(jid);

      // Read-only lookup — see handleCheckStatus: creating a placeholder customer
      // here would misclassify a brand-new phone as a returning one.
      const customer = await SupabaseService.getCustomerByPhone(phone, businessId);

      if (!customer) {
        logger.warn('Customer not found for cancellation', { businessId, phone });
        return;
      }

      // Find active reservation
      const client = SupabaseConfig.getClient();
      const { data: reservation, error } = await client
        .from('waitlist_entries')
        .select('*')
        .eq('business_id', businessId)
        .eq('customer_id', customer.id)
        .in('status', ['WAITING', 'CONFIRMED', 'NOTIFIED'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !reservation) {
        logger.warn('No active reservation to cancel', { customerId: customer.id });
        return;
      }

      // Update status to CANCELLED
      await this.cancelReservationForCustomer((reservation as any).id);

      logEvent('info', 'reservation.cancelled', {
        customerId: customer.id,
        displayCode: (reservation as any).display_code,
        via: 'cancel_action',
      });
    } catch (error) {
      logger.error('Error handling cancel', { error, conversationId });
    }
  }

  /**
   * ℹ️ ACTION: Info Request - Provide business information
   */
  private async handleInfoRequest(
    businessId: string,
    _jid: string,
    conversationId: string
  ): Promise<void> {
    try {
      // Get business details
      const business = await SupabaseService.getBusinessById(businessId);

      if (!business) {
        logger.warn('Business not found for info request', { businessId });
        return;
      }

      // Get tables to show capacity info
      const tables = await SupabaseService.getTablesByBusiness(businessId);

      logger.debug('Business info retrieved', {
        businessId,
        name: business.name,
        tablesCount: tables.length,
      });
    } catch (error) {
      logger.error('Error handling info request', { error, conversationId });
    }
  }
}
