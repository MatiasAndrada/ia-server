import { SupabaseConfig } from '../config/supabase';
import { RedisConfig } from '../config/redis';
import { logger } from '../utils/logger';
import { ReservationService } from './reservation.service';
import type { Database } from '../types/supabase';

// Helper types for strict type safety
type CustomersRow = Database['public']['Tables']['customers']['Row'];

export class RealtimeSyncService {
  private static subscriptions: Map<string, any> = new Map();
  private static initialized = false;

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

      // Subscribe to zones table changes
      this.subscribeToZones(client);

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
   * Subscribe to zones table changes
   */
  private static subscribeToZones(client: any): void {
    try {
      const subscription = client
        .channel('public:zones')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'zones',
          },
          async (payload: any) => {
            await this.handleZoneChange(payload);
          }
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            logger.info('✅ Subscribed to zones realtime changes');
          } else if (status === 'CHANNEL_ERROR') {
            logger.error('❌ Error subscribing to zones');
          }
        });

      this.subscriptions.set('zones', subscription);
    } catch (error) {
      logger.error('Failed to subscribe to zones', { error });
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
        // Cache the business
        const businessKey = `business:${businessId}`;
        await redis.setEx(
          businessKey,
          3600, // 1 hour TTL
          JSON.stringify(newBusiness)
        );
        logger.info('💾 Business cached in Redis', { businessId });

        // Refresh zones/tables cache immediately for this business
        const zonesCacheKey = `business:zones:${businessId}`;
        const tablesCacheKey = `business:tables:${businessId}`;
        await ReservationService.loadAndCacheZones(businessId);
        await redis.del(tablesCacheKey);
        logger.info('🔄 Zones/tables cache refreshed', {
          businessId,
          zonesCacheKey,
        });
      } else if (eventType === 'DELETE') {
        // Remove from cache
        const businessKey = `business:${businessId}`;
        const zonesCacheKey = `business:zones:${businessId}`;
        const tablesCacheKey = `business:tables:${businessId}`;
        await redis.del(businessKey);
        await redis.del(zonesCacheKey);
        await redis.del(tablesCacheKey);
        logger.info('🗑️ Business removed from cache', { businessId });
      }
    } catch (error) {
      logger.error('Error handling business change', { error, payload });
    }
  }

  /**
   * Handle zone table changes
   */
  private static async handleZoneChange(payload: any): Promise<void> {
    try {
      const { eventType, new: newZone, old: oldZone } = payload;
      const zone = newZone || oldZone;
      const businessId = zone?.business_id;

      logger.info('📬 Zone change detected', {
        eventType,
        businessId,
        zoneId: zone?.id,
        zoneName: zone?.name,
      });

      if (!businessId) {
        logger.warn('Zone change missing businessId');
        return;
      }

      const redis = RedisConfig.getClient();
      const zonesCacheKey = `business:zones:${businessId}`;
      const tablesCacheKey = `business:tables:${businessId}`;

      // Refresh cache immediately after zone changes
      await ReservationService.loadAndCacheZones(businessId);
      await redis.del(tablesCacheKey);

      logger.info('🔄 Zone cache refreshed for business', {
        businessId,
        zonesCacheKey,
      });
    } catch (error) {
      logger.error('Error handling zone change', { error, payload });
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
      const zonesCacheKey = `business:zones:${businessId}`;
      const tablesCacheKey = `business:tables:${businessId}`;

      // Refresh cache immediately after table changes (including is_occupied)
      await ReservationService.loadAndCacheZones(businessId);
      await redis.del(tablesCacheKey);

      logger.info('🔄 Tables/Zones cache refreshed for business', {
        businessId,
        zonesCacheKey,
      });
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
        position: newEntry?.position,
      });

      // Only process UPDATE events
      if (eventType !== 'UPDATE') {
        logger.info('⏭️ [REALTIME] Skipping non-UPDATE event', { eventType });
        return;
      }

      // Check if new status is NOTIFIED (send notification regardless of previous status)
      const isNotified = newEntry?.status === 'NOTIFIED';
      
      logger.info('🔍 [REALTIME] Status validation', {
        oldStatus: oldEntry?.status,
        newStatus: newEntry?.status,
        isNotified,
        willSendNotification: isNotified,
      });
      
      if (!isNotified) {
        logger.info('⏭️ [REALTIME] Skipping - new status is not NOTIFIED', {
          oldStatus: oldEntry?.status,
          newStatus: newEntry?.status,
        });
        return;
      }

      logger.info('🔔 [REALTIME] ✅ Status changed WAITING → NOTIFIED! Preparing notification...', {
        entryId: newEntry.id,
        businessId: newEntry.business_id,
        customerId: newEntry.customer_id,
        displayCode: newEntry.display_code,
        position: newEntry.position,
        oldStatus: oldEntry.status,
        newStatus: newEntry.status,
      });

      // Import services dynamically to avoid circular dependencies
      const { SupabaseService } = await import('./supabase.service');
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
        phoneLength: customer.phone?.length,
      });

      // Get business data for dynamic messaging
      const business = await SupabaseService.getBusinessById(newEntry.business_id);
      const businessType = business?.type || 'negocio';
      
      logger.info('🏢 [REALTIME] Business data retrieved', {
        businessId: newEntry.business_id,
        businessName: business?.name,
        businessType,
        hasAutoAccept: business?.auto_accept_reservations,
      });

      // Get zone name if table is assigned
      let zoneName = 'Zona asignada';
      if (newEntry.table_id) {
        logger.info('🔍 [REALTIME] Fetching zone name for table', {
          tableId: newEntry.table_id,
        });
        
        try {
          const { data: tableData, error: tableError } = await supabaseClient
            .from('tables')
            .select('zone_id, zones(name)')
            .eq('id', newEntry.table_id)
            .single();
          
          if (!tableError && tableData && tableData.zones) {
            zoneName = (tableData.zones as any).name || zoneName;
            logger.info('✅ [REALTIME] Zone name retrieved', {
              zoneName,
              tableId: newEntry.table_id,
            });
          } else {
            logger.warn('⚠️ [REALTIME] Could not fetch zone name', {
              tableId: newEntry.table_id,
              error: tableError,
            });
          }
        } catch (error) {
          logger.warn('⚠️ [REALTIME] Error fetching zone name', { error });
        }
      } else {
        logger.info('ℹ️ [REALTIME] No table assigned, using default zone name');
      }

      // Build confirmation message
      const confirmationMessage = `✅ *¡Tu reserva está CONFIRMADA!*

📋 Código: *${newEntry.display_code}*
🏢 Zona: ${zoneName}

✨ Tu ${businessType} te espera! Puedes dirigirte cuando quieras.`;

      logger.info('📝 [REALTIME] Confirmation message built', {
        messageLength: confirmationMessage.length,
        messagePreview: confirmationMessage.substring(0, 80),
        recipient: customer.phone,
        businessId: newEntry.business_id,
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
        confirmationMessage
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
