import { ReservationReminderService } from '../../services/reservation-reminder.service.js';
import { RedisConfig } from '../../config/redis.js';
import { SupabaseConfig } from '../../config/supabase.js';
import { BaileysService } from '../../services/baileys.service.js';

jest.mock('../../utils/logger');

/**
 * M10 — recordatorios previos a la reserva.
 *
 * Lo que se prueba acá es la lógica de ventanas: cuándo sale cada recordatorio,
 * cuándo ya es tarde para mandarlo, y que no se repita en la pasada siguiente.
 */
describe('ReservationReminderService', () => {
  let sendMessageMock: jest.Mock;
  let redisGetMock: jest.Mock;
  let redisSetExMock: jest.Mock;
  let entriesResult: { data: unknown; error: unknown };

  const NOW = new Date('2026-08-25T20:00:00.000Z').getTime();
  const customerRow = { id: 'customer-1', name: 'Matías', phone: '5491112223333' };

  /** Una reserva pendiente que cae dentro de `minutesFromNow`. */
  const reservationIn = (minutesFromNow: number, overrides: Record<string, unknown> = {}) => ({
    id: 'entry-1',
    business_id: 'business-1',
    customer_id: 'customer-1',
    status: 'CONFIRMED',
    party_size: 4,
    display_code: 'M102',
    scheduled_at: new Date(NOW + minutesFromNow * 60_000).toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.RESERVATION_REMINDER_LEAD_MINUTES;
    delete process.env.RESERVATION_ARRIVAL_REMINDER_LEAD_MINUTES;

    jest.spyOn(Date, 'now').mockReturnValue(NOW);

    sendMessageMock = jest.fn().mockResolvedValue(true);
    jest.spyOn(BaileysService, 'getInstance').mockReturnValue({
      sendMessage: sendMessageMock,
    } as any);

    redisGetMock = jest.fn().mockResolvedValue(null);
    redisSetExMock = jest.fn().mockResolvedValue('OK');
    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: redisGetMock,
      setEx: redisSetExMock,
      del: jest.fn().mockResolvedValue(1),
    } as any);

    entriesResult = { data: [], error: null };

    // `fetchUpcoming` hace dos consultas: las reservas y después sus clientes.
    jest.spyOn(SupabaseConfig, 'getClient').mockReturnValue({
      from: jest.fn().mockImplementation((table: string) => {
        if (table === 'customers') {
          return {
            select: jest.fn().mockReturnValue({
              in: jest.fn().mockResolvedValue({ data: [customerRow], error: null }),
            }),
          };
        }
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockReturnValue({
              not: jest.fn().mockReturnValue({
                gte: jest.fn().mockReturnValue({
                  lte: jest.fn().mockImplementation(() => Promise.resolve(entriesResult)),
                }),
              }),
            }),
          }),
        };
      }),
    } as any);
  });

  it('sends the lead reminder about an hour before, with the cancel exit', async () => {
    entriesResult = { data: [reservationIn(58)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [, , message] = sendMessageMock.mock.calls[0];
    expect(message).toContain('Te recordamos tu reserva');
    expect(message).toContain('CANCELAR');
  });

  it('no longer sends an arrival reminder within fifteen minutes of the reservation', async () => {
    // El envío de 'arrival' se sacó (era redundante con el de proximidad).
    // Además, el piso del recordatorio de antelación sigue en 15' por
    // defecto, así que tampoco sale ese otro mensaje esta cerca de la hora.
    entriesResult = { data: [reservationIn(14)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('sends nothing once the old arrival window has been reached, only marks it as done', async () => {
    // Sin el recordatorio de 'arrival', y con el piso del de antelación
    // también en 15', una reserva a 10' vista no dispara ningún mensaje.
    entriesResult = { data: [reservationIn(10)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('marks a reminder that arrived too late so it does not fire on the next pass', async () => {
    entriesResult = { data: [reservationIn(10)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(redisSetExMock).toHaveBeenCalledWith(
      'wa:reminder:sent:entry-1:upcoming',
      expect.any(Number),
      '1'
    );
  });

  it('stays quiet for a reservation still outside the window', async () => {
    entriesResult = { data: [reservationIn(90)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not repeat a reminder already sent', async () => {
    entriesResult = { data: [reservationIn(58)], error: null };
    redisGetMock.mockImplementation((key: string) =>
      Promise.resolve(key === 'wa:reminder:sent:entry-1:upcoming' ? '1' : null)
    );

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('marks the reminder as sent so the next pass skips it', async () => {
    entriesResult = { data: [reservationIn(58)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(redisSetExMock).toHaveBeenCalledWith(
      'wa:reminder:sent:entry-1:upcoming',
      expect.any(Number),
      '1'
    );
  });

  it('leaves the reminder unmarked when the send failed, so it is retried', async () => {
    entriesResult = { data: [reservationIn(58)], error: null };
    sendMessageMock.mockResolvedValue(false);

    await ReservationReminderService.processDueReminders();

    expect(redisSetExMock).not.toHaveBeenCalledWith(
      'wa:reminder:sent:entry-1:upcoming',
      expect.any(Number),
      '1'
    );
  });

  it('skips a reservation whose customer has no phone', async () => {
    entriesResult = { data: [reservationIn(58, { customer_id: 'ghost' })], error: null };

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not run at all when Redis is unavailable', async () => {
    // Sin dedup, cada pasada de 60s reenviaría el mismo recordatorio.
    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);
    entriesResult = { data: [reservationIn(58)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('honours a disabled lead reminder', async () => {
    process.env.RESERVATION_REMINDER_LEAD_MINUTES = '0';
    entriesResult = { data: [reservationIn(58)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('honours a custom lead time', async () => {
    process.env.RESERVATION_REMINDER_LEAD_MINUTES = '120';
    entriesResult = { data: [reservationIn(90)], error: null };

    await ReservationReminderService.processDueReminders();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][2]).toContain('Te recordamos tu reserva');
  });
});
