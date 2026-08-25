import { RealtimeSyncService } from '../../services/realtime-sync.service.js';
import { RedisConfig } from '../../config/redis.js';
import { SupabaseConfig } from '../../config/supabase.js';
import { BaileysService } from '../../services/baileys.service.js';
import { PostVisitService } from '../../services/post-visit.service.js';

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
      expect.stringContaining('¡Tu reserva está CONFIRMADA!')
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

  it('still notifies on a genuine CONFIRMED -> NOTIFIED transition', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED' },
      new: { ...baseEntry, status: 'NOTIFIED' },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'business-1',
      expect.any(String),
      expect.stringContaining('¡Es tu momento!')
    );
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

  it('M11: sends the welcome-at-restaurant message on a WAITING -> SEATED transition and schedules M12', async () => {
    const schedulePostVisitSpy = jest
      .spyOn(PostVisitService, 'schedulePostVisit')
      .mockResolvedValue(undefined);

    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'CONFIRMED' },
      new: { ...baseEntry, status: 'SEATED' },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'business-1',
      expect.any(String),
      expect.stringContaining('Tu mesa ya está lista')
    );
    expect(schedulePostVisitSpy).toHaveBeenCalledWith('entry-1', 'business-1');
  });

  it('M11: does not re-send the welcome when the SEATED status is unchanged', async () => {
    jest.spyOn(PostVisitService, 'schedulePostVisit').mockResolvedValue(undefined);

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
