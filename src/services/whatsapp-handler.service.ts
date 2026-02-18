import { BaileysService } from './baileys.service';
import { agentService } from './agent.service';
import { ReservationService } from './reservation.service';
import { SupabaseService } from './supabase.service';
import { SupabaseConfig } from '../config/supabase';
import { agentRegistry } from '../agents';
import { BaileysMessage, ReservationDraft } from '../types';
import { logger } from '../utils/logger';

type ActiveReservationSnapshot = {
  status: 'WAITING' | 'NOTIFIED';
  displayCode: string | null;
};

export class WhatsAppHandler {
  private baileysService: BaileysService;
  private lastSentByChat: Map<string, { text: string; timestamp: number }> = new Map();

  constructor(baileysService: BaileysService) {
    this.baileysService = baileysService;
  }

  /**
   * Process incoming WhatsApp message
   */
  async processMessage(message: BaileysMessage): Promise<void> {
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

      // Check if business WhatsApp is active
      const isActive = await SupabaseService.isBusinessWhatsAppActive(businessId);
      if (!isActive) {
        await this.sendWhatsAppMessage(
          businessId,
          from,
          'Lo siento, nuestro servicio de WhatsApp no está disponible en este momento. Por favor intenta más tarde.'
        );
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
      }
      
      // Get business details for context
      const business = await SupabaseService.getBusinessById(businessId);
      const businessName = business?.name || 'el restaurante';
      
      // CRITICAL FIX: If user is providing party size, extract it and fetch zones BEFORE building context
      // This ensures the agent receives correct zone information and doesn't hallucinate
      let detectedPartySize: number | null = null;
      if (draft && draft.step === 'party_size') {
        detectedPartySize = this.extractNumber(messageText);
        if (detectedPartySize &&  detectedPartySize > 0 && detectedPartySize <= 50) {
          logger.info('Party size detected before context build', {
            businessId,
            conversationId,
            partySize: detectedPartySize,
          });
        }
      }
      
      // Build context
      const context: any = {
        businessId,
        businessName,
        phone,
        hasActiveDraft: !!draft,
      };

      // OPTIMIZED: Always try to get zones from Redis cache (independent of draft state)
      // This ensures agent always has zone info available, even on first message
      const cachedZones = await ReservationService.getCachedZones(businessId);
      
      logger.info('Redis cache zones status', {
        businessId,
        hasCachedZones: !!cachedZones,
        zonesCount: cachedZones?.zones.length || 0,
        tablesCount: cachedZones?.tables.length || 0,
      });

      if (cachedZones) {
        // Store all zones info in context (for agent to know what's available)
        context.allAvailableZones = cachedZones.zones.map(z => z.name);
      }

      if (draft) {
        context.currentStep = draft.step;
        context.draftData = {
          customerName: draft.customerName,
          partySize: draft.partySize,
          selectedZoneId: draft.selectedZoneId,
        };

        // Filter zones by party size if we have both cached zones and party size
        const partySizeToUse = detectedPartySize || draft.partySize;
        if (partySizeToUse && cachedZones) {
          // Filter zones from Redis cache by party size
          const zonesMap = ReservationService.filterCachedZonesByPartySize(cachedZones, partySizeToUse);
          
          const availableZones = Array.from(zonesMap.keys());
          context.availableZones = availableZones;
          context.availableZonesFormatted = availableZones
            .map((zone, idx) => `${idx + 1}. ${zone}`)
            .join('\n');
          
          logger.info('Available zones filtered from Redis cache', {
            conversationId,
            partySize: partySizeToUse,
            zonesCount: availableZones.length,
            zones: availableZones,
          });
        }
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
              !this.isPostReservationCourtesyMessage(messageText);
            
            if (isAskingForName && looksLikeName) {
              logger.info('🎬 Auto-creating reservation draft', { conversationId, businessId, userName: messageText });
              
              // Create draft and set customer name
              await ReservationService.startReservation(conversationId, businessId);
              await ReservationService.setCustomerName(conversationId, messageText.trim());
              
              // Update local draft reference
              draft = await ReservationService.getDraft(conversationId);
              
              // Send confirmation message and ask for party size immediately
              const nameConfirmMsg = `✅ Perfecto, *${messageText.trim()}*!\n\n¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4, 6, etc.`;
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
      
      // Log context before calling agent to debug zone availability
      logger.info('Agent context snapshot', {
        conversationId,
        businessId,
        currentStep: context.currentStep,
        hasDraft: !!draft,
        partySize: context.draftData?.partySize,
        hasAvailableZones: !!context.availableZones,
        availableZonesCount: context.availableZones?.length || 0,
        hasAllZones: !!context.allAvailableZones,
        allZonesCount: context.allAvailableZones?.length || 0,
      });

      // Context snapshot already logged with logger.info above
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
        const isTestEnv = process.env.NODE_ENV === 'test';
        const testRecipient = isTestEnv ? this.baileysService.getSelfJid(businessId) : null;
        const recipients = new Set<string>([from]);

        if (testRecipient) {
          recipients.add(testRecipient);
        }

        for (const recipient of recipients) {
          await this.sendWhatsAppMessage(businessId, recipient, agentResponse.response);
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
          selectedZone: draft.selectedZoneId,
        });
        const customMessageSent = await this.processDraftStep(draft, messageText, conversationId, businessId, jid);
        return customMessageSent;
      }

      // Process explicit actions
      switch (action) {
        case 'CREATE_RESERVATION':
          await this.handleCreateReservation(conversationId, businessId);
          break;

        case 'CHECK_STATUS':
          await this.handleCheckStatus(businessId, jid, conversationId);
          break;

        case 'CONFIRM_ARRIVAL':
          await this.handleConfirmArrival(businessId, jid, conversationId);
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
        case 'name':
          // User provided their name
          logger.info('📝 Setting customer name', { conversationId, name: messageText });
          const updatedDraft = await ReservationService.setCustomerName(conversationId, messageText);
          logger.info('✅ Customer name set', { 
            conversationId, 
            name: messageText,
            nextStep: updatedDraft?.step,
          });
          
          // Send confirmation and ask for party size
          const nameConfirmMsg = `✅ Perfecto, *${messageText}*!\n\n¿Para cuántas personas es la reserva?\n\nEjemplo: 2, 4, 6, etc.`;
          await this.sendWhatsAppMessage(businessId, jid, nameConfirmMsg);
          return true;
          break;

        case 'party_size':
          // User provided party size
          logger.info('📝 Extracting party size', { conversationId, messageText });
          const partySize = this.extractNumber(messageText);
          logger.info('🔢 Party size extracted', { conversationId, partySize });

          if (partySize && partySize > 0 && partySize <= 50) {
            await ReservationService.setPartySize(conversationId, partySize);
            logger.info('✅ Party size set', { conversationId, partySize });

            // OPTIMIZED: Use zones from Redis cache
            const cachedZones = await ReservationService.getCachedZones(businessId);
            
            if (!cachedZones) {
              const errorMessage = 'Lo siento, estoy teniendo problemas para obtener las zonas disponibles. Por favor intenta de nuevo.';
              await this.sendWhatsAppMessage(businessId, jid, errorMessage);
              return false;
            }
            
            const zonesMap = ReservationService.filterCachedZonesByPartySize(cachedZones, partySize);
            
            const availableZones = Array.from(zonesMap.keys());
            logger.info('📍 Available zones with tables', { 
              businessId, 
              partySize,
              zonesCount: availableZones.length,
              zones: availableZones,
            });
            
            if (availableZones.length === 0) {
              // No tables available - send message
              logger.warn('No zones available for party size', {
                conversationId,
                partySize,
              });
              
              const noTablesMessage = `Lo siento, no tenemos mesas disponibles para ${partySize} personas en este momento. ¿Te gustaría que te agreguemos a la lista de espera?`;
              await this.sendWhatsAppMessage(businessId, jid, noTablesMessage);
              
            } else {
              // Generate zone selection message with REAL zones
              logger.info('📤 Generating zone selection message with real zones', {
                conversationId,
                zones: availableZones,
              });
              
              const zonesFormatted = availableZones
                .map((zone, idx) => `${idx + 1}. *${zone}*`)
                .join('\n');
              
              let zoneMessage: string;
              if (availableZones.length === 1) {
                zoneMessage = `✅ Perfecto! Tenemos disponible la zona *${availableZones[0]}* para ${partySize} personas.\n\n¿Confirmas esta zona? (Responde SÍ o NO)`;
              } else {
                zoneMessage = `✅ Tenemos ${availableZones.length} zonas disponibles para ${partySize} personas:\n\n${zonesFormatted}\n\nResponde con el *número* o *nombre* de la zona que prefieres.`;
              }
              
              logger.info('🔔 About to send zone selection message', {
                conversationId,
                businessId,
                jid,
                messagePreview: zoneMessage.substring(0, 100),
                messageLength: zoneMessage.length,
              });
              
              await this.sendWhatsAppMessage(businessId, jid, zoneMessage);
              
              // Return true to skip agent response (we sent custom message)
              logger.info('🚫 Skipping agent response - custom zone message sent', { conversationId });
              return true;
            }
          } else {
            // Invalid party size - ask again
            logger.warn('Invalid party size provided', { conversationId, messageText });
            
            const invalidMessage = '❌ Por favor indica con un *número* cuántas personas son.\n\nEjemplo: 2, 4, 6, etc.';
            await this.sendWhatsAppMessage(businessId, jid, invalidMessage);
            
            // Return true to skip agent response (we sent custom message)
            return true;
          }
          break;

        case 'zone_selection':
          const draft2 = await ReservationService.getDraft(conversationId);
          if (!draft2 || !draft2.partySize) {
            logger.warn('Draft missing party size for zone selection', { conversationId });
            const errorMsg = 'Lo siento, hubo un problema. Por favor vuelve a empezar diciendo HOLA.';
            await this.sendWhatsAppMessage(businessId, jid, errorMsg);
            return true;
          }

          // OPTIMIZED: Use zones from Redis cache
          const cachedZonesForSelect = await ReservationService.getCachedZones(businessId);
          
          if (!cachedZonesForSelect) {
            const errorMsg = 'Lo siento, estoy teniendo problemas para obtener las zonas. Por favor intenta de nuevo.';
            await this.sendWhatsAppMessage(businessId, jid, errorMsg);
            return true;
          }
          
          const zonesMap2 = ReservationService.filterCachedZonesByPartySize(cachedZonesForSelect, draft2.partySize);
          
          const availableZones2 = Array.from(zonesMap2.keys());
          
          // Check if user is confirming (yes/si/ok) when there's only one zone
          const isConfirmation = /^(s[ií]|yes|ok|dale|confirmo|confirmar)$/i.test(messageText.trim());
          
          let selectedZone: string | null = null;
          
          if (availableZones2.length === 1 && isConfirmation) {
            // User confirmed the single available zone
            selectedZone = availableZones2[0];
            logger.info('🎯 User confirmed single zone', { conversationId, zone: selectedZone });
          } else {
            // User selected from multiple zones
            selectedZone = this.findZoneByMessage(messageText, availableZones2);
          }

          if (selectedZone) {
            logger.info('✅ Zone selected/confirmed', { conversationId, zone: selectedZone });
            await ReservationService.selectZone(conversationId, selectedZone);

            // Create reservation
            logger.info('💾 Creating reservation', { conversationId, businessId, jid });
            await this.createAndNotifyReservation(conversationId, businessId, jid);
            
            // Return TRUE to skip agent response (reservation confirmation was sent)
            return true;
          } else {
            logger.warn('Zone selection not found in available zones', {
              conversationId,
              messageText,
              availableZones: availableZones2,
            });
            
            // Send error message with available zones
            const zonesFormatted = availableZones2
              .map((zone, idx) => `${idx + 1}. *${zone}*`)
              .join('\n');
            
            const invalidZoneMsg = `❌ No encontré esa zona. Por favor elige una de estas opciones:\n\n${zonesFormatted}\n\nResponde con el *número* o *nombre* de la zona.`;
            await this.sendWhatsAppMessage(businessId, jid, invalidZoneMsg);
            return true;
          }
          break;

        case 'confirmation':
          // User confirmed or already processed
          break;

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
        logger.info('Waitlist entry created successfully', { 
          conversationId,
          entryId: result.waitlistEntry.id,
          position: result.waitlistEntry.position,
          status: result.waitlistEntry.status,
          displayCode: result.waitlistEntry.display_code,
        });

        // Build and send confirmation message to customer via WhatsApp
        const entry = result.waitlistEntry;
        
        // Get zone name from draft (we stored the zone NAME, not ID)
        const zoneName = draft.selectedZoneId || 'Asignada';
        
        // Get business configuration for conditional messaging
        const business = await SupabaseService.getBusinessById(businessId);
        const autoAccept = business?.auto_accept_reservations ?? false;
        const businessType = business?.type || 'negocio';
        
        logger.info('Building confirmation message', {
          businessId,
          autoAccept,
          businessType,
          status: entry.status,
          displayCode: entry.display_code,
        });

        let confirmationMessage: string;

        if (autoAccept && entry.status === 'NOTIFIED') {
          // Auto-accepted reservation - customer can go directly
          confirmationMessage = `✅ *¡Reserva CONFIRMADA!*

👤 Nombre: ${draft.customerName || 'Cliente'}
👥 Personas: ${draft.partySize || entry.party_size}
🏢 Zona: ${zoneName}
📋 Código: *${entry.display_code}*

✨ Tu ${businessType} te espera! Puedes dirigirte cuando quieras.

Si necesitas cancelar, responde CANCELAR.`;
        } else {
          // Manual approval required - customer must wait for confirmation
          confirmationMessage = `⏳ *Reserva RECIBIDA*

👤 Nombre: ${draft.customerName || 'Cliente'}
👥 Personas: ${draft.partySize || entry.party_size}
🏢 Zona: ${zoneName}
📋 Código: *${entry.display_code}*

⏰ Le notificaremos cuando el ${businessType} confirme su reserva.

Si necesitas cancelar, responde CANCELAR.`;
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
      const success = await this.baileysService.sendMessage(businessId, to, message);
      
      if (!success) {
        logger.error('Failed to send WhatsApp message', { businessId, to });
        return;
      }

      this.lastSentByChat.set(to, {
        text: message,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Error sending WhatsApp message', { error, businessId, to });
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
      // TEMP: Procesar TODOS los mensajes para debug
      logger.info('TEST MODE: Processing all messages', { businessId, from, fromMe });
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
        .in('status', ['WAITING', 'NOTIFIED'])
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
        status: reservationData.status as 'WAITING' | 'NOTIFIED',
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
   * Find zone by user message (number or name)
   */
  private findZoneByMessage(message: string, zones: string[]): string | null {
    const lowerMessage = message.toLowerCase().trim();

    // Try to match by number (1, 2, 3, etc.)
    const numberMatch = this.extractNumber(message);
    if (numberMatch && numberMatch > 0 && numberMatch <= zones.length) {
      return zones[numberMatch - 1];
    }

    // Try to match by name
    return zones.find(zone => 
      zone.toLowerCase().includes(lowerMessage) ||
      lowerMessage.includes(zone.toLowerCase())
    ) || null;
  }

  /**
   * 🎯 ACTION: Create Reservation - Start the multi-step flow
   */
  private async handleCreateReservation(
    conversationId: string,
    businessId: string
  ): Promise<void> {
    try {
      logger.info('🎯 Starting CREATE_RESERVATION action', { conversationId, businessId });

      // Get business name for greeting
      const business = await SupabaseService.getBusinessById(businessId);
      const businessName = business?.name || 'nuestro restaurante';
      logger.info('✅ Business fetched', { businessId, businessName });

      // Verify there are available zones
      const zones = await ReservationService.getAvailableZones(businessId);
      logger.info('📍 Zones fetched', { businessId, zonesCount: zones.length, zones });

      if (zones.length === 0) {
        logger.warn('⚠️ No zones available for reservation', { businessId });
        // Agent will handle this response
        return;
      }

      // Start reservation flow
      const draft = await ReservationService.startReservation(conversationId, businessId);
      logger.info('✅ Reservation flow started', { 
        conversationId, 
        businessName,
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
   * ✋ ACTION: Confirm Arrival - Update status to NOTIFIED
   */
  private async handleConfirmArrival(
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
        logger.warn('Customer not found for arrival confirmation', { businessId, phone });
        return;
      }

      // Find active reservation
      const client = SupabaseConfig.getClient();
      const { data: reservation, error } = await client
        .from('waitlist_entries')
        .select('*')
        .eq('business_id', businessId)
        .eq('customer_id', customer.id)
        .eq('status', 'WAITING')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !reservation) {
        logger.warn('No active reservation for arrival confirmation', { customerId: customer.id });
        return;
      }

      // Update status to NOTIFIED
      await SupabaseService.updateReservationStatus(
        (reservation as any).id,
        'NOTIFIED'
      );

      logger.info('Arrival confirmed', {
        customerId: customer.id,
        displayCode: (reservation as any).display_code,
      });
    } catch (error) {
      logger.error('Error handling confirm arrival', { error, conversationId });
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
        .in('status', ['WAITING', 'NOTIFIED'])
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
