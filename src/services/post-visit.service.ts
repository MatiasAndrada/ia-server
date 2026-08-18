import { RedisConfig } from '../config/redis.js';
import { SupabaseConfig } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { getTemplates } from '../i18n/index.js';
import { resolveLanguage } from '../i18n/language-store.js';
import type { Database } from '../types/supabase.js';

type CustomersRow = Database['public']['Tables']['customers']['Row'];

/**
 * M12 — Mensaje posterior a la visita.
 *
 * Cuando una reserva pasa a SEATED se encola en un sorted set de Redis con un
 * timestamp de vencimiento (ahora + POST_VISIT_DELAY_MINUTES). Un scanner
 * periódico envía el mensaje de agradecimiento/reseña cuando el plazo vence,
 * siempre que la reserva siga en estado SEATED (no cancelada / no-show).
 *
 * La cola vive en Redis, por lo que el proceso es tolerante a reinicios.
 */
export class PostVisitService {
  private static readonly QUEUE_KEY = 'wa:postvisit:queue';
  private static readonly SENT_KEY_PREFIX = 'wa:postvisit:sent:';
  private static readonly SENT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 días
  private static readonly SCAN_INTERVAL_MS = 60 * 1000; // cada 60s
  private static timer: ReturnType<typeof setInterval> | null = null;

  private static getDelayMinutes(): number {
    const configured = Number(process.env.POST_VISIT_DELAY_MINUTES);
    if (!Number.isFinite(configured) || configured <= 0) {
      return 120; // default: 2 horas
    }
    return Math.floor(configured);
  }

  /**
   * Encola el mensaje post-visita para una reserva recién sentada.
   * El miembro del sorted set es `entryId:businessId`; el score, el instante
   * (epoch ms) en que debe enviarse.
   */
  static async schedulePostVisit(entryId: string, businessId: string): Promise<void> {
    try {
      if (!RedisConfig.isReady()) {
        logger.warn('[POSTVISIT] Redis not ready, cannot schedule post-visit message', { entryId });
        return;
      }

      const client = RedisConfig.getClient();

      // No re-encolar si ya se envió (p. ej. SEATED reaplicado)
      const alreadySent = await client.get(`${this.SENT_KEY_PREFIX}${entryId}`);
      if (alreadySent) {
        return;
      }

      const dueAt = Date.now() + this.getDelayMinutes() * 60 * 1000;
      await client.zAdd(this.QUEUE_KEY, { score: dueAt, value: `${entryId}:${businessId}` });

      logger.info('[POSTVISIT] Scheduled post-visit message', {
        entryId,
        businessId,
        dueAt: new Date(dueAt).toISOString(),
        delayMinutes: this.getDelayMinutes(),
      });
    } catch (error) {
      logger.error('[POSTVISIT] Failed to schedule post-visit message', { error, entryId, businessId });
    }
  }

  /** Inicia el scanner periódico (idempotente). */
  static start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.processDueEntries().catch((error) => {
        logger.error('[POSTVISIT] Error processing due entries', { error });
      });
    }, this.SCAN_INTERVAL_MS);
    // No mantener vivo el event loop sólo por este timer.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    logger.info('[POSTVISIT] Post-visit scanner started', { intervalMs: this.SCAN_INTERVAL_MS });
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[POSTVISIT] Post-visit scanner stopped');
    }
  }

  /** Envía los mensajes cuyo plazo ya venció. */
  static async processDueEntries(): Promise<void> {
    if (!RedisConfig.isReady()) {
      return;
    }

    const client = RedisConfig.getClient();
    const now = Date.now();

    // Miembros vencidos (score <= ahora)
    const due = await client.zRangeByScore(this.QUEUE_KEY, 0, now);
    if (!due || due.length === 0) {
      return;
    }

    for (const member of due) {
      try {
        const sep = member.lastIndexOf(':');
        const entryId = sep >= 0 ? member.slice(0, sep) : member;
        const businessId = sep >= 0 ? member.slice(sep + 1) : '';

        await this.sendPostVisitMessage(entryId, businessId);
      } catch (error) {
        logger.error('[POSTVISIT] Failed to process due member', { error, member });
      } finally {
        // Siempre remover de la cola: reintentar indefinidamente generaría spam.
        await client.zRem(this.QUEUE_KEY, member);
      }
    }
  }

  private static async sendPostVisitMessage(entryId: string, businessId: string): Promise<void> {
    const client = RedisConfig.getClient();

    // Dedup: no enviar dos veces
    const alreadySent = await client.get(`${this.SENT_KEY_PREFIX}${entryId}`);
    if (alreadySent) {
      return;
    }

    const supabase = SupabaseConfig.getClient();

    // Verificar que la reserva siga SEATED (no cancelada ni no-show)
    const { data: entryData, error: entryError } = await supabase
      .from('waitlist_entries')
      .select('*')
      .eq('id', entryId)
      .single();

    if (entryError || !entryData) {
      logger.warn('[POSTVISIT] Entry not found, skipping post-visit message', { entryId, error: entryError });
      return;
    }

    if (entryData.status !== 'SEATED') {
      logger.info('[POSTVISIT] Entry is no longer SEATED, skipping post-visit message', {
        entryId,
        status: entryData.status,
      });
      return;
    }

    // Buscar teléfono del cliente
    const { data: customerData, error: customerError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', entryData.customer_id)
      .single();

    if (customerError || !customerData) {
      logger.error('[POSTVISIT] Customer not found for post-visit message', { entryId, error: customerError });
      return;
    }

    const customer = customerData as CustomersRow;
    if (!customer.phone) {
      logger.error('[POSTVISIT] Customer has no phone, skipping post-visit message', { entryId });
      return;
    }

    // Resolver JID (mismo patrón que realtime-sync)
    let recipientJid = customer.phone;
    try {
      const cachedJid = await client.get(`jid:${businessId}:${customer.phone}`);
      if (cachedJid) recipientJid = cachedJid;
    } catch (_) {
      /* usar phone como fallback */
    }

    // Igual que realtime-sync: este scanner corre fuera del turno de
    // conversación, así que el idioma se resuelve desde la preferencia guardada.
    const { language } = await resolveLanguage(businessId, customer.phone);
    const message = getTemplates(language).postVisitMessage();

    const { BaileysService } = await import('./baileys.service.js');
    const baileys = BaileysService.getInstance();
    const sent = await baileys.sendMessage(businessId, recipientJid, message);

    if (sent) {
      await client.setEx(`${this.SENT_KEY_PREFIX}${entryId}`, this.SENT_TTL_SECONDS, '1');
      logger.info('[POSTVISIT] Post-visit message sent (M12)', { entryId, businessId, phone: customer.phone });
    } else {
      logger.error('[POSTVISIT] Failed to send post-visit message', { entryId, businessId, phone: customer.phone });
    }
  }
}
