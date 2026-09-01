import { RealtimeSyncService } from '../../services/realtime-sync.service.js';
import { RedisConfig } from '../../config/redis.js';
import { SupabaseConfig } from '../../config/supabase.js';
import { BaileysService } from '../../services/baileys.service.js';
import { SupabaseService } from '../../services/supabase.service.js';

jest.mock('../../utils/logger');

describe('RealtimeSyncService.handleWaitlistStatusChange', () => {
  let sendMessageMock: jest.Mock;
  let redisGetMock: jest.Mock;
  let redisSetExMock: jest.Mock;
  let supabaseSingleMock: jest.Mock;

  const baseEntry = {
    id: 'entry-1',
    business_id: 'business-1',
    customer_id: 'customer-1',
    party_size: 4,
    display_code: 'M102',
  };

  const customerRow = { id: 'customer-1', name: 'Matías', phone: '5491112223333' };

  beforeEach(() => {
    jest.restoreAllMocks();

    sendMessageMock = jest.fn().mockResolvedValue(true);
    jest.spyOn(BaileysService, 'getInstance').mockReturnValue({
      sendMessage: sendMessageMock,
    } as any);

    redisGetMock = jest.fn().mockResolvedValue(null); // no dedup key set, no cached JID
    redisSetExMock = jest.fn().mockResolvedValue('OK');
    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: redisGetMock,
      setEx: redisSetExMock,
    } as any);

    supabaseSingleMock = jest.fn().mockResolvedValue({ data: customerRow, error: null });
    jest.spyOn(SupabaseConfig, 'getClient').mockReturnValue({
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: supabaseSingleMock,
          }),
        }),
      }),
    } as any);
  });

  it('sends the confirmation message on a genuine transition into CONFIRMED', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'WAITING' },
      new: { ...baseEntry, status: 'CONFIRMED' },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'business-1',
      expect.any(String),
      expect.stringContaining('¡Reserva confirmada')
    );
  });

  it('does NOT re-send the confirmation message when an edit leaves the status at CONFIRMED', async () => {
    // Regression for the bug where editing the schedule/party size of an
    // already-CONFIRMED reservation re-triggered a duplicate "confirmed" WhatsApp
    // message, because the old handler only checked newEntry.status === 'CONFIRMED'
    // without comparing it against oldEntry.status.
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED', scheduled_at: '2026-07-02T11:15:00.000Z' },
      new: { ...baseEntry, status: 'CONFIRMED', scheduled_at: '2026-07-08T22:00:00.000Z' },
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('AVISAR: tells the walk-in their table is ready on CONFIRMED -> NOTIFIED', async () => {
    // Sin scheduled_at: llegó sin reserva y quedó esperando una mesa. Es el
    // único caso en el que "tu mesa está lista" significa algo.
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED' },
      new: { ...baseEntry, status: 'NOTIFIED' },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'business-1',
      expect.any(String),
      expect.stringContaining('¡Tu mesa está lista!')
    );
  });

  it('AVISAR: da el plazo de 20 minutos para ocupar la mesa', async () => {
    // La retención se anuncia acá y sólo acá: es el momento en que el plazo
    // empieza a correr. Los mensajes de confirmación ya no la repiten.
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED' },
      new: { ...baseEntry, status: 'NOTIFIED' },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][2]).toContain('20 minutos');
  });

  it('AVISAR: does NOT fire for a scheduled reservation moved to NOTIFIED', async () => {
    // Una reserva agendada ya tiene su horario: no está esperando una mesa, así
    // que no le corresponde el aviso de mesa lista.
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED', scheduled_at: '2026-07-08T22:00:00.000Z' },
      new: { ...baseEntry, status: 'NOTIFIED', scheduled_at: '2026-07-08T22:00:00.000Z' },
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('pone fecha, personas y código en una sola línea', async () => {
    // La confirmación se acortó a tres líneas: sin ficha de datos etiquetada y
    // sin las promesas (recordatorio, retención) que repetía de más.
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'WAITING', scheduled_at: '2026-07-08T22:00:00.000Z' },
      new: { ...baseEntry, status: 'CONFIRMED', scheduled_at: '2026-07-08T22:00:00.000Z' },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const message = sendMessageMock.mock.calls[0][2] as string;
    const dataLine = message.split('\n').find((line) => line.includes('personas'));
    expect(dataLine).toContain('19:00');
    expect(dataLine).toContain('4 personas');
    expect(dataLine).toContain('M102');
    expect(message).not.toContain('20 minutos');
  });

  it('la reserva instantánea también sale en una línea, con la etiqueta del turno', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'WAITING' },
      new: { ...baseEntry, status: 'CONFIRMED' },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][2]).toContain('4 personas');
    expect(sendMessageMock.mock.calls[0][2]).not.toContain('20 minutos');
  });

  it('notifies the customer when the restaurant cancels the reservation', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED' },
      new: { ...baseEntry, status: 'CANCELLED', scheduled_at: '2026-07-08T22:00:00.000Z' },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'business-1',
      expect.any(String),
      expect.stringContaining('cancelada por el restaurante')
    );
  });

  it('names the event when the cancellation comes from the business deleting it', async () => {
    // Eliminar un evento cancela sus reservas en masa. Un "tu reserva fue
    // cancelada" a secas no le dice al cliente que lo que se dio de baja fue
    // la noche entera, así que el aviso tiene que nombrar el evento.
    jest.spyOn(SupabaseService, 'getEventTitle').mockResolvedValue('Noche de Jazz');

    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'WAITING', event_id: 'event-1' },
      new: {
        ...baseEntry,
        status: 'CANCELLED',
        event_id: 'event-1',
        scheduled_at: '2026-07-08T22:00:00.000Z',
      },
    });

    expect(SupabaseService.getEventTitle).toHaveBeenCalledWith('event-1');
    expect(sendMessageMock).toHaveBeenCalledWith(
      'business-1',
      expect.any(String),
      expect.stringContaining('El evento *Noche de Jazz* fue cancelado')
    );
  });

  it('falls back to the plain cancellation notice when the event title is gone', async () => {
    jest.spyOn(SupabaseService, 'getEventTitle').mockResolvedValue(null);

    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'WAITING', event_id: 'event-1' },
      new: { ...baseEntry, status: 'CANCELLED', event_id: 'event-1' },
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      'business-1',
      expect.any(String),
      expect.stringContaining('Tu reserva fue cancelada por el restaurante')
    );
  });

  it('stays silent on a cancellation the customer already got an answer for', async () => {
    // El handler de WhatsApp marca la clave ANTES de escribir en la DB cuando
    // quien cancela es el cliente. Sin esto recibiría un segundo mensaje
    // diciéndole que la canceló el restaurante.
    redisGetMock.mockImplementation((key: string) =>
      Promise.resolve(key === 'wa:status:sent:entry-1:CANCELLED' ? '1' : null)
    );

    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED' },
      new: { ...baseEntry, status: 'CANCELLED' },
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does nothing when the status is unrelated to the notifiable ones', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED' },
      new: { ...baseEntry, status: 'NO_SHOW' },
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('ignores non-UPDATE events entirely', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'INSERT',
      old: null,
      new: { ...baseEntry, status: 'CONFIRMED' },
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not message the customer when seating them', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED' },
      new: { ...baseEntry, status: 'SEATED' },
    });

    // La persona ya está en el local: un WhatsApp de bienvenida sólo le suena
    // el teléfono en la mesa.
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not act again when the SEATED status is unchanged', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'SEATED' },
      new: { ...baseEntry, status: 'SEATED' },
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('RealtimeSyncService.handleBusinessChange', () => {
  let redisGetMock: jest.Mock;
  let redisSetExMock: jest.Mock;
  let redisDelMock: jest.Mock;
  let hasSessionMock: jest.Mock;
  let stopSessionMock: jest.Mock;

  beforeEach(() => {
    jest.restoreAllMocks();

    redisGetMock = jest.fn().mockResolvedValue(null);
    redisSetExMock = jest.fn().mockResolvedValue('OK');
    redisDelMock = jest.fn().mockResolvedValue(1);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: redisGetMock,
      setEx: redisSetExMock,
      del: redisDelMock,
    } as any);

    hasSessionMock = jest.fn().mockReturnValue(true);
    stopSessionMock = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(BaileysService, 'getInstance').mockReturnValue({
      hasSession: hasSessionMock,
      stopSession: stopSessionMock,
    } as any);
  });

  it('closes the WhatsApp session when weekly_hours transitions to null', async () => {
    await (RealtimeSyncService as any).handleBusinessChange({
      eventType: 'UPDATE',
      old: { id: 'business-1', weekly_hours: { mon: [] } },
      new: { id: 'business-1', weekly_hours: null },
    });

    expect(hasSessionMock).toHaveBeenCalledWith('business-1');
    expect(stopSessionMock).toHaveBeenCalledWith('business-1');
  });

  it('leaves the session running when weekly_hours is configured', async () => {
    await (RealtimeSyncService as any).handleBusinessChange({
      eventType: 'UPDATE',
      old: { id: 'business-1', weekly_hours: null },
      new: { id: 'business-1', weekly_hours: { mon: [] } },
    });

    expect(stopSessionMock).not.toHaveBeenCalled();
  });

  it('does not call stopSession when there is no active session to close', async () => {
    hasSessionMock.mockReturnValue(false);

    await (RealtimeSyncService as any).handleBusinessChange({
      eventType: 'UPDATE',
      old: { id: 'business-1', weekly_hours: { mon: [] } },
      new: { id: 'business-1', weekly_hours: null },
    });

    expect(stopSessionMock).not.toHaveBeenCalled();
  });

  it('closes the session on INSERT when the business already has weekly_hours null', async () => {
    await (RealtimeSyncService as any).handleBusinessChange({
      eventType: 'INSERT',
      old: null,
      new: { id: 'business-2', weekly_hours: null },
    });

    expect(hasSessionMock).toHaveBeenCalledWith('business-2');
    expect(stopSessionMock).toHaveBeenCalledWith('business-2');
  });
});
