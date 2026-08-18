import { PostVisitService } from '../../services/post-visit.service.js';
import { RedisConfig } from '../../config/redis.js';
import { SupabaseConfig } from '../../config/supabase.js';
import { BaileysService } from '../../services/baileys.service.js';

jest.mock('../../utils/logger');

describe('PostVisitService (M12 — mensaje posterior a la visita)', () => {
  let sendMessageMock: jest.Mock;
  let redisGetMock: jest.Mock;
  let redisSetExMock: jest.Mock;
  let redisZAddMock: jest.Mock;
  let redisZRangeByScoreMock: jest.Mock;
  let redisZRemMock: jest.Mock;
  let supabaseFromMock: jest.Mock;

  const seatedEntry = {
    id: 'entry-1',
    business_id: 'business-1',
    customer_id: 'customer-1',
    status: 'SEATED',
    party_size: 4,
    display_code: 'M102',
  };
  const customerRow = { id: 'customer-1', name: 'Matías', phone: '5491112223333' };

  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.POST_VISIT_DELAY_MINUTES;

    sendMessageMock = jest.fn().mockResolvedValue(true);
    jest.spyOn(BaileysService, 'getInstance').mockReturnValue({
      sendMessage: sendMessageMock,
    } as any);

    redisGetMock = jest.fn().mockResolvedValue(null);
    redisSetExMock = jest.fn().mockResolvedValue('OK');
    redisZAddMock = jest.fn().mockResolvedValue(1);
    redisZRangeByScoreMock = jest.fn().mockResolvedValue([]);
    redisZRemMock = jest.fn().mockResolvedValue(1);

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: redisGetMock,
      setEx: redisSetExMock,
      zAdd: redisZAddMock,
      zRangeByScore: redisZRangeByScoreMock,
      zRem: redisZRemMock,
    } as any);

    // Supabase: entry lookup then customer lookup, both via .single()
    const singleMock = jest
      .fn()
      .mockResolvedValueOnce({ data: seatedEntry, error: null })
      .mockResolvedValueOnce({ data: customerRow, error: null });
    supabaseFromMock = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ single: singleMock }),
      }),
    });
    jest.spyOn(SupabaseConfig, 'getClient').mockReturnValue({
      from: supabaseFromMock,
    } as any);
  });

  it('schedulePostVisit enqueues the entry with a future due timestamp', async () => {
    const before = Date.now();
    await PostVisitService.schedulePostVisit('entry-1', 'business-1');

    expect(redisZAddMock).toHaveBeenCalledTimes(1);
    const [key, member] = redisZAddMock.mock.calls[0];
    expect(key).toBe('wa:postvisit:queue');
    expect(member.value).toBe('entry-1:business-1');
    // default delay = 120 min in the future
    expect(member.score).toBeGreaterThan(before + 100 * 60 * 1000);
  });

  it('schedulePostVisit does not enqueue when the message was already sent', async () => {
    redisGetMock.mockResolvedValueOnce('1'); // sent dedup key present
    await PostVisitService.schedulePostVisit('entry-1', 'business-1');
    expect(redisZAddMock).not.toHaveBeenCalled();
  });

  it('processDueEntries sends M12 for a due, still-SEATED entry and dedups it', async () => {
    redisZRangeByScoreMock.mockResolvedValueOnce(['entry-1:business-1']);

    await PostVisitService.processDueEntries();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'business-1',
      expect.any(String),
      expect.stringContaining('Gracias por visitarnos')
    );
    expect(redisSetExMock).toHaveBeenCalledWith('wa:postvisit:sent:entry-1', expect.any(Number), '1');
    expect(redisZRemMock).toHaveBeenCalledWith('wa:postvisit:queue', 'entry-1:business-1');
  });

  it('processDueEntries does NOT send when the entry is no longer SEATED', async () => {
    redisZRangeByScoreMock.mockResolvedValueOnce(['entry-1:business-1']);
    // Override the entry lookup to a cancelled reservation
    const singleMock = jest
      .fn()
      .mockResolvedValueOnce({ data: { ...seatedEntry, status: 'CANCELLED' }, error: null });
    supabaseFromMock.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ single: singleMock }),
      }),
    });

    await PostVisitService.processDueEntries();

    expect(sendMessageMock).not.toHaveBeenCalled();
    // still removed from the queue so it is not retried forever
    expect(redisZRemMock).toHaveBeenCalledWith('wa:postvisit:queue', 'entry-1:business-1');
  });

  it('processDueEntries skips an entry whose message was already sent', async () => {
    redisZRangeByScoreMock.mockResolvedValueOnce(['entry-1:business-1']);
    redisGetMock.mockResolvedValueOnce('1'); // dedup key present

    await PostVisitService.processDueEntries();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(redisZRemMock).toHaveBeenCalledWith('wa:postvisit:queue', 'entry-1:business-1');
  });
});
