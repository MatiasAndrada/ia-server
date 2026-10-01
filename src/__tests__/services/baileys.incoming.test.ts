import { BaileysService } from '../../services/baileys.service.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { RedisConfig } from '../../config/redis.js';

jest.mock('../../utils/logger');

/**
 * Qué hace BaileysService con lo que llega de WhatsApp antes de pasárselo al
 * handler. Lo que importa para los locales de número compartido:
 *
 * - la llegada de cada mensaje del cliente se anota ANTES de cualquier espera,
 *   así el saludo automático del celular nunca queda registrado primero;
 * - lo que manda la persona desde el celular llega al handler aunque sea un
 *   audio, y aunque el bot esté apagado.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-0000000000cc';
const CUSTOMER_JID = '5493757323741@s.whatsapp.net';

function incoming(message: object, key: object = {}) {
  return {
    key: { remoteJid: CUSTOMER_JID, id: `id-${Math.random()}`, fromMe: false, ...key },
    message,
    messageTimestamp: 1_790_000_000,
  };
}

describe('BaileysService — mensajes entrantes', () => {
  let service: any;
  let handler: {
    onCustomerMessage: jest.Mock;
    processMessage: jest.Mock;
    processOwnMessage: jest.Mock;
  };

  function receive(...messages: object[]) {
    return service.handleIncomingMessages(BUSINESS_ID, { type: 'notify', messages });
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.ANTIGAL_BUSINESS_ID;

    // Sin constructor: no toca los directorios de sesiones de WhatsApp.
    service = Object.create(BaileysService.prototype);
    handler = {
      onCustomerMessage: jest.fn(),
      processMessage: jest.fn(async () => undefined),
      processOwnMessage: jest.fn(async () => undefined),
    };
    service.whatsAppHandler = handler;
    service.outboundEchoGuard = new Map();

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      lPush: jest.fn(async () => 1),
      lTrim: jest.fn(async () => 'OK'),
      expire: jest.fn(async () => 1),
    } as any);
    jest.spyOn(SupabaseService, 'isBusinessAiChatEnabled').mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.ANTIGAL_BUSINESS_ID;
  });

  it('anota la llegada del cliente antes de esperar a Supabase', async () => {
    let enable!: (value: boolean) => void;
    jest
      .spyOn(SupabaseService, 'isBusinessAiChatEnabled')
      .mockReturnValue(new Promise((resolve) => (enable = resolve)));

    const pending = receive(incoming({ conversation: 'hola' }));

    // Todavía no respondió Supabase, y la llegada ya quedó anotada.
    expect(handler.onCustomerMessage).toHaveBeenCalledWith(BUSINESS_ID, CUSTOMER_JID, expect.any(Number));
    expect(handler.processMessage).not.toHaveBeenCalled();

    enable(true);
    await pending;
    expect(handler.processMessage).toHaveBeenCalledTimes(1);
  });

  it('el texto del cliente llega al handler con su hora de llegada', async () => {
    await receive(incoming({ conversation: 'quiero reservar' }));

    const [message] = handler.processMessage.mock.calls[0]!;
    expect(message).toMatchObject({ message: 'quiero reservar', fromMe: false, from: CUSTOMER_JID });
    expect(message.receivedAt).toEqual(handler.onCustomerMessage.mock.calls[0]![2]);
  });

  it('un audio del cliente se anota (dispara el saludo automático) pero no le llega al bot', async () => {
    await receive(incoming({ audioMessage: { seconds: 12 } }));

    expect(handler.onCustomerMessage).toHaveBeenCalledTimes(1);
    expect(handler.processMessage).not.toHaveBeenCalled();
  });

  it('lo que escribe la persona desde el celular llega al handler como propio', async () => {
    await receive(incoming({ conversation: 'Hola Tobi!' }, { fromMe: true }));

    expect(handler.onCustomerMessage).not.toHaveBeenCalled();
    expect(handler.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hola Tobi!', fromMe: true })
    );
  });

  it.each([
    ['un audio', { audioMessage: { seconds: 5 } }],
    ['una foto', { imageMessage: { caption: '' } }],
    ['un sticker', { stickerMessage: {} }],
  ])('%s que manda la persona también llega, sin texto', async (_label, content) => {
    await receive(incoming(content, { fromMe: true }));

    expect(handler.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: '', fromMe: true })
    );
  });

  it.each([
    ['una reacción', { reactionMessage: { text: '👍' } }],
    ['un mensaje de protocolo', { protocolMessage: { type: 14 } }],
  ])('%s de la persona no cuenta', async (_label, content) => {
    await receive(incoming(content, { fromMe: true }));

    expect(handler.processMessage).not.toHaveBeenCalled();
  });

  it('el eco de lo que mandó el propio bot se descarta', async () => {
    service.outboundEchoGuard.set(`${BUSINESS_ID}:bot-1`, Date.now() + 60_000);

    await receive(incoming({ conversation: '¿Para cuántas personas?' }, { fromMe: true, id: 'bot-1' }));

    expect(handler.processMessage).not.toHaveBeenCalled();
  });

  it('los grupos y los estados no se tocan', async () => {
    await receive(
      incoming({ conversation: 'hola grupo' }, { remoteJid: '120363000000@g.us' }),
      incoming({ conversation: 'estado' }, { remoteJid: 'status@broadcast' })
    );

    expect(handler.onCustomerMessage).not.toHaveBeenCalled();
    expect(handler.processMessage).not.toHaveBeenCalled();
  });

  describe('con el bot apagado', () => {
    beforeEach(() => {
      jest.spyOn(SupabaseService, 'isBusinessAiChatEnabled').mockResolvedValue(false);
    });

    it('en un local de número compartido sigue registrando en qué chats escribe la persona', async () => {
      process.env.ANTIGAL_BUSINESS_ID = BUSINESS_ID;

      await receive(
        incoming({ conversation: 'hola, ¿tienen mesa?' }),
        incoming({ conversation: 'Hola! Sí, vení' }, { fromMe: true }),
        incoming({ audioMessage: {} }, { fromMe: true })
      );

      // El bot no atiende nada: sólo se entera de que la persona está en ese chat.
      expect(handler.processMessage).not.toHaveBeenCalled();
      expect(handler.processOwnMessage).toHaveBeenCalledTimes(2);
      expect(handler.processOwnMessage).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Hola! Sí, vení', fromMe: true, receivedAt: expect.any(Number) })
      );
    });

    it('en cualquier otro local no hace nada, como siempre', async () => {
      await receive(
        incoming({ conversation: 'hola' }),
        incoming({ conversation: 'Hola! Sí, vení' }, { fromMe: true })
      );

      expect(handler.processMessage).not.toHaveBeenCalled();
      expect(handler.processOwnMessage).not.toHaveBeenCalled();
    });
  });
});
