import { BaileysService } from '../../services/baileys.service.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { RedisConfig } from '../../config/redis.js';
import { logEvent } from '../../utils/logger.js';

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

function incoming(message: object, key: object = {}, extra: object = {}) {
  return {
    key: { remoteJid: CUSTOMER_JID, id: `id-${Math.random()}`, fromMe: false, ...key },
    message,
    messageTimestamp: 1_790_000_000,
    ...extra,
  };
}

/** `messageTimestamp` (segundos) de un mensaje enviado hace `ms`. */
function sentAgo(ms: number) {
  return { messageTimestamp: Math.floor((Date.now() - ms) / 1000) };
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

  /** Lo que Baileys entrega al reconectar: lo que llegó mientras la sesión estaba caída. */
  function receiveAppend(...messages: object[]) {
    return service.handleIncomingMessages(BUSINESS_ID, { type: 'append', messages });
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.mocked(logEvent).mockClear();
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

  it('un audio del cliente se anota y le llega al handler marcado como audio, sin texto', async () => {
    await receive(incoming({ audioMessage: { seconds: 12, ptt: true } }));

    expect(handler.onCustomerMessage).toHaveBeenCalledTimes(1);
    expect(handler.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: '', media: 'audio', fromMe: false })
    );
  });

  it('un sticker del cliente no se contesta, pero queda en el log', async () => {
    await receive(incoming({ stickerMessage: {} }));

    expect(handler.processMessage).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'info',
      'msg.dropped',
      expect.objectContaining({ reason: 'unsupported_media', mediaType: 'stickerMessage' })
    );
  });

  it.each([
    ['el epígrafe de una foto', { imageMessage: { caption: 'quiero esta mesa' } }, 'quiero esta mesa'],
    ['el epígrafe de un video', { videoMessage: { caption: '¿hay lugar?' } }, '¿hay lugar?'],
    [
      'un mensaje temporal',
      { ephemeralMessage: { message: { extendedTextMessage: { text: 'reserva para 2' } } } },
      'reserva para 2',
    ],
    [
      'una foto de "ver una vez" con epígrafe',
      { viewOnceMessageV2: { message: { imageMessage: { caption: 'para hoy' } } } },
      'para hoy',
    ],
  ])('%s llega como texto', async (_label, content, text) => {
    await receive(incoming(content));

    expect(handler.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: text, fromMe: false })
    );
  });

  it('una edición no se contesta como si fuera un mensaje nuevo', async () => {
    await receive(incoming({ editedMessage: { message: { conversation: 'mejor para 3' } } }));

    expect(handler.processMessage).not.toHaveBeenCalled();
  });

  it('los canales no se contestan', async () => {
    await receive(incoming({ conversation: 'novedades' }, { remoteJid: '120363000000@newsletter' }));

    expect(handler.onCustomerMessage).not.toHaveBeenCalled();
    expect(handler.processMessage).not.toHaveBeenCalled();
  });

  describe('remitentes que WhatsApp identifica sólo por LID', () => {
    const LID_JID = '150856548802685@lid';

    function withLidMapping(pn: string | null) {
      service.sessions = new Map([
        [BUSINESS_ID, { signalRepository: { lidMapping: { getPNForLID: jest.fn(async () => pn) } } }],
      ]);
    }

    it('con el mapeo guardado en la sesión, se usa su teléfono real', async () => {
      withLidMapping('5493757323741:0@s.whatsapp.net');

      await receive(incoming({ conversation: 'hola' }, { remoteJid: LID_JID }));

      expect(handler.onCustomerMessage).toHaveBeenCalledWith(BUSINESS_ID, CUSTOMER_JID, expect.any(Number));
      expect(handler.processMessage).toHaveBeenCalledWith(expect.objectContaining({ from: CUSTOMER_JID }));
    });

    it('sin mapeo, queda el LID como antes', async () => {
      withLidMapping(null);

      await receive(incoming({ conversation: 'hola' }, { remoteJid: LID_JID }));

      expect(handler.processMessage).toHaveBeenCalledWith(expect.objectContaining({ from: LID_JID }));
    });

    it('si viene el teléfono alternativo, no hace falta buscar nada', async () => {
      withLidMapping('5490000000000:0@s.whatsapp.net');

      await receive(incoming({ conversation: 'hola' }, { remoteJid: LID_JID, remoteJidAlt: CUSTOMER_JID }));

      expect(handler.processMessage).toHaveBeenCalledWith(expect.objectContaining({ from: CUSTOMER_JID }));
    });
  });

  describe('lo que llegó mientras la sesión estaba caída (append)', () => {
    it('lo que escribió un cliente durante el corte se contesta', async () => {
      await receiveAppend(incoming({ conversation: 'hola, ¿tienen mesa?' }, {}, sentAgo(2 * 60_000)));

      expect(handler.onCustomerMessage).toHaveBeenCalledTimes(1);
      expect(handler.processMessage).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'hola, ¿tienen mesa?', fromMe: false })
      );
    });

    it('con más de 15 minutos no se contesta, pero queda en el log', async () => {
      await receiveAppend(incoming({ conversation: 'hola' }, {}, sentAgo(20 * 60_000)));

      expect(handler.processMessage).not.toHaveBeenCalled();
      expect(logEvent).toHaveBeenCalledWith(
        'info',
        'msg.dropped',
        expect.objectContaining({ reason: 'stale_offline', businessId: BUSINESS_ID })
      );
    });

    it('el eco de lo que acaba de mandar el bot no cuenta como la persona', async () => {
      // Baileys emite cada envío propio como `append`, en el mismo instante y a
      // veces antes de que el guard de eco lo conozca. En un número compartido,
      // tomarlo como "escribió la persona" silenciaría el chat.
      await receiveAppend(incoming({ conversation: '¿Para cuántas personas?' }, { fromMe: true }, sentAgo(0)));

      expect(handler.processMessage).not.toHaveBeenCalled();
      expect(handler.processOwnMessage).not.toHaveBeenCalled();
    });

    it('lo que escribió la persona desde el celular durante el corte sí cuenta', async () => {
      await receiveAppend(incoming({ conversation: 'Hola! Sí, vení' }, { fromMe: true }, sentAgo(5 * 60_000)));

      expect(handler.processMessage).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Hola! Sí, vení', fromMe: true })
      );
    });

    it('los canales no se contestan', async () => {
      await receiveAppend(
        incoming({ conversation: 'novedades' }, { remoteJid: '120363000000@newsletter' }, sentAgo(0))
      );

      expect(handler.processMessage).not.toHaveBeenCalled();
    });

    it('cualquier otro tipo de evento se ignora como siempre', async () => {
      await service.handleIncomingMessages(BUSINESS_ID, {
        type: 'history',
        messages: [incoming({ conversation: 'hola' }, {}, sentAgo(0))],
      });

      expect(handler.processMessage).not.toHaveBeenCalled();
    });
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

  describe('enviar con la sesión reconectando', () => {
    const sock = { sendMessage: jest.fn() };

    beforeEach(() => {
      jest.useFakeTimers();
      service.sessions = new Map();
      service.sessionStates = new Map();
      service.reconnectAttempts = new Map();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function reconnect() {
      service.sessions.set(BUSINESS_ID, sock);
      service.sessionStates.set(BUSINESS_ID, { isConnected: true });
      service.reconnectAttempts.delete(BUSINESS_ID);
    }

    it('con la sesión conectada, envía enseguida', async () => {
      reconnect();

      await expect(service.connectedSocket(BUSINESS_ID)).resolves.toEqual({ sock });
    });

    it('si el corte es reciente, espera a que vuelva en vez de perder el mensaje', async () => {
      service.reconnectAttempts.set(BUSINESS_ID, 1);

      const pending = service.connectedSocket(BUSINESS_ID);
      await jest.advanceTimersByTimeAsync(3_000);
      reconnect();
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({ sock });
    });

    it('si no vuelve en dos minutos, se da por fallido', async () => {
      service.reconnectAttempts.set(BUSINESS_ID, 1);

      const pending = service.connectedSocket(BUSINESS_ID);
      await jest.advanceTimersByTimeAsync(2 * 60_000 + 1_000);

      await expect(pending).resolves.toEqual({ reason: 'no_session' });
    });

    it('si la sesión se da por irrecuperable mientras espera, corta ahí', async () => {
      service.reconnectAttempts.set(BUSINESS_ID, 2);

      const pending = service.connectedSocket(BUSINESS_ID);
      service.reconnectAttempts.delete(BUSINESS_ID);
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({ reason: 'no_session' });
    });

    it.each([
      ['sin sesión ni reconexión (nunca vinculado)', 0],
      ['con la sesión rota hace varios intentos', 9],
    ])('%s falla enseguida, sin trabar el envío', async (_label, attempts) => {
      if (attempts) service.reconnectAttempts.set(BUSINESS_ID, attempts);

      await expect(service.connectedSocket(BUSINESS_ID)).resolves.toEqual({ reason: 'no_session' });
    });
  });
});
