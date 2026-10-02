import { SupabaseService } from '../../services/supabase.service.js';

jest.mock('../../utils/logger');

/**
 * El interruptor del chat con IA de cada comercio. Lo que no se puede romper:
 * un local que apagó el bot no lo ve contestar porque Supabase falló.
 */
describe('SupabaseService.isBusinessAiChatEnabled', () => {
  const BUSINESS_ID = 'biz-ai-flag';
  let response: { data: unknown; error: unknown };

  beforeEach(() => {
    jest.restoreAllMocks();
    (SupabaseService as any).aiChatEnabledByBusiness.clear();

    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => response,
    };
    jest.spyOn(SupabaseService as any, 'getClient').mockReturnValue({ from: () => query });
  });

  it('devuelve lo que dice la base', async () => {
    response = { data: { ai_chat_enabled: false }, error: null };
    expect(await SupabaseService.isBusinessAiChatEnabled(BUSINESS_ID)).toBe(false);

    response = { data: { ai_chat_enabled: true }, error: null };
    expect(await SupabaseService.isBusinessAiChatEnabled(BUSINESS_ID)).toBe(true);
  });

  it('sin el dato (o sin el comercio) queda prendido, como siempre', async () => {
    response = { data: { ai_chat_enabled: null }, error: null };
    expect(await SupabaseService.isBusinessAiChatEnabled(BUSINESS_ID)).toBe(true);

    response = { data: null, error: null };
    expect(await SupabaseService.isBusinessAiChatEnabled(BUSINESS_ID)).toBe(true);
  });

  it('si Supabase falla, un bot apagado sigue apagado', async () => {
    response = { data: { ai_chat_enabled: false }, error: null };
    await SupabaseService.isBusinessAiChatEnabled(BUSINESS_ID);

    response = { data: null, error: { message: 'connection reset' } };
    expect(await SupabaseService.isBusinessAiChatEnabled(BUSINESS_ID)).toBe(false);
  });

  it('si Supabase falla y nunca se leyó, queda prendido', async () => {
    response = { data: null, error: { message: 'connection reset' } };
    expect(await SupabaseService.isBusinessAiChatEnabled(BUSINESS_ID)).toBe(true);
  });
});
