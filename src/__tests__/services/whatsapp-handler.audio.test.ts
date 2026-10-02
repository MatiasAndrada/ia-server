import { WhatsAppHandler } from '../../services/whatsapp-handler.service.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { RedisConfig } from '../../config/redis.js';
import * as orchestrator from '../../agent/orchestrator.js';
import * as state from '../../agent/state.js';
import { BaileysMessage } from '../../types/index.js';

jest.mock('../../utils/logger');

/**
 * Un audio del cliente. El bot no lo puede escuchar, y antes ni siquiera se
 * enteraba de que había llegado: el cliente quedaba esperando una respuesta
 * que nunca iba a venir.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-0000000000dd';
const PHONE = '5491155558888';
const JID = `${PHONE}@s.whatsapp.net`;
const CONVERSATION_ID = `${BUSINESS_ID}-${PHONE}`;

const AUDIO_REPLY = 'Todavía no puedo escuchar audios. ¿Me lo escribís, por favor?';

function message(overrides: Partial<BaileysMessage>): BaileysMessage {
  return {
    from: JID,
    message: '',
    timestamp: Date.now(),
    businessId: BUSINESS_ID,
    messageId: `in-${Math.random()}`,
    fromMe: false,
    ...overrides,
  };
}

const audio = () => message({ media: 'audio' });

describe('WhatsAppHandler — audios del cliente', () => {
  let sent: string[];
  let handler: WhatsAppHandler;
  let redis: Map<string, string>;

  const stubBaileys = {
    sendMessage: jest.fn(async (_b: string, _to: string, text: string) => {
      sent.push(text);
      return true;
    }),
    sendImageMessage: jest.fn(async () => true),
    sendDocumentMessage: jest.fn(async () => true),
    getSelfJid: jest.fn(() => ''),
  };

  const internals = () =>
    handler as unknown as {
      _processMessage: (m: BaileysMessage) => Promise<void>;
      dispatchBatch: (conversationId: string, batch: BaileysMessage[]) => void;
      processingLock: Map<string, Promise<void>>;
      debounceBuffer: Map<string, unknown>;
    };

  beforeEach(() => {
    jest.restoreAllMocks();
    sent = [];
    redis = new Map();
    stubBaileys.sendMessage.mockClear();
    handler = new WhatsAppHandler(stubBaileys as any);
    delete process.env.DE_LA_FONTE_BUSINESS_ID;

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: jest.fn(async (key: string) => redis.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, options?: { NX?: boolean }) => {
        if (options?.NX && redis.has(key)) return null;
        redis.set(key, value);
        return 'OK';
      }),
      setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
        redis.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (redis.delete(key) ? 1 : 0)),
      incr: jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
    } as any);

    jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
      id: BUSINESS_ID,
      name: 'Restaurante del Centro',
      whatsapp_session_id: 'session-active',
      language: 'es',
    } as any);
    jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('es');
    jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(null);
    jest.spyOn(state, 'appendExchange').mockResolvedValue();
    // Una conversación que ya venía: sin esto, el primer contacto pasa por el
    // menú de idiomas antes que por lo que se prueba acá.
    jest.spyOn(state, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'hola' }]);
    jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue(null);
    jest.spyOn(state, 'conversationIdleMs').mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.DE_LA_FONTE_BUSINESS_ID;
  });

  it('un audio solo: se le pide que lo escriba, sin pasar por el modelo', async () => {
    const turn = jest.spyOn(orchestrator, 'handleTurn');

    await internals()._processMessage(audio());

    expect(sent).toEqual([AUDIO_REPLY]);
    expect(turn).not.toHaveBeenCalled();
    // Queda en el historial: si después escribe "lo que te dije en el audio",
    // el modelo sabe que hubo un audio.
    expect(state.appendExchange).toHaveBeenCalledWith(CONVERSATION_ID, '[audio]', AUDIO_REPLY);
  });

  it('varios audios seguidos: se le pide una sola vez', async () => {
    await internals()._processMessage(audio());
    await internals()._processMessage(audio());
    await internals()._processMessage(audio());

    expect(sent).toEqual([AUDIO_REPLY]);
  });

  it('un audio junto con texto: contesta el modelo, y sabe que hubo un audio', async () => {
    const turn = jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
      messages: ['respuesta del bot'],
      attachments: [],
      toolsCalled: [],
      iterations: 1,
    });

    internals().dispatchBatch(CONVERSATION_ID, [
      audio(),
      message({ message: 'quiero reservar para 4 mañana' }),
    ]);
    await internals().processingLock.get(CONVERSATION_ID);

    expect(sent).toEqual(['respuesta del bot']);
    const { messageText } = turn.mock.calls[0]![0];
    expect(messageText).toContain('quiero reservar para 4 mañana');
    expect(messageText).toContain('mandó un audio');
  });

  it('en un número compartido, un audio queda para la persona', async () => {
    process.env.DE_LA_FONTE_BUSINESS_ID = BUSINESS_ID;

    await handler.processMessage(audio());

    expect(internals().debounceBuffer.size).toBe(0);
    expect(sent).toEqual([]);
  });
});
