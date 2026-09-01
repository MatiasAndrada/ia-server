import { SupabaseConfig } from '../config/supabase.js';
import { RedisConfig } from '../config/redis.js';
import { logger, logEvent } from '../utils/logger.js';
import { withLogContext } from '../utils/log-context.js';
import { throttle } from '../utils/log-throttle.js';
import { runWithLanguage } from '../i18n/index.js';
import { resolveLanguage } from '../i18n/language-store.js';
import type { Database } from '../types/supabase.js';
import * as templates from '../utils/message-templates.js';
import {
  describeScheduledAtUtc,
  describeScheduledAtUtcCompact,
  nowInBuenosAires,
} from '../utils/reservation-datetime.js';
import {
  createdNotificationKey,
  markNotified,
  statusNotificationKey,
  wasAlreadyNotified,
} from '../utils/notification-dedup.js';
import { BaileysService } from './baileys.service.js';
import { SupabaseService } from './supabase.service.js';
import { openRouterService } from './openrouter.service.js';

// Helper types for strict type safety
type CustomersRow = Database['public']['Tables']['customers']['Row'];

export class RealtimeSyncService {
  private static subscriptions: Map<string, any> = new Map();
  private static initialized = false;
  private static waitlistChannelHadError = false;

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
      logger.debug('Realtime sync already initialized');
      return;
    }

    try {
      logger.debug('Initializing realtime synchronization');

      const client = SupabaseConfig.getClient();

      // Subscribe to businesses table changes
      this.subscribeToBusinesses(client);

      // Subscribe to tables table changes
      this.subscribeTables(client);

      // Subscribe to waitlist_entries table changes (for status notifications)
      this.subscribeToWaitlistEntries(client);

      // Subscribe to business_blocked_dates changes (pre-generate reason_message)
      this.subscribeToBlockedDates(client);

      this.initialized = true;
      logger.debug('Realtime sync initialized', { channels: this.subscriptions.size });
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
            logEvent('info', 'realtime.subscribed', { channel: 'businesses' });
          } else if (status === 'CHANNEL_ERROR') {
            // Supabase reintenta en bucle: sin throttle esto llegó a ~1000
            // líneas idénticas en el log.
            const t = throttle('realtime.lost:businesses', 60_000);
            if (t.allowed) {
              logEvent('error', 'realtime.lost', { channel: 'businesses', suppressed: t.suppressed });
            }
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
            logEvent('info', 'realtime.subscribed', { channel: 'tables' });
          } else if (status === 'CHANNEL_ERROR') {
            const t = throttle('realtime.lost:tables', 60_000);
            if (t.allowed) {
              logEvent('error', 'realtime.lost', { channel: 'tables', suppressed: t.suppressed });
            }
          }
        });

      this.subscriptions.set('tables', subscription);
    } catch (error) {
      logger.error('Failed to subscribe to tables', { error });
    }
  }

  /**
   * Subscribe to waitlist_entries table changes for auto-notifications.
   * Handles:
   *   - INSERT from panel (source = PANEL, status WAITING or SEATED): sends reservation confirmation
   *   - UPDATE to CONFIRMED/NOTIFIED: sends status notification
   * On reconnection after a CHANNEL_ERROR, runs recovery to catch missed events.
   */
  private static subscribeToWaitlistEntries(client: any): void {
    try {
      logger.debug('Setting up waitlist_entries subscription');

      const subscription = client
        .channel('public:waitlist_entries')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'waitlist_entries',
          },
          async (payload: any) => {
            logger.debug('INSERT received on waitlist_entries', {
              entryId: payload?.new?.id,
              source: payload?.new?.source,
              status: payload?.new?.status,
            });
            // Handle DASHBOARD inserts directly.
            // For AI_CHAT inserts the WhatsApp handler already sent the confirmation;
            // only use realtime as a fallback if that send was missed (dedup check).
            await withLogContext(
              { businessId: payload?.new?.business_id, entryId: payload?.new?.id },
              () => this.handleNewEntryNotification(payload)
            );
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'waitlist_entries',
          },
          async (payload: any) => {
            await withLogContext(
              { businessId: payload?.new?.business_id, entryId: payload?.new?.id },
              () => this.handleWaitlistStatusChange(payload)
            );
          }
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            logEvent('info', 'realtime.subscribed', { channel: 'waitlist_entries' });
            if (this.waitlistChannelHadError) {
              this.waitlistChannelHadError = false;
              logger.debug('Reconnected after error, starting missed-event recovery');
              this.recoverMissedNotifications().catch((error) =>
                logger.error('Missed-event recovery failed', { error })
              );
            }
          } else if (status === 'CHANNEL_ERROR') {
            this.waitlistChannelHadError = true;
            const t = throttle('realtime.lost:waitlist_entries', 60_000);
            if (t.allowed) {
              logEvent('error', 'realtime.lost', {
                channel: 'waitlist_entries',
                suppressed: t.suppressed,
              });
            }
          } else {
            logger.debug('Waitlist subscription status update', { status });
          }
        });

      this.subscriptions.set('waitlist_entries', subscription);
    } catch (error) {
      logger.error('Failed to subscribe to waitlist_entries', { error });
    }
  }

  /**
   * Called on every waitlist_entries INSERT.
   * Sends a WhatsApp notification appropriate for the entry status.
   * Uses a unified dedup key so that if the WhatsApp handler already sent the
   * message (AI_CHAT flow), the realtime subscriber skips it gracefully.
   */
  private static async handleNewEntryNotification(payload: any): Promise<void> {
    try {
      const entry = payload?.new;
      if (!entry?.id || !entry?.customer_id || !entry?.business_id) {
        // Antes se volcaba el `payload` entero (la fila completa de Postgres).
        logger.debug('INSERT missing required fields', {
          entryId: entry?.id,
          hasCustomer: !!entry?.customer_id,
          hasBusiness: !!entry?.business_id,
        });
        return;
      }

      // Unified dedup key shared with the WhatsApp handler's createAndNotifyReservation
      const dedupKey = createdNotificationKey(entry.id);

      if (await wasAlreadyNotified(dedupKey)) {
        logger.debug('Skipping INSERT notification, already sent by handler', {
          source: entry.source,
        });
        return;
      }

      const supabaseClient = SupabaseConfig.getClient();

      const { data: customerData, error: customerError } = await supabaseClient
        .from('customers')
        .select('*')
        .eq('id', entry.customer_id)
        .single();

      if (customerError || !customerData) {
        logger.warn('Customer not found for INSERT notification', {
          customerId: entry.customer_id,
          error: customerError,
        });
        return;
      }

      const customer = customerData as CustomersRow;

      if (!customer.phone) {
        // Ocurre con clientes cargados a mano desde el panel: no es accionable.
        logger.debug('Customer has no phone, skipping INSERT notification', {
          customerId: customer.id,
        });
        return;
      }

      // Este sender corre FUERA del turno de conversación (lo dispara un cambio
      // en la DB), así que no hay idioma en el AsyncLocalStorage: se resuelve
      // desde la preferencia guardada del cliente y se envuelve la construcción
      // del mensaje para que los templates salgan en su idioma.
      const { language } = await resolveLanguage(entry.business_id, customer.phone);

      let notificationMessage = '';
      const eventTitle = entry.event_id ? await SupabaseService.getEventTitle(entry.event_id) : null;
      await runWithLanguage(language, async () => {
      const whenLabel = entry.scheduled_at
        ? describeScheduledAtUtcCompact(entry.scheduled_at, nowInBuenosAires())
        : templates.instantTurnLabel();

      if (entry.status === 'SEATED') {
        // Sentado: no se le manda nada. La persona ya está en el local, así que
        // un WhatsApp de bienvenida sólo le suena el teléfono en la mesa.
      } else if (entry.status === 'CONFIRMED' || entry.status === 'NOTIFIED') {
        notificationMessage = templates.reservationConfirmedNotice(
          entry.party_size,
          entry.display_code,
          whenLabel,
          entry.scheduled_at != null,
          eventTitle
        );
      } else {
        // WAITING — requiere confirmación manual del operador
        notificationMessage = templates.reservationRegisteredNotice(
          entry.party_size,
          entry.display_code,
          whenLabel,
          eventTitle
        );
      }
      });

      // Hay estados que deliberadamente no le mandan nada al cliente (sentado).
      if (!notificationMessage) {
        logger.debug('No message for this status, skipping INSERT notification', {
          status: entry.status,
        });
        return;
      }

      // `sendMessage` → `resolveJid` ya normaliza el número y consulta la cache
      // de JIDs. Duplicar esa búsqueda acá, además, la hacía con el teléfono
      // crudo: para un cliente cargado del panel la clave nunca coincidía.
      const baileys = BaileysService.getInstance();
      const sent = await baileys.sendMessage(entry.business_id, customer.phone, notificationMessage);

      if (sent) {
        logEvent('info', 'realtime.notified', {
          trigger: 'insert',
          source: entry.source,
          status: entry.status,
          phone: customer.phone,
        });
        await markNotified(dedupKey);
      } else {
        // Cuando la sesión de WhatsApp del comercio está caída esto se repite
        // por cada entrada: 1678 líneas idénticas en el log anterior.
        const t = throttle(`realtime.notify_failed:${entry.business_id}`, 60_000);
        if (t.allowed) {
          logEvent('warn', 'msg.out_failed', {
            trigger: 'realtime_insert',
            source: entry.source,
            phone: customer.phone,
            suppressed: t.suppressed,
          });
        }
      }
    } catch (error) {
      logger.error('Error in handleNewEntryNotification', { error });
    }
  }

  /**
   * Queries Supabase for recent entries that missed a WhatsApp notification
   * while the Realtime channel was down (checks Redis dedup key to avoid resends).
   * Lookback window: 2 hours. Runs automatically after reconnection.
   */
  private static async recoverMissedNotifications(): Promise<void> {
    try {
      const supabaseClient = SupabaseConfig.getClient();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      // Recover missed status UPDATEs (CONFIRMED / NOTIFIED / SEATED)
      const { data: statusEntries, error: statusError } = await supabaseClient
        .from('waitlist_entries')
        .select('*')
        .in('status', ['CONFIRMED', 'NOTIFIED', 'SEATED', 'CANCELLED'])
        .gte('updated_at', twoHoursAgo);

      if (statusError) {
        logger.error('Recovery failed to query status entries', { error: statusError });
      } else if (statusEntries && statusEntries.length > 0) {
        logger.debug('Recovery: checking recent status entries', { count: statusEntries.length });
        for (const entry of statusEntries) {
          const alreadySent = await wasAlreadyNotified(
            statusNotificationKey(entry.id, entry.status)
          );
          if (!alreadySent) {
            logger.debug('Recovery: sending missed status notification', {
              entryId: entry.id,
              status: entry.status,
            });
            await this.handleWaitlistStatusChange({ eventType: 'UPDATE', new: entry, old: { status: 'WAITING' } });
          }
        }
      }

      // Recover missed INSERT notifications for any source (DASHBOARD or AI_CHAT)
      const { data: newEntries, error: newEntriesError } = await supabaseClient
        .from('waitlist_entries')
        .select('*')
        .in('status', ['WAITING', 'CONFIRMED', 'SEATED'])
        .gte('created_at', twoHoursAgo);

      if (newEntriesError) {
        logger.error('Recovery failed to query new entries', { error: newEntriesError });
      } else if (newEntries && newEntries.length > 0) {
        logger.debug('Recovery: checking recent entries for missed INSERTs', {
          count: newEntries.length,
        });
        for (const entry of newEntries) {
          const alreadySent = await wasAlreadyNotified(createdNotificationKey(entry.id));
          if (!alreadySent) {
            logger.debug('Recovery: sending missed INSERT notification', {
              entryId: entry.id,
              source: entry.source,
              status: entry.status,
            });
            await this.handleNewEntryNotification({ new: entry });
          }
        }
      }

      logEvent('info', 'realtime.recovered', {
        statusEntriesChecked: statusEntries?.length ?? 0,
        newEntriesChecked: newEntries?.length ?? 0,
      });
    } catch (error) {
      logger.error('Unexpected error during realtime recovery', { error });
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

      // Estas tres líneas se disparaban juntas cada ~7 s para el mismo comercio
      // — 9000+ entradas en una muestra de 20 MB, para un evento que en la gran
      // mayoría de los casos el sistema descarta. Son traza, no eventos.
      logger.debug('Business change detected', { eventType, businessId });

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
        logger.debug('Business cached in Redis', { businessId });

        const shouldRefreshCaches =
          eventType === 'INSERT' ||
          this.shouldRefreshBusinessCaches(previousBusinessSnapshot, newBusiness);

        if (shouldRefreshCaches) {
          const tablesCacheKey = `business:tables:${businessId}`;
          await redis.del(tablesCacheKey);
          logger.debug('Tables cache cleared', { businessId });
        } else {
          logger.debug('Skipping cache refresh for technical business update', { businessId });
        }

        await this.closeSessionIfWeeklyHoursMissing(businessId, newBusiness);
      } else if (eventType === 'DELETE') {
        // Remove from cache
        const businessKey = `business:${businessId}`;
        const tablesCacheKey = `business:tables:${businessId}`;
        await redis.del(businessKey);
        await redis.del(tablesCacheKey);
        logger.debug('Business removed from cache', { businessId });
      }
    } catch (error) {
      logger.error('Error handling business change', {
        error,
        eventType: payload?.eventType,
        businessId: payload?.new?.id ?? payload?.old?.id,
      });
    }
  }

  /**
   * Without weekly_hours configured the bot has no way to know when the
   * business is open, so an active WhatsApp session would keep answering
   * with no schedule to enforce. Closing it forces the business to
   * reconnect (scanning the QR again) once hours are set back up.
   */
  private static async closeSessionIfWeeklyHoursMissing(businessId: string, business: any): Promise<void> {
    if (!businessId || business?.weekly_hours != null) {
      return;
    }

    try {
      const baileys = BaileysService.getInstance();

      if (!baileys.hasSession(businessId)) {
        return;
      }

      logEvent('warn', 'session.closed', {
        businessId,
        reason: 'weekly_hours is null',
      });
      await baileys.stopSession(businessId);
    } catch (error) {
      logger.error('Error closing WhatsApp session for missing weekly_hours', { error, businessId });
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

      logger.debug('Table change detected', {
        eventType,
        businessId,
        tableId: table?.id,
        tableName: table?.name,
      });

      if (!businessId) {
        logger.debug('Table change missing businessId');
        return;
      }

      const redis = RedisConfig.getClient();
      const tablesCacheKey = `business:tables:${businessId}`;

      await redis.del(tablesCacheKey);

      logger.debug('Tables cache cleared for business', { businessId });
    } catch (error) {
      logger.error('Error handling tables change', {
        error,
        eventType: payload?.eventType,
        businessId: payload?.new?.business_id ?? payload?.old?.business_id,
      });
    }
  }

  /**
   * Handle waitlist status changes - send WhatsApp notification when status changes to NOTIFIED
   */
  private static async handleWaitlistStatusChange(payload: any): Promise<void> {
    try {
      const { eventType, new: newEntry, old: oldEntry } = payload;

      // Este handler emitía 7 líneas `info` por evento, incluso para los que
      // descarta de inmediato. Toda esa deliberación es traza: sólo el envío
      // efectivo (o su fallo) llega a `info`.
      logger.debug('Waitlist UPDATE received', {
        eventType,
        oldStatus: oldEntry?.status,
        newStatus: newEntry?.status,
        displayCode: newEntry?.display_code,
      });

      // Only process UPDATE events
      if (eventType !== 'UPDATE') {
        logger.debug('Skipping non-UPDATE event', { eventType });
        return;
      }

      // Only a genuine transition INTO CONFIRMED/NOTIFIED should notify. Without
      // this, any update that leaves the status unchanged (e.g. editing the
      // scheduled time or party size on an already-CONFIRMED reservation) would
      // re-send the "your reservation is confirmed" message even though nothing
      // about the status actually changed. If `old` is missing from the payload
      // we can't tell either way, so fail open (assume it changed) to preserve
      // the previous behavior in that case.
      const statusChanged = !oldEntry || oldEntry.status !== newEntry?.status;

      // Check if new status is CONFIRMED or NOTIFIED
      const isConfirmed = statusChanged && newEntry?.status === 'CONFIRMED';
      // Keep backward compat: NOTIFIED still sends the confirmation message
      const isNotified = statusChanged && newEntry?.status === 'NOTIFIED';
      // M11 — welcome message when the customer is seated at the restaurant
      const isSeated = statusChanged && newEntry?.status === 'SEATED';
      // El restaurante dio de baja la reserva desde el panel. El cliente se
      // enteraba sólo si volvía a escribir: para él la reserva seguía en pie.
      const isCancelled = statusChanged && newEntry?.status === 'CANCELLED';

      logger.debug('Status validation', {
        oldStatus: oldEntry?.status,
        newStatus: newEntry?.status,
        statusChanged,
      });

      if (!isConfirmed && !isNotified && !isSeated && !isCancelled) {
        logger.debug('Skipping: status is not CONFIRMED, NOTIFIED, SEATED or CANCELLED', {
          newStatus: newEntry?.status,
          statusChanged,
        });
        return;
      }

      // Skip duplicate notifications only for the same status.
      // CONFIRMED and NOTIFIED must not block each other.
      //
      // Para CANCELLED esta clave es además el silenciador del doble aviso:
      // cuando quien cancela es el cliente desde el chat, el handler ya le
      // respondió y marcó la clave, así que acá no se le manda un segundo
      // mensaje diciéndole que lo canceló el restaurante.
      const statusDedupKey = statusNotificationKey(newEntry.id, newEntry.status);
      if (await wasAlreadyNotified(statusDedupKey)) {
        logger.debug('Skipping duplicate status notification', {
          status: newEntry.status,
        });
        return;
      }

      logger.debug('Status changed, preparing notification', {
        displayCode: newEntry.display_code,
        oldStatus: oldEntry.status,
        newStatus: newEntry.status,
      });

      // Get customer data directly from Supabase
      const supabaseClient = SupabaseConfig.getClient();
      const { data: customerData, error: customerError } = await supabaseClient
        .from('customers')
        .select('*')
        .eq('id', newEntry.customer_id)
        .single();

      if (customerError || !customerData) {
        logger.warn('Customer not found for waitlist notification', {
          customerId: newEntry.customer_id,
          error: customerError,
        });
        return;
      }

      const customer = customerData as CustomersRow;

      if (!customer.phone) {
        logger.debug('Customer has no phone, skipping waitlist notification', {
          customerId: customer.id,
        });
        return;
      }

      logger.debug('Customer data retrieved', {
        customerId: customer.id,
        phone: customer.phone,
      });

      // Este sender corre FUERA del turno de conversación (lo dispara un cambio
      // en la DB), así que no hay idioma en el AsyncLocalStorage: se resuelve
      // desde la preferencia guardada del cliente y se envuelve la construcción
      // del mensaje para que los templates salgan en su idioma.
      const { language } = await resolveLanguage(newEntry.business_id, customer.phone);

      // Build message based on new status
      let notificationMessage = '';
      await runWithLanguage(language, async () => {
      if (isSeated) {
        // Sentado: no se le manda nada (ya está en el local).
      } else if (isNotified) {
        // AVISAR — "tu mesa está lista". Sólo tiene sentido para quien está
        // esperando una mesa: alguien que llegó sin reserva y quedó en la fila.
        // Una reserva agendada ya tiene su horario, así que el panel la pasa a
        // NOTIFIED sin que haya nada que avisar.
        if (newEntry.scheduled_at == null) {
          notificationMessage = templates.tableReadyNotice();
        }
      } else if (isCancelled) {
        // El restaurante dio de baja la reserva desde el panel.
        //
        // Si la reserva era para un evento, lo más probable es que la baja no
        // sea individual sino que hayan eliminado el evento entero. El payload
        // de realtime es una foto del momento del UPDATE, así que conserva el
        // event_id aunque el `onDelete: SetNull` lo borre después; y la fila
        // del evento sobrevive a la baja lógica, así que el título se puede
        // leer. Si aun así no aparece, cae en el aviso genérico.
        const eventTitle = newEntry.event_id
          ? await SupabaseService.getEventTitle(newEntry.event_id)
          : null;

        const whenLabel = newEntry.scheduled_at
          ? describeScheduledAtUtc(newEntry.scheduled_at, nowInBuenosAires())
          : null;

        notificationMessage = eventTitle
          ? templates.eventCancelledByBusiness(
              customer.name,
              eventTitle,
              newEntry.display_code,
              whenLabel
            )
          : templates.reservationCancelledByBusiness(
              customer.name,
              newEntry.display_code,
              whenLabel
            );
      } else {
        // Paso 5: Reserva CONFIRMADA (CONFIRMED o NOTIFIED legacy)
        const eventTitle = newEntry.event_id
          ? await SupabaseService.getEventTitle(newEntry.event_id)
          : null;
        notificationMessage = templates.reservationConfirmedNotice(
          newEntry.party_size,
          newEntry.display_code,
          newEntry.scheduled_at
            ? describeScheduledAtUtcCompact(newEntry.scheduled_at, nowInBuenosAires())
            : templates.instantTurnLabel(),
          newEntry.scheduled_at != null,
          eventTitle
        );
      }
      });

      logger.debug('Notification message built', {
        messageLength: notificationMessage.length,
        status: newEntry.status,
      });

      // Hay transiciones que deliberadamente no le mandan nada al cliente:
      // sentarlo, y avisar una reserva que ya tenía horario agendado.
      if (!notificationMessage) {
        logger.debug('No message for this transition, skipping notification', {
          status: newEntry.status,
          scheduled: newEntry.scheduled_at != null,
        });
        return;
      }

      // Send WhatsApp notification.
      //
      // `sendMessage` → `resolveJid` ya normaliza el número, consulta la cache
      // de JIDs y distingue @lid de @s.whatsapp.net. Duplicar esa búsqueda acá,
      // además, la hacía con el teléfono crudo: para un cliente cargado del
      // panel la clave nunca coincidía.
      const baileys = BaileysService.getInstance();
      const sent = await baileys.sendMessage(
        newEntry.business_id,
        customer.phone,
        notificationMessage
      );

      if (sent) {
        logEvent('info', 'realtime.notified', {
          trigger: 'status_change',
          status: newEntry.status,
          previousStatus: oldEntry.status,
          phone: customer.phone,
          displayCode: newEntry.display_code,
        });

        // Mark this status notification as sent to avoid duplicate sends.
        await markNotified(statusDedupKey);
      } else {
        const t = throttle(`realtime.notify_failed:${newEntry.business_id}`, 60_000);
        if (t.allowed) {
          logEvent('warn', 'msg.out_failed', {
            trigger: 'realtime_status_change',
            status: newEntry.status,
            phone: customer.phone,
            displayCode: newEntry.display_code,
            suppressed: t.suppressed,
          });
        }
      }
    } catch (error) {
      logger.error('Error in handleWaitlistStatusChange', {
        error,
        eventType: payload?.eventType,
        status: payload?.new?.status,
      });
    }
  }

  /**
   * Subscribe to business_blocked_dates changes so the client-facing
   * `reason_message` is generated as soon as the date is blocked (typically
   * from the dashboard, which inserts straight into Postgres) instead of
   * on the first customer that asks about that date.
   */
  /**
   * Subscribe to business_blocked_dates table changes.
   * Listens for INSERT (new blocked dates from dashboard) and UPDATE
   * (modifications to existing blocked dates) events.
   *
   * When a blocked date is created/updated with a reason but no reason_message,
   * this handler automatically generates the professional client-facing message.
   */
  private static subscribeToBlockedDates(client: any): void {
    try {
      logger.debug('Setting up business_blocked_dates subscription');

      const subscription = client
        .channel('public:business_blocked_dates')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'business_blocked_dates',
          },
          async (payload: any) => {
            logger.debug('Blocked date INSERT event received', {
              businessId: payload?.new?.business_id,
              date: payload?.new?.date,
              hasReason: !!payload?.new?.reason,
            });
            await this.handleBlockedDateChange(payload);
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'business_blocked_dates',
          },
          async (payload: any) => {
            logger.debug('Blocked date UPDATE event received', {
              businessId: payload?.new?.business_id,
              date: payload?.new?.date,
              hasReason: !!payload?.new?.reason,
            });
            await this.handleBlockedDateChange(payload);
          }
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            logEvent('info', 'realtime.subscribed', { channel: 'business_blocked_dates' });
          } else if (status === 'CHANNEL_ERROR') {
            const t = throttle('realtime.lost:business_blocked_dates', 60_000);
            if (t.allowed) {
              logEvent('error', 'realtime.lost', {
                channel: 'business_blocked_dates',
                suppressed: t.suppressed,
              });
            }
          } else {
            logger.debug('business_blocked_dates subscription status update', { status });
          }
        });

      this.subscriptions.set('business_blocked_dates', subscription);
    } catch (error) {
      logger.error('Failed to subscribe to business_blocked_dates', { error });
    }
  }

  /**
   * Generate and store `reason_message` for a blocked date when detected from
   * realtime changes (e.g., created from external dashboard).
   *
   * Generates message when:
   * - A date is newly inserted with a reason but no reason_message yet
   * - A date is updated with a new or changed reason
   *
   * Skips generation when a message already exists for the current reason
   * to avoid re-triggering when our own write occurs.
   */
  private static async handleBlockedDateChange(payload: any): Promise<void> {
    try {
      const eventType = payload?.eventType || 'UNKNOWN';
      const newRow = payload?.new;
      const oldRow = payload?.old;

      if (!newRow) {
        logger.debug('Blocked date change: skipped (no new row)', { eventType });
        return;
      }

      const businessId: string | undefined = newRow.business_id;
      const date: string | undefined = newRow.date;
      const reason: string | null = newRow.reason?.trim() || null;
      const reasonMessage: string | null = newRow.reason_message || null;

      logger.debug('Blocked date change detected', {
        eventType,
        businessId,
        date,
        hasReason: !!reason,
        hasReasonMessage: !!reasonMessage,
      });

      // Skip if missing required fields
      if (!businessId || !date || !reason) {
        logger.debug('Blocked date skipped: missing businessId, date, or reason', {
          businessId,
          date,
          reason,
        });
        return;
      }

      // Check if message already exists for this reason
      if (reasonMessage) {
        logger.debug('Blocked date skipped: reason_message already exists', {
          businessId,
          date,
        });
        return;
      }

      // Check if the reason changed (for UPDATE events)
      const oldReason = oldRow?.reason?.trim() || null;
      if (eventType === 'UPDATE' && oldReason === reason) {
        logger.debug('Blocked date skipped: reason unchanged in UPDATE', {
          businessId,
          date,
          reason,
        });
        return;
      }

      logger.debug('Starting blocked-date reason_message generation', {
        businessId,
        date,
        eventType,
      });

      const business = await SupabaseService.getBusinessById(businessId);
      const generatedMessage = await openRouterService.generateBlockedDateReasonMessage(
        reason,
        business?.name,
        business?.type
      );

      await SupabaseService.updateBlockedDateReasonMessage(businessId, date, generatedMessage);

      logger.debug('Blocked-date reason_message generated and saved', {
        businessId,
        date,
        eventType,
        messageLength: generatedMessage.length,
      });
    } catch (error) {
      logger.error('Failed to generate blocked-date reason_message', {
        error,
        businessId: payload?.new?.business_id,
        date: payload?.new?.date,
        eventType: payload?.eventType,
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
        logger.debug('Unsubscribed from realtime channel', { channel: key });
      }

      this.subscriptions.clear();
      this.initialized = false;
      logger.debug('Realtime sync cleanup complete');
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
