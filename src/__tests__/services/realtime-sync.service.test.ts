import { RealtimeSyncService } from '../../services/realtime-sync.service';
import { RedisConfig } from '../../config/redis';
import { SupabaseConfig } from '../../config/supabase';
import { BaileysService } from '../../services/baileys.service';
import { PostVisitService } from '../../services/post-visit.service';

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

  it('does nothing when the status is unrelated to CONFIRMED/NOTIFIED', async () => {
    await (RealtimeSyncService as any).handleWaitlistStatusChange({
      eventType: 'UPDATE',
      old: { ...baseEntry, status: 'WAITING' },
      new: { ...baseEntry, status: 'CANCELLED' },
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
