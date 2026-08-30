import { RedisConfig } from '../config/redis.js';
import { SupabaseConfig } from '../config/supabase.js';
import { logger, logEvent } from '../utils/logger.js';
import { withLogContext } from '../utils/log-context.js';
import { throttle } from '../utils/log-throttle.js';
import { getTemplates } from '../i18n/index.js';
import { resolveLanguage } from '../i18n/language-store.js';
import {
  markNotified,
  reminderNotificationKey,
  wasAlreadyNotified,
} from '../utils/notification-dedup.js';
import { describeScheduledAtUtc, nowInBuenosAires } from '../utils/reservation-datetime.js';
import type { Database } from '../types/supabase.js';

type CustomersRow = Database['public']['Tables']['customers']['Row'];
type WaitlistEntriesRow = Database['public']['Tables']['waitlist_entries']['Row'];

/**
 * Reserva próxima junto a su cliente.
 *
 * Se arma con dos consultas en vez de un `select('*, customers(...)')`: los
 * tipos generados declaran `Relationships: []` para `waitlist_entries`, así que
 * el join embebido no tipa y quedaría dependiendo de un nombre de FK que el
 * código no puede verificar.
 */
type UpcomingReservation = WaitlistEntriesRow & {
  customer: Pick<CustomersRow, 'id' | 'name' | 'phone'> | null;
};

/**
 * Qué recordatorio es. La distinción vive en la clave de dedup, así que los dos
 * se envían y se suprimen de forma independiente.
 */
type ReminderKind = 'upcoming' | 'arrival';

/**
 * M10 — Recordatorios previos a la reserva.
 *
 * Manda dos mensajes antes de que llegue la hora: uno con antelación (por
 * defecto una hora, con la salida explícita para cancelar) y otro de proximidad
 * (por defecto quince minutos).
 *
 * A diferencia de M12 (post-visita), acá NO se encola nada al crear la reserva:
 * el scanner consulta la DB en cada pasada. Es a propósito. Una cola en Redis
 * armada por adelantado se desincroniza en cuanto alguien reprograma la reserva
 * desde el panel, no cubre las reservas que ya existían antes del deploy, y se
 * pierde entera si Redis se limpia. Consultar la DB por la ventana próxima es
 * barato — son las reservas de la hora siguiente, no todas — y siempre refleja
 * el estado real.
 *
 * Redis se usa sólo para deduplicar. Si no está disponible el scanner no corre:
 * sin la marca de "ya enviado" mandaría el mismo recordatorio cada 60 segundos.
 */
export class ReservationReminderService {
  private static readonly SCAN_INTERVAL_MS = 60 * 1000;

  /** Estados que todavía esperan al cliente. Una CANCELLED o SEATED no se recuerda. */
  private static readonly PENDING_STATUSES = ['WAITING', 'CONFIRMED'] as const;

  private static timer: ReturnType<typeof setInterval> | null = null;

  /** Antelación del primer recordatorio, en minutos. 0 lo deshabilita. */
  static getUpcomingLeadMinutes(): number {
    return this.readLeadMinutes('RESERVATION_REMINDER_LEAD_MINUTES', 60);
  }

  /** Antelación del aviso de proximidad, en minutos. 0 lo deshabilita. */
  static getArrivalLeadMinutes(): number {
    return this.readLeadMinutes('RESERVATION_ARRIVAL_REMINDER_LEAD_MINUTES', 15);
  }

  private static readLeadMinutes(envVar: string, fallback: number): number {
    const raw = process.env[envVar];
    if (raw === undefined || raw === '') {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }

  /** Inicia el scanner periódico (idempotente). */
  static start(): void {
    if (this.timer) {
      return;
    }

    const upcoming = this.getUpcomingLeadMinutes();
    const arrival = this.getArrivalLeadMinutes();

    if (upcoming === 0 && arrival === 0) {
      logger.debug('Reservation reminders disabled by configuration');
      return;
    }

    this.timer = setInterval(() => {
      this.processDueReminders().catch((error) => {
        logger.error('Reminders: error processing due reservations', { error });
      });
    }, this.SCAN_INTERVAL_MS);

    // No mantener vivo el event loop sólo por este timer.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    logger.debug('Reservation reminder scanner started', {
      intervalMs: this.SCAN_INTERVAL_MS,
      upcomingLeadMinutes: upcoming,
      arrivalLeadMinutes: arrival,
    });
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.debug('Reservation reminder scanner stopped');
    }
  }

  /**
   * Una pasada: busca las reservas pendientes de la ventana próxima y manda los
   * recordatorios que correspondan.
   */
  static async processDueReminders(): Promise<void> {
    // Sin dedup, cada pasada reenviaría lo mismo. Mejor no mandar nada.
    if (!RedisConfig.isReady()) {
      const t = throttle('reminders.no_redis', 60_000);
      if (t.allowed) {
        logger.debug('Reminders: Redis not ready, skipping scan', { suppressed: t.suppressed });
      }
      return;
    }

    const upcomingLead = this.getUpcomingLeadMinutes();
    const arrivalLead = this.getArrivalLeadMinutes();
    const horizonMinutes = Math.max(upcomingLead, arrivalLead);
    if (horizonMinutes === 0) {
      return;
    }

    const now = Date.now();
    const reservations = await this.fetchUpcoming(now, horizonMinutes);

    for (const reservation of reservations) {
      const minutesUntil = Math.round(
        (new Date(reservation.scheduled_at!).getTime() - now) / 60_000
      );

      await withLogContext(
        { businessId: reservation.business_id, entryId: reservation.id },
        async () => {
          await this.processReminder(reservation, 'upcoming', minutesUntil, upcomingLead, arrivalLead);
        }
      );
    }
  }

  /** Reservas pendientes cuya hora cae dentro de la ventana, con su cliente. */
  private static async fetchUpcoming(
    now: number,
    horizonMinutes: number
  ): Promise<UpcomingReservation[]> {
    const supabase = SupabaseConfig.getClient();

    const { data: entriesData, error: entriesError } = await supabase
      .from('waitlist_entries')
      .select('*')
      .in('status', this.PENDING_STATUSES)
      .not('scheduled_at', 'is', null)
      .gte('scheduled_at', new Date(now).toISOString())
      .lte('scheduled_at', new Date(now + horizonMinutes * 60_000).toISOString());

    if (entriesError) {
      logger.error('Reminders: failed to query upcoming reservations', { error: entriesError });
      return [];
    }

    const entries = (entriesData as WaitlistEntriesRow[] | null) ?? [];
    if (entries.length === 0) {
      return [];
    }

    const customerIds = [...new Set(entries.map((entry) => entry.customer_id))];
    const { data: customersData, error: customersError } = await supabase
      .from('customers')
      .select('id, name, phone')
      .in('id', customerIds);

    if (customersError) {
      logger.error('Reminders: failed to query reminder recipients', { error: customersError });
      return [];
    }

    const byId = new Map(
      ((customersData as Pick<CustomersRow, 'id' | 'name' | 'phone'>[] | null) ?? []).map(
        (customer) => [customer.id, customer]
      )
    );

    return entries.map((entry) => ({ ...entry, customer: byId.get(entry.customer_id) ?? null }));
  }

  /**
   * Decide y manda un recordatorio puntual.
   *
   * `leadMinutes` es cuándo debe salir; `floorMinutes` es el piso por debajo del
   * cual ya no tiene sentido. Ese piso importa: si el proceso estuvo caído, una
   * reserva puede aparecer a 5 minutos vista y mandarle "falta una hora" sería
   * peor que no mandar nada. En ese caso el recordatorio se marca como enviado
   * para que no salga tarde en la pasada siguiente.
   */
  private static async processReminder(
    reservation: UpcomingReservation,
    kind: ReminderKind,
    minutesUntil: number,
    leadMinutes: number,
    floorMinutes: number
  ): Promise<void> {
    if (leadMinutes === 0 || minutesUntil > leadMinutes) {
      return;
    }

    const dedupKey = reminderNotificationKey(reservation.id, kind);
    if (await wasAlreadyNotified(dedupKey)) {
      return;
    }

    // El piso nunca puede quedar por encima del disparo: si alguien configura
    // la proximidad más lejos que la antelación, el recordatorio igual sale.
    const effectiveFloor = Math.min(floorMinutes, leadMinutes - 1);

    if (minutesUntil <= effectiveFloor) {
      logger.debug('Reminders: too late to send, marking as done', {
        kind,
        minutesUntil,
        leadMinutes,
      });
      await markNotified(dedupKey);
      return;
    }

    const customer = reservation.customer;
    if (!customer?.phone) {
      logger.debug('Reminders: reservation has no reachable customer, skipping', { kind });
      await markNotified(dedupKey);
      return;
    }

    // Este scanner corre fuera del turno de conversación, así que el idioma se
    // resuelve desde la preferencia guardada del cliente.
    const { language } = await resolveLanguage(reservation.business_id, customer.phone);
    const catalog = getTemplates(language);
    const whenLabel = describeScheduledAtUtc(reservation.scheduled_at!, nowInBuenosAires());

    const message =
      kind === 'upcoming'
        ? catalog.reservationUpcomingReminder(
            customer.name,
            reservation.party_size,
            whenLabel,
            reservation.display_code,
            minutesUntil
          )
        : catalog.reservationArrivalReminder(
            whenLabel,
            reservation.display_code,
            minutesUntil
          );

    const { BaileysService } = await import('./baileys.service.js');
    const sent = await BaileysService.getInstance().sendMessage(
      reservation.business_id,
      customer.phone,
      message
    );

    if (sent) {
      await markNotified(dedupKey);
      logEvent('info', 'job.reminder_sent', {
        kind,
        minutesUntil,
        phone: customer.phone,
        displayCode: reservation.display_code,
      });
    } else {
      // `msg.out_failed` ya lo emitió BaileysService con la causa tipificada.
      // Sin marcar: la próxima pasada reintenta mientras siga dentro de ventana.
      logger.debug('Reminder could not be delivered', { kind, phone: customer.phone });
    }
  }
}
