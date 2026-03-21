import { BaileysService } from './baileys.service';
import { agentService } from './agent.service';
import { ReservationService } from './reservation.service';
import { SupabaseService } from './supabase.service';
import { SupabaseConfig } from '../config/supabase';
import { RedisConfig } from '../config/redis';
import { agentRegistry } from '../agents';
import { BaileysMessage, ReservationDraft } from '../types';
import { logger } from '../utils/logger';

type ActiveReservationSnapshot = {
  status: 'WAITING' | 'CONFIRMED' | 'NOTIFIED';
  displayCode: string | null;
};

/** How long (ms) to wait for more messages before processing the batch. */
const DEBOUNCE_MS = 1500;
const DUPLICATE_OUTBOUND_WINDOW_MS = 10000;
const INACTIVE_FALLBACK_TTL_SECONDS = 120;
const INACTIVE_FALLBACK_MESSAGE =
  'Lo siento, nuestro servicio de WhatsApp no está disponible en este momento. Por favor intenta más tarde.';

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

  constructor(baileysService: BaileysService) {
    this.baileysService = baileysService;
  }

  /**
   * Debounce incoming messages per conversation.
   * Multiple messages arriving within DEBOUNCE_MS are merged into a single call
   * to _processMessage, producing exactly one response.
   */
  async processMessage(message: BaileysMessage): Promise<void> {
    const { from, businessId } = message;
    const phone = this.normalizeWhatsAppNumber(from);
    const conversationId = `${businessId}-${phone}`;

    const existing = this.debounceBuffer.get(conversationId);
    if (existing) {
      // More messages were received before the timer fired; accumulate and reset timer
      clearTimeout(existing.timer);
      existing.messages.push(message);
    }

    const entry = existing ?? { messages: [message], timer: undefined as any };

    const timer = setTimeout(() => {
      this.debounceBuffer.delete(conversationId);
      const batch = entry.messages;

      // Merge all texts into one, preserving the first message's metadata
      const combined: BaileysMessage = {
        ...batch[0],
        message: batch.map(m => m.message).join('\n'),
      };

      if (batch.length > 1) {
        logger.info('📦 Batching rapid messages into one', {
          conversationId,
          count: batch.length,
          combined: combined.message.substring(0, 120),
        });
      }

      // Serialize against any in-progress processing for this conversation
      const previous = this.processingLock.get(conversationId) ?? Promise.resolve();
      const current = previous
        .then(() => this._processMessage(combined))
        .catch(err => { logger.error('Error in _processMessage', { conversationId, err }); });
      this.processingLock.set(conversationId, current);
      current.finally(() => {
        if (this.processingLock.get(conversationId) === current) {
          this.processingLock.delete(conversationId);
        }
      });
    }, DEBOUNCE_MS);

    entry.timer = timer;
    if (!existing) {
      this.debounceBuffer.set(conversationId, entry);
    }
  }

  /**
   * Internal processor — receives one (possibly merged) message per invocation.
   */
  private async _processMessage(message: BaileysMessage): Promise<void> {
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
        const redis = await import('../config/redis');
        const client = redis.RedisConfig.getClient();
        const jidMappingKey = `jid:${businessId}:${phone}`;
        await client.setEx(jidMappingKey, 30 * 24 * 60 * 60, from); // 30 days TTL
        logger.debug('JID mapping cached', { phone, from, businessId });
      } catch (error) {
        logger.warn('Failed to cache JID mapping', { error, phone, from });
      }

      logger.info('Processing WhatsApp message', { 
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
        logger.warn('Skipping inactive fallback due to unknown business state', {
          businessId,
          phone,
          conversationId,
        });
        return;
      }

      const isActive =
        businessStatus.whatsapp_session_id !== null && businessStatus.whatsapp_session_id !== undefined;
      if (!isActive) {
        const shouldNotifyUnavailable = await this.shouldSendInactiveFallback(businessId, phone);
        if (shouldNotifyUnavailable) {
          await this.sendWhatsAppMessage(businessId, from, INACTIVE_FALLBACK_MESSAGE);
        } else {
          logger.info('Inactive service fallback suppressed by throttle', {
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

      // --- Early exit keyword check (any step) ---
      if (draft && draft.step !== 'completed' && this.isExitKeyword(messageText)) {
        // If user is in the edit menu, "cancelar" means cancel the actual reservation
        if (draft.step === 'edit_menu' && draft.existingReservationId) {
          await ReservationService.deleteDraft(conversationId);
          const cancelled = await SupabaseService.updateReservationStatus(
            draft.existingReservationId,
            'CANCELLED'
          );
          const msg = cancelled
            ? '✅ Tu reserva fue cancelada correctamente. ¡Hasta la próxima!'
            : '❌ No se pudo cancelar la reserva. Por favor contactá directamente al local.';
          await this.sendWhatsAppMessage(businessId, from, msg);
          logger.info('Reservation cancelled via exit keyword in edit_menu', {
            conversationId,
            reservationId: draft.existingReservationId,
          });
        } else {
          // In any other step the draft represents a flow not yet saved to DB.
          // But if the message also expresses cancellation intent, also cancel any
          // existing DB reservation for today (e.g. user had a previous confirmed
          // reservation and is now trying to cancel it while a new flow was open).
          await ReservationService.deleteDraft(conversationId);

          if (this.isCancellationIntent(messageText)) {
            const phone = this.normalizeWhatsAppNumber(from);
            const activeRes = await SupabaseService.getActiveTodayReservationByPhone(phone, businessId);
            if (activeRes) {
              const cancelled = await SupabaseService.updateReservationStatus(activeRes.id, 'CANCELLED');
              const msg = cancelled
                ? '✅ Tu reserva fue cancelada correctamente. ¡Hasta la próxima!'
                : '❌ No se pudo cancelar la reserva. Por favor contactá directamente al local.';
              await this.sendWhatsAppMessage(businessId, from, msg);
              logger.info('Reservation cancelled via exit keyword + cancellation intent', {
                conversationId,
                reservationId: activeRes.id,
              });
              return;
            }
          }

          await this.sendWhatsAppMessage(
            businessId,
            from,
            '✅ Proceso cancelado. Podés empezar de nuevo cuando quieras.'
          );
          logger.info('Flow cancelled by exit keyword', { conversationId, step: draft.step });
        }
        return;
      }

      // --- Cancellation intent without an active draft ---
      // e.g. "la quiero cancelar", "cancelar mi reserva", "quiero cancelar"
      if (!draft && this.isCancellationIntent(messageText)) {
        const phone = this.normalizeWhatsAppNumber(from);
        const activeRes = await SupabaseService.getActiveTodayReservationByPhone(phone, businessId);
        if (activeRes) {
          const cancelled = await SupabaseService.updateReservationStatus(activeRes.id, 'CANCELLED');
          const msg = cancelled
            ? `✅ Tu reserva fue cancelada correctamente. ¡Hasta la próxima!`
            : '❌ No se pudo cancelar la reserva. Por favor contactá directamente al local.';
          await this.sendWhatsAppMessage(businessId, from, msg);
          logger.info('Reservation cancelled via direct cancellation intent', {
            conversationId,
            reservationId: activeRes.id,
          });
        } else {
          await this.sendWhatsAppMessage(
            businessId,
            from,
            'No encontré ninguna reserva activa para hoy. ¿Algo más en lo que pueda ayudarte?'
          );
        }
        return;
      }

      // --- Greeting: reset flow and check for active reservation ---
      if (this.isGreetingMessage(messageText)) {
        const greetingHandled = await this.handleGreeting(messageText, businessId, from, conversationId);
        if (greetingHandled) {
          logger.info('Greeting handled with reservation menu', { conversationId });
          return;
        }
        // No active reservation — clear old draft and fall through to agent
        draft = null;
      }

      // FAST PATH: deterministic reservation steps should not wait for AI response
      if (draft && (draft.step === 'party_size' || draft.step === 'edit_menu')) {
        logger.info('⚡ Bypassing agent for deterministic draft step', {
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
          logger.info('Agent response skipped (deterministic draft step handled)', {
            conversationId,
            step: draft.step,
          });
          logger.info('WhatsApp message processed successfully', {
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

      // Courtesy handling: if reservation is already active/confirmed and user sends
      // a short acknowledgment (thanks/ok/dale/etc.), reply naturally without restarting flow.
      if (!draft) {
        const courtesyHandled = await this.handlePostReservationCourtesy(
          businessId,
          from,
          messageText
        );
        if (courtesyHandled) {
          logger.info('Post-reservation courtesy handled', { conversationId, businessId, from });
          return;
        }

        // Business rule: one active reservation per phone/day.
        // Block explicit attempts to create a second reservation while one is active.
        const singleReservationPolicyHandled = await this.enforceSingleActiveReservationPolicy(
          businessId,
          from,
          messageText,
          conversationId
        );
        if (singleReservationPolicyHandled) {
          return;
        }
      }
      
      // Get business details for context
      const business = await SupabaseService.getBusinessById(businessId);
      const businessName = business?.name || 'el restaurante';
      
      // Build context
      const context: any = {
        businessId,
        businessName,
        phone,
        hasActiveDraft: !!draft,
      };

      if (draft) {
        context.currentStep = draft.step;
        context.draftData = {
          customerName: draft.customerName,
          partySize: draft.partySize,
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
              logger.info('🎬 Auto-creating reservation draft', { conversationId, businessId, userName: messageText });
              
              // Create draft and set customer name
              const extractedName = this.extractNameFromMessage(messageText);
              await ReservationService.startReservation(conversationId, businessId);
              await ReservationService.setCustomerName(conversationId, extractedName);
              
              // Update local draft reference
              draft = await ReservationService.getDraft(conversationId);
              
              // Send confirmation message and ask for party size immediately
              const nameConfirmMsg = `✅ Perfecto, *${extractedName}*!\n\n¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4, 6, etc.`;
              await this.sendWhatsAppMessage(businessId, from, nameConfirmMsg);
              
              logger.info('✅ Draft created, name saved, and party size question sent', {
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
      logger.info('Agent context snapshot', {
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
        logger.info('Agent response skipped (custom message sent)', { conversationId });
      }

      logger.info('WhatsApp message processed successfully', { 
        businessId, 
        phone,
        action: agentResponse.action,
      });
    } catch (error) {
      logger.error('Error processing WhatsApp message', { error, message });
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
      logger.info('🔄 Processing action', {
        conversationId,
        action,
        hasDraft: !!draft,
        draftStep: draft?.step,
        messageText: messageText.substring(0, 50),
      });

      // If draft exists, process based on current step (reservation flow in progress)
      if (draft && draft.step !== 'completed') {
        logger.info('📝 Processing draft step', {
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
          await this.handleCreateReservation(conversationId, businessId, jid);
          break;

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
          logger.info('No specific action to process', { action, conversationId });
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
      logger.info('Processing draft step', { 
        conversationId, 
        step: draft.step,
        messageText: messageText.substring(0, 50),
      });

      switch (draft.step) {
        case 'name': {
          // User provided their name — extract it intelligently
          const extractedName = this.extractNameFromMessage(messageText);
          logger.info('📝 Setting customer name', { conversationId, raw: messageText, extracted: extractedName });
          const updatedDraft = await ReservationService.setCustomerName(conversationId, extractedName);
          logger.info('✅ Customer name set', { 
            conversationId, 
            name: extractedName,
            nextStep: updatedDraft?.step,
          });
          
          // Send confirmation and ask for party size
          const nameConfirmMsg = `✅ Perfecto, *${extractedName}*!\n\n¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4, 6, etc.`;
          await this.sendWhatsAppMessage(businessId, jid, nameConfirmMsg);
          return true;
        }

        case 'party_size': {
          // Check if user is correcting their name instead of providing a party size
          if (this.isNameCorrectionMessage(messageText)) {
            const correctedName = this.extractNameFromMessage(messageText);
            await ReservationService.setNameOnly(conversationId, correctedName);
            logger.info('✏️ Name corrected at party_size step', { conversationId, correctedName });
            const nameFixMsg = `✅ ¡Listo! Cambié tu nombre a *${correctedName}*.\n\n¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4, 6, etc.`;
            await this.sendWhatsAppMessage(businessId, jid, nameFixMsg);
            return true;
          }

          // User provided party size
          logger.info('📝 Extracting party size', { conversationId, messageText });
          const partySize = this.extractNumber(messageText);
          logger.info('🔢 Party size extracted', { conversationId, partySize });

          if (partySize && partySize > 0 && partySize <= 50) {
            // ----- EDIT MODE: just update the existing reservation -----
            if (draft.editMode && draft.existingReservationId) {
              const ok = await SupabaseService.updateReservationPartySize(
                draft.existingReservationId,
                partySize
              );
              await ReservationService.deleteDraft(conversationId);
              const msg = ok
                ? `✅ ¡Listo! Tu reserva fue actualizada a *${partySize}* personas.`
                : '❌ No se pudo actualizar la cantidad. Por favor intentá de nuevo.';
              await this.sendWhatsAppMessage(businessId, jid, msg);
              return true;
            }

            // ----- NORMAL MODE -----
            await ReservationService.setPartySize(conversationId, partySize);
            logger.info('✅ Party size set', { conversationId, partySize });

            // Create reservation immediately after party size is confirmed
            logger.info('💾 Creating reservation', { conversationId, businessId, jid });
            await this.createAndNotifyReservation(conversationId, businessId, jid);
            return true;
          } else {
            // Invalid party size — track attempts and cancel after 2
            logger.warn('Invalid party size provided', { conversationId, messageText });

            draft.invalidAttempts = (draft.invalidAttempts ?? 0) + 1;
            await ReservationService.saveDraft(draft);

            if (draft.invalidAttempts >= 2) {
              await ReservationService.deleteDraft(conversationId);
              await this.sendWhatsAppMessage(
                businessId,
                jid,
                '❌ Demasiados intentos inválidos. El proceso fue cancelado. Podés empezar de nuevo cuando quieras.'
              );
            } else {
              const invalidMessage = '❌ Por favor indica con un *número* cuántas personas son.\n\nEjemplo: 2, 4, 6, etc.\n\n_(Para cancelar escribí *cancelar* o *salir*)_';
              await this.sendWhatsAppMessage(businessId, jid, invalidMessage);
            }
            return true;
          }
          break;
        }

        case 'edit_menu': {
          // User is choosing what to edit: 1=party_size, 2=cancel
          const choice = this.extractNumber(messageText);
          const reservationId = draft.existingReservationId;

          if (!reservationId) {
            await ReservationService.deleteDraft(conversationId);
            await this.sendWhatsAppMessage(businessId, jid, 'Lo siento, no encontré tu reserva. Intentá de nuevo.');
            return true;
          }

          if (choice === 1) {
            await ReservationService.startEditReservation(conversationId, businessId, reservationId, {
              customerName: draft.customerName,
              partySize: draft.partySize,
            });
            await this.sendWhatsAppMessage(businessId, jid, '¿Para cuántas personas querés cambiar la reserva?\n\nEjemplo: 2, 4, 6, etc.');
            return true;
          } else if (choice === 2) {
            // Cancel reservation
            await ReservationService.deleteDraft(conversationId);
            const cancelled = await SupabaseService.updateReservationStatus(reservationId, 'CANCELLED');
            const msg = cancelled
              ? '✅ Tu reserva fue cancelada. Podés crear una nueva cuando quieras.'
              : '❌ No se pudo cancelar la reserva. Por favor contactá al restaurante.';
            await this.sendWhatsAppMessage(businessId, jid, msg);
            return true;
          } else {
            await this.sendWhatsAppMessage(
              businessId,
              jid,
              '❌ Por favor respondé con *1* o *2* según la opción que elegiste.'
            );
            return true;
          }
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
      
      logger.info('💾 Attempting to create reservation in Supabase', {
        conversationId,
        businessId,
        jid,
        phone,
      });

      // Get draft data BEFORE creating reservation (to build confirmation message)
      const draft = await ReservationService.getDraft(conversationId);

      const result = await ReservationService.createReservation(conversationId, phone);

      logger.info('📊 Reservation creation result', {
        conversationId,
        success: result.success,
        hasWaitlistEntry: !!result.waitlistEntry,
        error: result.error,
      });

      if (result.success && result.waitlistEntry && draft) {
        // -- Duplicate: customer already has a reservation today --
        if (result.alreadyExists) {
          const entry = result.waitlistEntry;
          logger.info('Reservation already exists for today, showing summary', {
            conversationId,
            entryId: entry.id,
            displayCode: entry.display_code,
          });
          await ReservationService.deleteDraft(conversationId);
          const summaryMsg =
            `⚠️ Ya tenés una reserva para hoy:\n\n` +
            `👥 Personas: *${entry.party_size}*\n` +
            `📋 Código: *${entry.display_code}*\n\n` +
            `Si querés modificarla, respondé *hola* para ver las opciones.`;
          await this.sendWhatsAppMessage(businessId, jid, summaryMsg);
          return;
        }

        logger.info('Waitlist entry created successfully', { 
          conversationId,
          entryId: result.waitlistEntry.id,
          status: result.waitlistEntry.status,
          displayCode: result.waitlistEntry.display_code,
        });

        // Build and send confirmation message to customer via WhatsApp
        const entry = result.waitlistEntry;
        
        // Get business configuration for conditional messaging
        const business = await SupabaseService.getBusinessById(businessId);
        const autoAccept = business?.auto_accept_reservations ?? false;
        
        logger.info('Building confirmation message', {
          businessId,
          autoAccept,
          status: entry.status,
          displayCode: entry.display_code,
        });

        let confirmationMessage: string;

        if (autoAccept && (entry.status === 'CONFIRMED' || entry.status === 'NOTIFIED')) {
          confirmationMessage =
            `✅ ¡Tu reserva está CONFIRMADA!\n\n` +
            `👤 Nombre: ${draft.customerName || 'Cliente'}\n` +
            `👥 Personas: ${draft.partySize || entry.party_size}\n` +
            `📁 Código de reserva: *${entry.display_code}*\n\n` +
            `✨ Te avisaremos cuando falten 10 minutos para que puedas ocupar tu mesa.\n` +
            `Apreciamos tu puntualidad.\n\n` +
            `_Si necesitas cancelar, respondé CANCELAR._`;
        } else {
          confirmationMessage =
            `⏳ *Reserva RECIBIDA*\n\n` +
            `👤 Nombre: ${draft.customerName || 'Cliente'}\n` +
            `👥 Personas: ${draft.partySize || entry.party_size}\n` +
            `📁 Código: *${entry.display_code}*\n\n` +
            `⏰ Le notificaremos cuando el restaurante confirme su reserva.\n\n` +
            `_Si necesitas cancelar, respondé CANCELAR._`;
        }

        logger.info('📤 Sending confirmation message to customer', {
          businessId,
          jid,
          phone,
          autoAccept,
          status: entry.status,
          displayCode: entry.display_code,
          messagePreview: confirmationMessage.substring(0, 100),
        });

        await this.sendWhatsAppMessage(businessId, jid, confirmationMessage);

        // Mark dedup key only when reservation is already confirmed/notified.
        // Do not pre-mark CONFIRMED for WAITING entries, otherwise realtime
        // status transitions (WAITING -> CONFIRMED) will be skipped.
        if (entry.status === 'CONFIRMED' || entry.status === 'NOTIFIED') {
          try {
            if (RedisConfig.isReady()) {
              const redisClient = RedisConfig.getClient();
              await redisClient.setEx(`wa:status:sent:${entry.id}:${entry.status}`, 90, '1');
            }
          } catch (error) {
            logger.warn('Failed to mark status dedup key', {
              businessId,
              entryId: entry.id,
              status: entry.status,
              error,
            });
          }
        }

        logger.info('✅ Confirmation message sent successfully to customer', {
          conversationId,
          jid,
          phone,
          entryId: entry.id,
          displayCode: entry.display_code,
        });

        // Store reservation notification in Redis
        try {
          const redis = await import('../config/redis');
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
          
          logger.info('Reservation notification stored in Redis', { businessId });
        } catch (error) {
          logger.error('Failed to store reservation notification', { businessId, error });
        }
      } else {
        // Failed to create reservation - send error message to user
        logger.error('Failed to create reservation', { conversationId, error: result.error });
        
        const errorMessage = '❌ Lo siento, hubo un problema al crear tu reserva. Por favor intenta de nuevo o contacta con el restaurante.';
        await this.sendWhatsAppMessage(businessId, jid, errorMessage);
      }
    } catch (error) {
      logger.error('Error creating and notifying reservation', { error, conversationId });
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
        logger.warn('Suppressing duplicate outbound message', {
          businessId,
          to,
          windowMs: DUPLICATE_OUTBOUND_WINDOW_MS,
        });
        return;
      }

      const success = await this.baileysService.sendMessage(businessId, to, message);
      
      if (!success) {
        logger.error('Failed to send WhatsApp message', { businessId, to });
        return;
      }

      this.lastSentByChat.set(dedupKey, {
        text: message,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Error sending WhatsApp message', { error, businessId, to });
    }
  }

  private async shouldSendInactiveFallback(businessId: string, phone: string): Promise<boolean> {
    try {
      if (!RedisConfig.isReady()) {
        logger.warn('Redis not ready, skipping inactive fallback send to avoid false positives', {
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
      logger.info('TEST MODE: processing inbound message', { businessId, from, fromMe });
      return false;
    } else {
      // En producción: ignorar todos los mensajes fromMe (respuestas del bot)
      if (fromMe) {
        logger.info('Ignoring own message in production mode', { businessId, from });
        return true;
      }
      return false;
    }
  }

  private sanitizeAgentResponse(response: string, draft: ReservationDraft | null): string {
    const trimmedResponse = response.trim();
    const fallbackEscaped = INACTIVE_FALLBACK_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let sanitized = trimmedResponse.replace(new RegExp(fallbackEscaped, 'gi'), '').trim();

    const hasUnresolvedPlaceholders = /\{(?:name|qty)\}|\[(?:NOMBRE|CANTIDAD)\]/i.test(sanitized);
    if (hasUnresolvedPlaceholders) {
      logger.warn('Agent response contains unresolved placeholders, forcing deterministic fallback', {
        draftStep: draft?.step,
        preview: sanitized.substring(0, 120),
      });

      if (draft?.step === 'party_size') {
        return '¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4, 6, etc.';
      }

      return '¿Cuál es tu nombre para continuar con la reserva?';
    }

    if (!sanitized) {
      return draft?.step === 'party_size'
        ? '¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4, 6, etc.'
        : '¿Cuál es tu nombre para continuar con la reserva?';
    }

    return sanitized;
  }

  private normalizeWhatsAppNumber(jid: string): string {
    const withoutDomain = jid.split('@')[0] || jid;
    const withoutDevice = withoutDomain.split(':')[0] || withoutDomain;
    return withoutDevice.replace(/[^0-9+]/g, '');
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

  /**
   * Business rule guard: one active reservation per day and phone.
   * Blocks explicit attempts to create an additional reservation while current one is active.
   */
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
      const activeReservation = await SupabaseService.getActiveTodayReservationByPhone(phone, businessId);
      if (!activeReservation) {
        return false;
      }

      const statusLabel = this.getReservationStatusLabel(activeReservation.status);
      const displayCodeText = activeReservation.display_code
        ? ` (código *${activeReservation.display_code}*)`
        : '';

      const reminderMessage =
        `⚠️ Recordatorio: ya tenés una reserva para hoy${displayCodeText} con estado *${statusLabel}*.` +
        `\n\nNo puedo crear otra reserva hasta que la actual cambie a *finalizada* o se *cancele*.` +
        `\n\nSi querés, respondé *CANCELAR* para anularla y después crear una nueva.`;

      await this.sendWhatsAppMessage(businessId, jid, reminderMessage);

      logger.info('Single-active-reservation policy applied', {
        conversationId,
        businessId,
        status: activeReservation.status,
        displayCode: activeReservation.display_code,
      });

      return true;
    } catch (error) {
      logger.error('Error enforcing single-active-reservation policy', {
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
      /\botra\s+reserva\b/,
      /\bnueva\s+reserva\b/,
      /\bquiero\s+hacer\s+otra\s+reserva\b/,
      /\bquiero\s+reservar\b/,
      /\breservar\s+otra\b/,
      /\bhacer\s+una\s+reserva\b/,
      /\bmesa\s+para\b/,
      /\bquiero\s+una\s+mesa\b/,
    ];

    return explicitPatterns.some((pattern) => pattern.test(normalized));
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
    return (
      lower.includes('cancelar') ||
      lower.includes('cancela') ||
      lower.includes('anular') ||
      lower.includes('anula') ||
      lower.includes('borrar reserva') ||
      lower.includes('eliminar reserva')
    );
  }

  private isExitKeyword(text: string): boolean {
    const normalized = this.normalizeCourtesyText(text);
    // Match if any exit keyword appears as a whole word anywhere in the message.
    // This handles: "cancelar", "CANCELAR", "quiero cancelar", "me quiero ir",
    // "para salir", "stop ya", "volver al menu", etc.
    const keywords = [
      'cancelar', 'cancela', 'cancel',
      'salir', 'quiero salir', 'me quiero ir',
      'stop', 'para', 'detener',
      'inicio', 'menu', 'volver', 'atras', 'restart',
      'no quiero', 'dejalo', 'olvidalo', 'olvidame', 'olvida',
      'no importa', 'no gracias', 'dejame', 'no hacer',
    ];
    return keywords.some(kw => {
      // Word-boundary aware: the keyword must appear as a standalone token
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalized);
    });
  }

  private isGreetingMessage(text: string): boolean {
    const normalized = this.normalizeCourtesyText(text);
    return /^(hola|holis|hello|hi|hey|buenas|buenos dias|buenas tardes|buenas noches|buen dia|buen dia!|holaa|holaa!|que tal|quetal)$/.test(normalized);
  }

  /**
   * Handle a greeting: cancel any active draft, check for today's reservation,
   * and either show the reservation menu or a normal welcome response.
   * Returns true if the greeting was handled (message was sent).
   */
  private async handleGreeting(
    _messageText: string,
    businessId: string,
    jid: string,
    conversationId: string
  ): Promise<boolean> {
    try {
      // 1. Cancel any active draft silently
      const existingDraft = await ReservationService.getDraft(conversationId);
      if (existingDraft && existingDraft.step !== 'completed') {
        await ReservationService.deleteDraft(conversationId);
        logger.info('Draft cancelled on greeting', { conversationId, step: existingDraft.step });
      }

      // 2. Clear Ollama conversation history so the agent starts fresh
      try {
        await agentService.clearConversationHistory(conversationId);
        logger.info('Conversation history cleared on greeting', { conversationId });
      } catch (err) {
        logger.warn('Failed to clear conversation history on greeting', { err });
      }

      const phone = this.normalizeWhatsAppNumber(jid);

      // 3. Check for an active reservation today (Buenos Aires timezone)
      const activeReservation = await SupabaseService.getActiveTodayReservationByPhone(
        phone,
        businessId
      );

      if (activeReservation) {
        // 4a. Show reservation summary and edit/cancel menu
        const statusLabel =
          activeReservation.status === 'CONFIRMED' || activeReservation.status === 'NOTIFIED'
            ? '✅ Confirmada'
            : '⏳ Pendiente';

        const summaryMsg =
          `¡Hola! Ya tenés una reserva para hoy:\n\n` +
          `👥 Personas: *${activeReservation.party_size}*\n` +
          `📋 Código: *${activeReservation.display_code}*\n` +
          `📌 Estado: ${statusLabel}\n\n` +
          `⚠️ Mientras esta reserva siga activa, no puedo crear una nueva.\n\n` +
          `¿Qué querés hacer?\n` +
          `1️⃣ Editar cantidad de personas\n` +
          `2️⃣ Cancelar la reserva\n\n` +
          `Responde con el *número* de la opción.`;

        await this.sendWhatsAppMessage(businessId, jid, summaryMsg);

        // Store edit_menu draft so the next message is intercepted
        await ReservationService.startEditMenu(conversationId, businessId, activeReservation.id, {
          partySize: activeReservation.party_size ?? undefined,
        });

        logger.info('Greeting handled — reservation menu shown', {
          conversationId,
          reservationId: activeReservation.id,
        });
        return true;
      }

      // 4b. No reservation: let the normal agent flow handle the welcome
      logger.info('Greeting handled — no active reservation, falling through to agent', {
        conversationId,
      });
      return false;
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

      const response =
        activeReservation.status === 'WAITING'
          ? isGratitude
            ? `¡De nada! 🙌\n\nTu reserva${reservationRef} sigue pendiente de confirmación. Apenas el restaurante la confirme, te avisamos por acá.`
            : `¡Perfecto! 🙌\n\nTu reserva${reservationRef} sigue pendiente de confirmación. Apenas el restaurante la confirme, te avisamos por acá.`
          : isGratitude
            ? `¡De nada! 🙌\n\nTu reserva${reservationRef} ya está confirmada. Si necesitas algo más, estoy para ayudarte.`
            : `¡Genial! 🙌\n\nTu reserva${reservationRef} ya está confirmada. Si necesitas algo más, estoy para ayudarte.`;

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

  /**
   * Extract number from text
   */
  private extractNumber(text: string): number | null {
    const match = text.match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  }

  /**
   * Extracts the actual name from a message that may contain greetings or extra words.
   * e.g. "Hola me llamo Matías" → "Matías"
   *      "soy Juan Pérez"      → "Juan Pérez"
   *      "Matías"              → "Matías"
   */
  private extractNameFromMessage(text: string): string {
    // If the whole message looks like a reservation request, don't extract a name from it
    if (this.isReservationRequest(text)) {
      return this.capitalizeName(text.trim());
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
  private async handleCreateReservation(
    conversationId: string,
    businessId: string,
    jid: string
  ): Promise<void> {
    try {
      logger.info('🎯 Starting CREATE_RESERVATION action', { conversationId, businessId });

      const phone = this.normalizeWhatsAppNumber(jid);
      const activeReservation = await SupabaseService.getActiveTodayReservationByPhone(phone, businessId);
      if (activeReservation) {
        const statusLabel = this.getReservationStatusLabel(activeReservation.status);
        const displayCodeText = activeReservation.display_code
          ? ` (código *${activeReservation.display_code}*)`
          : '';

        await this.sendWhatsAppMessage(
          businessId,
          jid,
          `⚠️ Ya tenés una reserva activa para hoy${displayCodeText} con estado *${statusLabel}*.` +
            `\n\nNo puedo crear una nueva hasta que la actual finalice o se cancele.` +
            `\n\nSi querés, respondé *CANCELAR* para liberar tu cupo y luego crear otra.`
        );

        logger.info('CREATE_RESERVATION blocked by single-active-reservation policy', {
          conversationId,
          businessId,
          status: activeReservation.status,
          displayCode: activeReservation.display_code,
        });
        return;
      }

      // Start reservation flow
      const draft = await ReservationService.startReservation(conversationId, businessId);
      logger.info('✅ Reservation flow started', { 
        conversationId,
        draftStep: draft.step,
      });
    } catch (error) {
      logger.error('❌ Error handling create reservation', { error, conversationId });
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
      
      // Get or create customer
      const customer = await SupabaseService.getOrCreateCustomer(
        'Unknown',
        phone,
        businessId
      );

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
        logger.info('No active reservation found', { customerId: customer.id });
        return;
      }

      logger.info('Reservation status queried', {
        customerId: customer.id,
      });
    } catch (error) {
      logger.error('Error handling check status', { error, conversationId });
    }
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
      
      // Get customer
      const customer = await SupabaseService.getOrCreateCustomer(
        'Unknown',
        phone,
        businessId
      );

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
      await SupabaseService.updateReservationStatus(
        (reservation as any).id,
        'CANCELLED'
      );

      logger.info('Reservation cancelled', {
        customerId: customer.id,
        displayCode: (reservation as any).display_code,
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

      logger.info('Business info retrieved', {
        businessId,
        name: business.name,
        tablesCount: tables.length,
      });
    } catch (error) {
      logger.error('Error handling info request', { error, conversationId });
    }
  }
}
