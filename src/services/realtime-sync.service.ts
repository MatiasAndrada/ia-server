import { SupabaseConfig } from '../config/supabase';
import { RedisConfig } from '../config/redis';
import { logger } from '../utils/logger';
import type { Database } from '../types/supabase';

// Helper types for strict type safety
type CustomersRow = Database['public']['Tables']['customers']['Row'];

export class RealtimeSyncService {
  private static subscriptions: Map<string, any> = new Map();
  private static initialized = false;

  /**
   * Returns true when a businesses UPDATE affects reservation-relevant data
    * and therefore requires reservation cache refresh.
   */
  private static shouldRefreshBusinessCaches(oldBusiness: any, newBusiness: any): boolean {
    if (!oldBusiness || !newBusiness) {
      return true;
    }

    const keys = new Set([...Object.keys(oldBusiness), ...Object.keys(newBusiness)]);
    const changedKeys = Array.from(keys).filter((key) => oldBusiness[key] !== newBusiness[key]);

    if (changedKeys.length === 0) {
      return false;
    }

    // Only structural business fields should trigger expensive
    // reservation cache reloads.
    const structuralKeys = new Set([
      'name',
      'type',
      'supports_tables',
      'requires_party_size',
      'public_screen_enabled',
      'ai_chat_enabled',
      'auto_accept_reservations',
      'language',
      'manual_table_occupancy_enabled',
      'public_join_enabled',
    ]);

    return changedKeys.some((key) => structuralKeys.has(key));
  }

  /**
   * Initialize realtime synchronization for business data
   */
  static async initializeRealtimeSync(): Promise<void> {
    if (this.initialized) {
      logger.info('Realtime sync already initialized');
      return;
    }

    try {
      logger.info('🔄 Initializing realtime synchronization...');

      const client = SupabaseConfig.getClient();

      // Subscribe to businesses table changes
      this.subscribeToBusinesses(client);

      // Subscribe to tables table changes
      this.subscribeTables(client);

      // Subscribe to waitlist_entries table changes (for status notifications)
      this.subscribeToWaitlistEntries(client);

      this.initialized = true;
      logger.info('✅ Realtime sync initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize realtime sync', { error });
      // Don't throw - sync is optional, system should work without it
    }
  }

  /**
   * Subscribe to businesses table changes
   */
  private static subscribeToBusinesses(client: any): void {
    try {
      const subscription = client
        .channel('public:businesses')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'businesses',
          },
          async (payload: any) => {
            await this.handleBusinessChange(payload);
          }
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            logger.info('✅ Subscribed to businesses realtime changes');
          } else if (status === 'CHANNEL_ERROR') {
            logger.error('❌ Error subscribing to businesses');
          }
        });

      this.subscriptions.set('businesses', subscription);
    } catch (error) {
      logger.error('Failed to subscribe to businesses', { error });
    }
  }

  /**
   * Subscribe to tables table changes
   */
  private static subscribeTables(client: any): void {
    try {
      const subscription = client
        .channel('public:tables')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tables',
          },
          async (payload: any) => {
            await this.handleTablesChange(payload);
          }
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            logger.info('✅ Subscribed to tables realtime changes');
          } else if (status === 'CHANNEL_ERROR') {
            logger.error('❌ Error subscribing to tables');
          }
        });

      this.subscriptions.set('tables', subscription);
    } catch (error) {
      logger.error('Failed to subscribe to tables', { error });
    }
  }

  /**
   * Subscribe to waitlist_entries table changes for auto-notifications
   */
  private static subscribeToWaitlistEntries(client: any): void {
    try {
      logger.info('🔌 [REALTIME] Setting up waitlist_entries subscription for WAITING → NOTIFIED notifications...');
      
      const subscription = client
        .channel('public:waitlist_entries')
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'waitlist_entries',
          },
          async (payload: any) => {
            logger.info('📨 [REALTIME] *** Waitlist entry UPDATE received ***', {
              timestamp: new Date().toISOString(),
              hasPayload: !!payload,
            });
            await this.handleWaitlistStatusChange(payload);
          }
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            logger.info('✅ [REALTIME] Successfully subscribed to waitlist_entries - listening for status changes!', {
              channel: 'public:waitlist_entries',
              event: 'UPDATE',
              purpose: 'Auto-send WhatsApp notifications on WAITING → NOTIFIED',
            });
          } else if (status === 'CHANNEL_ERROR') {
            logger.error('❌ [REALTIME] Error subscribing to waitlist_entries', {
              status,
            });
          } else {
            logger.info('📡 [REALTIME] Waitlist subscription status update', {
              status,
            });
          }
        });

      this.subscriptions.set('waitlist_entries', subscription);
      
      logger.info('💾 [REALTIME] Waitlist subscription stored in registry');
    } catch (error) {
      logger.error('❌ [REALTIME] Failed to subscribe to waitlist_entries', { error });
    }
  }

  /**
   * Handle business table changes
   */
  private static async handleBusinessChange(payload: any): Promise<void> {
    try {
      const { eventType, new: newBusiness, old: oldBusiness } = payload;
      const redis = RedisConfig.getClient();

      const businessId = newBusiness?.id || oldBusiness?.id;

      logger.info('📬 Business change detected', {
        eventType,
        businessId,
      });

      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        const businessKey = `business:${businessId}`;

        // For UPDATE events, Supabase old row can be partial (e.g. only id)
        // depending on replica identity settings. Use Redis snapshot as
        // fallback to avoid false-positive structural diffs.
        let previousBusinessSnapshot: any = oldBusiness;
        if (eventType === 'UPDATE') {
          const cachedBusiness = await redis.get(businessKey);
          if (cachedBusiness) {
            try {
              previousBusinessSnapshot = JSON.parse(cachedBusiness);
            } catch (error) {
              logger.warn('Failed to parse cached business snapshot', {
                businessId,
                error,
              });
            }
          }
        }

        // Cache the business
        await redis.setEx(
          businessKey,
          3600, // 1 hour TTL
          JSON.stringify(newBusiness)
        );
        logger.info('💾 Business cached in Redis', { businessId });

        const shouldRefreshCaches =
          eventType === 'INSERT' ||
          this.shouldRefreshBusinessCaches(previousBusinessSnapshot, newBusiness);

        if (shouldRefreshCaches) {
          const tablesCacheKey = `business:tables:${businessId}`;
          await redis.del(tablesCacheKey);
          logger.info('🔄 Tables cache cleared', { businessId });
        } else {
          logger.info('⏭️ Skipping cache refresh for technical business update', { businessId });
        }
      } else if (eventType === 'DELETE') {
        // Remove from cache
        const businessKey = `business:${businessId}`;
        const tablesCacheKey = `business:tables:${businessId}`;
        await redis.del(businessKey);
        await redis.del(tablesCacheKey);
        logger.info('🗑️ Business removed from cache', { businessId });
      }
    } catch (error) {
      logger.error('Error handling business change', { error, payload });
    }
  }

  /**
   * Handle tables table changes
   */
  private static async handleTablesChange(payload: any): Promise<void> {
    try {
      const { eventType, new: newTable, old: oldTable } = payload;
      const table = newTable || oldTable;
      const businessId = table?.business_id;

      logger.info('📬 Table change detected', {
        eventType,
        businessId,
        tableId: table?.id,
        tableNumber: table?.table_number,
      });

      if (!businessId) {
        logger.warn('Table change missing businessId');
        return;
      }

      const redis = RedisConfig.getClient();
      const tablesCacheKey = `business:tables:${businessId}`;

      await redis.del(tablesCacheKey);

      logger.info('🔄 Tables cache cleared for business', { businessId });
    } catch (error) {
      logger.error('Error handling tables change', { error, payload });
    }
  }

  /**
   * Handle waitlist status changes - send WhatsApp notification when status changes to NOTIFIED
   */
  private static async handleWaitlistStatusChange(payload: any): Promise<void> {
    try {
      logger.info('📨 [REALTIME] Waitlist UPDATE event received', {
        eventType: payload.eventType,
        payloadKeys: Object.keys(payload),
      });

      const { eventType, new: newEntry, old: oldEntry } = payload;

      logger.info('📊 [REALTIME] Analyzing status change', {
        eventType,
        entryId: newEntry?.id,
        businessId: newEntry?.business_id,
        customerId: newEntry?.customer_id,
        oldStatus: oldEntry?.status,
        newStatus: newEntry?.status,
        displayCode: newEntry?.display_code,
      });

      // Only process UPDATE events
      if (eventType !== 'UPDATE') {
        logger.info('⏭️ [REALTIME] Skipping non-UPDATE event', { eventType });
        return;
      }

      // Check if new status is CONFIRMED or NOTIFIED
      const isConfirmed = newEntry?.status === 'CONFIRMED';
      // Keep backward compat: NOTIFIED still sends the confirmation message
      const isNotified = newEntry?.status === 'NOTIFIED';
      
      logger.info('🔍 [REALTIME] Status validation', {
        oldStatus: oldEntry?.status,
        newStatus: newEntry?.status,
        isConfirmed,
        isNotified,
      });
      
      if (!isConfirmed && !isNotified) {
        logger.info('⏭️ [REALTIME] Skipping - status is not CONFIRMED or NOTIFIED', {
          newStatus: newEntry?.status,
        });
        return;
      }

      // Skip duplicate notifications only for the same status.
      // CONFIRMED and NOTIFIED must not block each other.
      try {
        if (RedisConfig.isReady()) {
          const redisClient = RedisConfig.getClient();
          const dedupKey = `wa:status:sent:${newEntry.id}:${newEntry.status}`;
          const alreadySent = await redisClient.get(dedupKey);
          if (alreadySent) {
            logger.info('⏭️ [REALTIME] Skipping duplicate status notification', {
              entryId: newEntry.id,
              businessId: newEntry.business_id,
              status: newEntry.status,
            });
            return;
          }
        }
      } catch (error) {
        logger.warn('⚠️ [REALTIME] Failed dedup check for confirmation send', {
          entryId: newEntry?.id,
          businessId: newEntry?.business_id,
          error,
        });
      }

      logger.info('🔔 [REALTIME] ✅ Status changed! Preparing notification...', {
        entryId: newEntry.id,
        businessId: newEntry.business_id,
        customerId: newEntry.customer_id,
        displayCode: newEntry.display_code,
        oldStatus: oldEntry.status,
        newStatus: newEntry.status,
      });

      // Import services dynamically to avoid circular dependencies
      const { BaileysService } = await import('./baileys.service');
      const { SupabaseConfig } = await import('../config/supabase');

      logger.info('📦 [REALTIME] Services imported, fetching customer data...', {
        customerId: newEntry.customer_id,
      });

      // Get customer data directly from Supabase
      const supabaseClient = SupabaseConfig.getClient();
      const { data: customerData, error: customerError } = await supabaseClient
        .from('customers')
        .select('*')
        .eq('id', newEntry.customer_id)
        .single();

      if (customerError || !customerData) {
        logger.error('❌ [REALTIME] Customer not found for waitlist notification', {
          customerId: newEntry.customer_id,
          error: customerError,
          errorDetails: customerError ? JSON.stringify(customerError) : 'No data',
        });
        return;
      }

      const customer = customerData as CustomersRow;
      
      logger.info('✅ [REALTIME] Customer data retrieved', {
        customerId: customer.id,
        customerName: customer.name,
        phone: customer.phone,
      });

      // Build message based on new status
      let notificationMessage: string;

      if (isNotified) {
        // Paso 6: Mesa disponible (NOTIFIED)
        notificationMessage =
          `🚀 ¡Es tu momento!\n` +
          `Tu mesa está disponible.\n` +
          `Podés ocuparla dentro de los próximos 10 minutos.\n` +
          `Luego de ese tiempo, la reserva podría liberarse.`;
      } else {
        // Paso 5: Reserva CONFIRMADA (CONFIRMED o NOTIFIED legacy)
        notificationMessage =
          `✅ ¡Tu reserva está CONFIRMADA!\n\n` +
          `👤 Nombre: ${customer.name}\n` +
          `👥 Personas: ${newEntry.party_size}\n` +
          `📁 Código de reserva: *${newEntry.display_code}*\n\n` +
          `✨ Te avisaremos cuando falten 10 minutos para que puedas ocupar tu mesa.\n` +
          `Apreciamos tu puntualidad.`;
      }

      logger.info('📝 [REALTIME] Notification message built', {
        messageLength: notificationMessage.length,
        messagePreview: notificationMessage.substring(0, 80),
        recipient: customer.phone,
        businessId: newEntry.business_id,
        status: newEntry.status,
      });

      // Try to get the correct WhatsApp JID from Redis cache
      // (cached when user sends messages, ensures correct @lid vs @s.whatsapp.net)
      let recipientJid = customer.phone;
      try {
        const { RedisConfig } = await import('../config/redis');
        const redisClient = RedisConfig.getClient();
        const jidMappingKey = `jid:${newEntry.business_id}:${customer.phone}`;
        const cachedJid = await redisClient.get(jidMappingKey);
        
        if (cachedJid) {
          recipientJid = cachedJid;
          logger.info('✅ [REALTIME] Using cached JID for correct delivery', {
            phone: customer.phone,
            cachedJid,
            businessId: newEntry.business_id,
          });
        } else {
          logger.warn('⚠️ [REALTIME] No cached JID found, using phone number (may not deliver correctly)', {
            phone: customer.phone,
            willUseDefaultDomain: true,
          });
        }
      } catch (error) {
        logger.warn('⚠️ [REALTIME] Failed to get cached JID, using phone number', {
          error,
          phone: customer.phone,
        });
      }

      // Send WhatsApp notification
      logger.info('📤 [REALTIME] Attempting to send WhatsApp notification...', {
        businessId: newEntry.business_id,
        phone: customer.phone,
        recipientJid,
        entryId: newEntry.id,
        displayCode: newEntry.display_code,
      });

      const baileys = BaileysService.getInstance();
      const sent = await baileys.sendMessage(
        newEntry.business_id,
        recipientJid,
        notificationMessage
      );

      logger.info('📊 [REALTIME] WhatsApp send attempt result', {
        sent,
        type: typeof sent,
        businessId: newEntry.business_id,
        phone: customer.phone,
        recipientJid,
        entryId: newEntry.id,
      });

      if (sent) {
        logger.info('✅ [REALTIME] WhatsApp notification sent successfully!', {
          businessId: newEntry.business_id,
          phone: customer.phone,
          recipientJid,
          entryId: newEntry.id,
          displayCode: newEntry.display_code,
          customerName: customer.name,
        });

        // Mark this status notification as sent to avoid duplicate sends.
        try {
          if (RedisConfig.isReady()) {
            const redisClient = RedisConfig.getClient();
            await redisClient.setEx(
              `wa:status:sent:${newEntry.id}:${newEntry.status}`,
              300,
              '1'
            );
          }
        } catch (error) {
          logger.warn('⚠️ [REALTIME] Failed to mark status notification dedup key', {
            entryId: newEntry.id,
            businessId: newEntry.business_id,
            status: newEntry.status,
            error,
          });
        }
      } else {
        logger.error('❌ [REALTIME] Failed to send WhatsApp notification', {
          businessId: newEntry.business_id,
          phone: customer.phone,
          recipientJid,
          entryId: newEntry.id,
          displayCode: newEntry.display_code,
          customerName: customer.name,
        });
      }
    } catch (error) {
      logger.error('❌ [REALTIME] Error in handleWaitlistStatusChange', { 
        error,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
        payload: JSON.stringify(payload).substring(0, 500),
      });
    }
  }

  /**
   * Unsubscribe from all realtime channels
   */
  static async cleanup(): Promise<void> {
    try {
      const client = SupabaseConfig.getClient();

      for (const [key, subscription] of this.subscriptions.entries()) {
        await client.removeChannel(subscription);
        logger.info('Unsubscribed from realtime channel', { channel: key });
      }

      this.subscriptions.clear();
      this.initialized = false;
      logger.info('✅ Realtime sync cleanup complete');
    } catch (error) {
      logger.error('Error cleaning up realtime sync', { error });
    }
  }

  /**
   * Check if realtime sync is initialized
   */
  static isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get subscription count
   */
  static getSubscriptionCount(): number {
    return this.subscriptions.size;
  }
}
