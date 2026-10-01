import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppHandler } from '../../services/whatsapp-handler.service.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { openRouterService } from '../../services/openrouter.service.js';
import { RedisConfig } from '../../config/redis.js';
import * as orchestrator from '../../agent/orchestrator.js';
import * as state from '../../agent/state.js';
import { BaileysMessage, LlmToolCall } from '../../types/index.js';
import { resetHandoffStoreForTests } from '../../adaptations/handoff-store.js';
import { resetPhoneAutoRepliesForTests } from '../../adaptations/phone-auto-replies.js';
import { antigalAdaptation } from '../../adaptations/antigal.js';
import { deLaFonteAdaptation } from '../../adaptations/de-la-fonte.js';
import { laMisionAdaptation } from '../../adaptations/la-mision.js';
import { skyAdaptation } from '../../adaptations/sky.js';
import type { SharedNumberAdaptation } from '../../adaptations/index.js';

jest.mock('../../utils/logger');

/**
 * El pedido de los locales de número compartido, de punta a punta por el
 * handler de WhatsApp, para cada uno de los cuatro que tienen saludo propio:
 *
 * - "Si Simona o Valentina le mandan un mensaje a un amigo y el amigo le
 *   contesta, que no le conteste el bot."
 * - "Si alguien escribe para no hacer reserva y para hablar con la persona,
 *   que el bot ya no le conteste."
 *
 * Y lo que no se puede romper en el camino: el saludo automático de WhatsApp
 * Business del celular no cuenta como que escribió la persona, y un cliente
 * que viene a reservar sigue siendo atendido por el bot.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-0000000000aa';
const PHONE = '5491155557777';
const JID = `${PHONE}@s.whatsapp.net`;

/** El saludo real del celular de De La Fonte (los otros locales podrían tener el suyo). */
const PHONE_GREETING =
  'Hola! 👏🏻 Bienvenido/a\nEste número es compartido \nEn que te puedo ayudar?\n' +
  '👩‍🦱Hablar con Simona > escribi Simona\n🍷Reservas "De La Fonte \n' +
  '👉storied-mooncake-696950.netlify.app';

interface Case {
  adaptation: SharedNumberAdaptation;
  businessName: string;
  /** Un saludo que nombra a la persona, si su nombre es palabra de traspaso. */
  greetsThePerson: string | null;
  /** La palabra sola que le devuelve el chat al bot; null si es permanente. */
  resumeCommand: string | null;
  /** Un texto que sólo aparece en el saludo del bot de ese local. */
  welcomeMarker: string;
}

const CASES: Case[] = [
  {
    adaptation: deLaFonteAdaptation,
    businessName: 'De La Fonte',
    greetsThePerson: 'Hola Simona!!! Muy buenos días',
    resumeCommand: null,
    welcomeMarker: 'escribí *PERSONAL*',
  },
  {
    adaptation: antigalAdaptation,
    businessName: 'Antigal Parrilla Restaurante',
    greetsThePerson: 'Hola Vale! ¿cómo andás?',
    resumeCommand: 'Reservar',
    welcomeMarker: 'Hablar con Valentina',
  },
  {
    adaptation: skyAdaptation,
    businessName: 'SKY Restaurante and Bar',
    greetsThePerson: null,
    resumeCommand: 'Reserva',
    welcomeMarker: 'escribí *SKY*',
  },
  {
    adaptation: laMisionAdaptation,
    businessName: 'Restaurante La Misión',
    greetsThePerson: null,
    resumeCommand: 'LA MISIÓN',
    welcomeMarker: 'Consultas sobre el hotel',
  },
];

const OPEN_DAY = { closed: false, shifts: [{ open: '12:00', close: '23:59' }] };

describe.each(CASES)('$businessName: el bot no se mete en las charlas de la persona', (c) => {
  let sent: string[];
  let handler: WhatsAppHandler;
  let redis: Map<string, string>;
  let redisSets: Map<string, Set<string>>;
  const originalNodeEnv = process.env.NODE_ENV;

  const stubBaileys = {
    sendMessage: jest.fn(async (_b: string, _to: string, text: string) => {
      sent.push(text);
      return true;
    }),
    sendImageMessage: jest.fn(async () => true),
    sendDocumentMessage: jest.fn(async () => true),
    getSelfJid: jest.fn(() => ''),
  };

  function customer(text: string): Promise<void> {
    // Lo que hace BaileysService con cada mensaje del cliente: anotar la
    // llegada y pasarlo al flujo (acá sin el debounce, que se prueba aparte).
    handler.onCustomerMessage(BUSINESS_ID, JID, Date.now());
    return (
      handler as unknown as { _processMessage: (m: BaileysMessage) => Promise<void> }
    )._processMessage({
      from: JID,
      message: text,
      timestamp: Date.now(),
      businessId: BUSINESS_ID,
      messageId: `in-${Math.random()}`,
      fromMe: false,
    });
  }

  /** Un mensaje que sale del celular del local, `afterMs` después de ahora. */
  function own(text: string, afterMs = 60_000): Promise<void> {
    return handler.processOwnMessage({
      from: JID,
      message: text,
      timestamp: Date.now(),
      businessId: BUSINESS_ID,
      messageId: `own-${Math.random()}`,
      fromMe: true,
      receivedAt: Date.now() + afterMs,
    });
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    sent = [];
    redis = new Map();
    redisSets = new Map();
    stubBaileys.sendMessage.mockClear();
    handler = new WhatsAppHandler(stubBaileys as any);

    resetHandoffStoreForTests();
    resetPhoneAutoRepliesForTests();
    process.env.SHARED_NUMBER_HANDOFF_FILE = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'handoffs-')),
      'handoffs.jsonl'
    );
    for (const other of CASES) delete process.env[other.adaptation.businessIdEnvVar];
    process.env[c.adaptation.businessIdEnvVar] = BUSINESS_ID;

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: jest.fn(async (key: string) => redis.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        redis.set(key, value);
        return 'OK';
      }),
      setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
        redis.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (redis.delete(key) ? 1 : 0)),
      incr: jest.fn(async (key: string) => {
        const next = Number(redis.get(key) ?? 0) + 1;
        redis.set(key, String(next));
        return next;
      }),
      expire: jest.fn(async () => 1),
      sAdd: jest.fn(async (key: string, member: string) => {
        const set = redisSets.get(key) ?? new Set<string>();
        set.add(member);
        redisSets.set(key, set);
        return 1;
      }),
      sIsMember: jest.fn(async (key: string, member: string) =>
        redisSets.get(key)?.has(member) ? 1 : 0
      ),
    } as any);

    jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
      id: BUSINESS_ID,
      name: c.businessName,
      whatsapp_session_id: 'session-active',
      language: 'es',
      weekly_hours: {
        mon: OPEN_DAY, tue: OPEN_DAY, wed: OPEN_DAY, thu: OPEN_DAY,
        fri: OPEN_DAY, sat: OPEN_DAY, sun: OPEN_DAY,
      },
      reservation_closing_margin_minutes: 15,
      reservation_opening_margin_minutes: 0,
      address: 'Av. Siempreviva 742',
      city: 'Posadas',
    } as any);
    jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('es');
    jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(null);
    jest.spyOn(SupabaseService, 'getActiveReservationsByPhone').mockResolvedValue([]);
    jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([]);
    jest.spyOn(SupabaseService, 'getBlockedDates').mockResolvedValue(new Map());
    jest.spyOn(state, 'appendExchange').mockResolvedValue();
    jest.spyOn(state, 'loadHistory').mockResolvedValue([]);
    jest.spyOn(state, 'saveHistory').mockResolvedValue();
    jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue(null);
    jest.spyOn(state, 'conversationIdleMs').mockResolvedValue(null);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.SHARED_NUMBER_HANDOFF_FILE;
    delete process.env[c.adaptation.businessIdEnvVar];
  });

  /** El modelo contesta siempre esto; si aparece en `sent`, habló el bot. */
  function botWouldSay(text = 'respuesta del bot') {
    return jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
      messages: [text],
      attachments: [],
      toolsCalled: [],
      iterations: 1,
    });
  }

  describe('la persona le escribe a alguien y ese alguien le contesta', () => {
    it('el bot no contesta nada: ni la respuesta, ni un "hola" después', async () => {
      const turn = botWouldSay();

      await own('Hola! ¿Cómo andás? ¿Vamos el sábado?');
      await customer('Todo bien! Sí, vamos 🙌');
      await customer('hola');
      await customer('¿tenés mesa para el sábado?');

      expect(sent).toEqual([]);
      expect(turn).not.toHaveBeenCalled();
    });

    it('si el otro escribió primero, desde que ella contesta el bot ya no aparece', async () => {
      const turn = botWouldSay('primera respuesta del bot');
      await customer('holaa todo bien? mañana voy a tu casa');
      expect(sent).toEqual(['primera respuesta del bot']);

      await own('Hola Tobi! Recién veo tu mensaje');
      await customer('👍🏻👍🏻👍🏻');
      await customer('dale, nos vemos');

      expect(sent).toEqual(['primera respuesta del bot']);
      expect(turn).toHaveBeenCalledTimes(1);
    });

    it('un audio o una foto que manda ella también cuenta', async () => {
      botWouldSay();

      await own(''); // el mensaje propio sin texto de un audio
      await customer('jajaja buenísimo');

      expect(sent).toEqual([]);
    });

    it('lo que se habla después no entra al historial del bot', async () => {
      await own('Te paso las facturas pendientes');
      const append = jest.spyOn(state, 'appendExchange').mockResolvedValue();

      await customer('Gracias! ahí las veo');

      expect(append).not.toHaveBeenCalled();
    });

    it('el silencio es de ese chat: otro cliente sigue siendo atendido', async () => {
      const turn = botWouldSay('¿Para cuántas personas?');
      await own('Hola! ¿Cómo andás?');

      const otherJid = '5491166660000@s.whatsapp.net';
      handler.onCustomerMessage(BUSINESS_ID, otherJid, Date.now());
      await (handler as any)._processMessage({
        from: otherJid,
        message: 'quiero reservar una mesa para mañana',
        timestamp: Date.now(),
        businessId: BUSINESS_ID,
        fromMe: false,
      });

      expect(turn).toHaveBeenCalledTimes(1);
      expect(sent).toEqual(['¿Para cuántas personas?']);
    });

    if (c.resumeCommand) {
      it(`"${c.resumeCommand}" solo le devuelve el chat al bot`, async () => {
        const turn = botWouldSay('¿Para qué día?');
        await own('Hola! Sí, tenemos lugar');

        await customer('quiero reservar para 4'); // en la charla con ella: es para ella
        expect(turn).not.toHaveBeenCalled();

        await customer(c.resumeCommand!);
        expect(turn).toHaveBeenCalledTimes(1);
        expect(sent).toEqual(['¿Para qué día?']);
      });
    } else {
      it('nada lo reactiva: ese chat es de Simona para siempre', async () => {
        const turn = botWouldSay();
        await own('Hola! ¿Cómo andás?');

        for (const text of ['Reservar', 'RESERVAR', 'Cancelar', 'quiero reservar una mesa']) {
          await customer(text);
        }

        expect(turn).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
      });
    }

    it('si ella contesta mientras el modelo piensa, la respuesta del bot no sale', async () => {
      jest.spyOn(orchestrator, 'handleTurn').mockImplementation(async () => {
        // La persona responde desde el celular mientras el modelo genera.
        await own('Hola! Ya te respondo yo');
        return { messages: ['respuesta tardía del bot'], attachments: [], toolsCalled: [], iterations: 1 };
      });

      await customer('buenas, una consulta');

      expect(sent).toEqual([]);
    });
  });

  describe('el saludo automático de WhatsApp Business del celular', () => {
    it('NO cuenta como que escribió la persona: el bot sigue atendiendo al cliente', async () => {
      const turn = botWouldSay('¡Perfecto! ¿Para cuántas personas?');

      handler.onCustomerMessage(BUSINESS_ID, JID, Date.now());
      await own(PHONE_GREETING, 1_200); // llega 1,2 s después del cliente
      await customer('quiero reservar una mesa para mañana');

      expect(turn).toHaveBeenCalledTimes(1);
      expect(sent).toEqual(['¡Perfecto! ¿Para cuántas personas?']);
    });

    it('a un "hola" le sigue llegando el saludo del bot', async () => {
      handler.onCustomerMessage(BUSINESS_ID, JID, Date.now());
      await own(PHONE_GREETING, 900);
      await customer('hola');

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(c.welcomeMarker);
    });

    it('ni siquiera cuando el celular lo manda tarde, si ya se lo vio antes', async () => {
      const turn = botWouldSay('¿Para cuántas personas?');
      // Un cliente anterior: el saludo llegó enseguida y quedó reconocido.
      handler.onCustomerMessage(BUSINESS_ID, '5491100001111@s.whatsapp.net', Date.now());
      await handler.processOwnMessage({
        from: '5491100001111@s.whatsapp.net',
        message: PHONE_GREETING,
        timestamp: Date.now(),
        businessId: BUSINESS_ID,
        fromMe: true,
        receivedAt: Date.now() + 1_000,
      });

      // Este cliente: el celular estaba sin conexión y el saludo sale 10 minutos tarde.
      await own(PHONE_GREETING, 10 * 60_000);
      await customer('quiero reservar para el viernes');

      expect(turn).toHaveBeenCalledTimes(1);
    });
  });

  describe('alguien que no viene a reservar', () => {
    if (c.greetsThePerson) {
      it(`"${c.greetsThePerson}": el bot no dice nada, ni ahora ni después`, async () => {
        const turn = botWouldSay();

        await customer(c.greetsThePerson!);
        await customer('te quería comentar una cosa');

        expect(sent).toEqual([]);
        expect(turn).not.toHaveBeenCalled();
      });
    }

    it.each(['👍🏻👍🏻👍🏻', '❤️', '🤭', '?'])(
      '"%s" suelto, sin conversación con el bot: no dice nada ni llama al modelo',
      async (text) => {
        const turn = botWouldSay('¡Hola! Soy el asistente de reservas.');

        await customer(text);

        expect(turn).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
      }
    );

    it('dentro de una conversación con el bot, un 👍 sí lo lee el modelo ("sí, confirmá")', async () => {
      jest.spyOn(state, 'loadHistory').mockResolvedValue([
        { role: 'user', content: 'mesa para 4 hoy a las 21' },
        { role: 'assistant', content: '¿Confirmo la reserva para 4 hoy a las 21?' },
      ]);
      jest.spyOn(state, 'conversationIdleMs').mockResolvedValue(30_000);
      const turn = botWouldSay('Listo, reserva confirmada.');

      await customer('👍🏻');

      expect(turn).toHaveBeenCalledTimes(1);
      expect(sent).toEqual(['Listo, reserva confirmada.']);
    });

    it('si el modelo lo deriva, no sale nada — aunque el modelo haya escrito algo', async () => {
      const loop = jest
        .spyOn(openRouterService, 'runToolLoop')
        .mockImplementation(async (_m, _system, _tools, executor) => {
          const call: LlmToolCall = {
            id: 'c1',
            type: 'function',
            function: { name: 'hand_off_to_human', arguments: '{"reason":"personal"}' },
          };
          const output = await executor(call);
          return {
            content: 'Te paso con la persona del local 😊',
            executedToolCalls: [{ name: 'hand_off_to_human', arguments: '{}', output }],
            messages: [],
            model: 'm',
            iterations: 2,
            exhausted: false,
          };
        });

      await customer('holaa todo bien? mañana voy a tu casa y vemos eso');
      expect(sent).toEqual([]);

      // El modelo tuvo el contexto del local y la herramienta.
      const [, systemPrompt, tools] = loop.mock.calls[0]!;
      expect(systemPrompt).toContain(c.adaptation.humanContext);
      expect(tools.map((t) => t.function.name)).toContain('hand_off_to_human');

      // Y lo que sigue ya no llega ni al modelo.
      await customer('¿y? ¿venís?');
      expect(loop).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([]);
    });
  });

  describe('un cliente que viene a reservar', () => {
    it('lo sigue atendiendo el bot, con el contexto del local', async () => {
      const turn = botWouldSay('¡Genial! ¿Para cuántas personas?');

      await customer('Hola, quiero reservar una mesa para mañana a las 21');

      expect(turn).toHaveBeenCalledWith(
        expect.objectContaining({ humanContext: c.adaptation.humanContext })
      );
      expect(sent).toEqual(['¡Genial! ¿Para cuántas personas?']);
    });
  });

  describe('en producción, por la entrada real (con debounce)', () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('el saludo automático no se mezcla con lo que escribió el cliente', async () => {
      const turn = botWouldSay('¿Para cuántas personas?');

      handler.onCustomerMessage(BUSINESS_ID, JID, Date.now());
      await handler.processMessage({
        from: JID,
        message: 'Hola buenas tardes, quiero reservar',
        timestamp: Date.now(),
        businessId: BUSINESS_ID,
        fromMe: false,
      });
      await wait(300);
      await handler.processMessage({
        from: JID,
        message: PHONE_GREETING,
        timestamp: Date.now(),
        businessId: BUSINESS_ID,
        fromMe: true,
        receivedAt: Date.now(),
      });
      await wait(1_800);

      // Antes el lote era "Hola buenas tardes...\nHola! 👏🏻 Bienvenido/a ... escribi
      // Simona", y en De La Fonte eso canalizaba a un cliente que quería reservar.
      expect(turn).toHaveBeenCalledTimes(1);
      expect(turn.mock.calls[0]![0].messageText).toBe('Hola buenas tardes, quiero reservar');
      expect(sent).toEqual(['¿Para cuántas personas?']);
    });

    it('un mensaje de la persona nunca entra al flujo del bot', async () => {
      const turn = botWouldSay();

      await handler.processMessage({
        from: JID,
        message: 'Hola! ¿Cómo andás?',
        timestamp: Date.now(),
        businessId: BUSINESS_ID,
        fromMe: true,
        receivedAt: Date.now(),
      });
      await wait(1_700);

      expect(turn).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });
  });
});

describe('un local sin número compartido', () => {
  it('los mensajes propios se ignoran como siempre y el bot sigue atendiendo', async () => {
    jest.restoreAllMocks();
    const sent: string[] = [];
    const handler = new WhatsAppHandler({
      sendMessage: jest.fn(async (_b: string, _to: string, text: string) => {
        sent.push(text);
        return true;
      }),
    } as any);
    for (const c of CASES) delete process.env[c.adaptation.businessIdEnvVar];

    const register = jest.spyOn(
      await import('../../adaptations/shared-number.js'),
      'registerHumanReply'
    );
    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);
    jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
      id: BUSINESS_ID,
      name: 'La Parrilla',
      whatsapp_session_id: 'session-active',
      language: 'es',
    } as any);
    jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('es');
    jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue({
      id: 'c1',
      name: 'Matías',
      preferred_language: 'es',
    } as any);
    jest.spyOn(state, 'loadHistory').mockResolvedValue([{ role: 'assistant', content: 'hola' }]);
    jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue(null);
    jest.spyOn(state, 'conversationIdleMs').mockResolvedValue(1000);
    const turn = jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
      messages: ['¿Para cuántas personas?'],
      attachments: [],
      toolsCalled: [],
      iterations: 1,
    });

    await handler.processOwnMessage({
      from: JID,
      message: 'Hola! te escribo del local',
      timestamp: Date.now(),
      businessId: BUSINESS_ID,
      fromMe: true,
    });
    await (handler as any)._processMessage({
      from: JID,
      message: 'quiero reservar para mañana',
      timestamp: Date.now(),
      businessId: BUSINESS_ID,
      fromMe: false,
    });

    expect(register).not.toHaveBeenCalled();
    expect(turn).toHaveBeenCalledWith(expect.objectContaining({ humanContext: undefined }));
    expect(sent).toEqual(['¿Para cuántas personas?']);
  });
});
